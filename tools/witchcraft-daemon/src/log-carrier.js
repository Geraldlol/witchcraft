import fsNative from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { BindingReceiver, crc32Ascii, decodeBase32, encodeBase32, fixedHex, heartbeatShape, hex } from './binding-carrier.js';

// The game writes each C_Log.LogMessage call to Logs/General.log as one line. A frame line carries
// the binding frame's fields without part and count: every message is one line. The rest of the
// file is the client's own log (connection and account-data lines); it is skipped unread.
const ZERO = '00000000';
const MAX_PAYLOAD_BYTES = 610;
// A frame line is under 1,200 characters; anything longer is never kept.
const MAX_LINE_BYTES = 8192;
// An unterminated tail longer than any frame line is never kept: a 29-character line start, frame text
// of at most 1,029 characters and an optional \r make 1,059 bytes, rounded up.
const MAX_FRAME_LINE_BYTES = 1100;
// A region the client never wrote reads as NUL bytes, and a log line never holds one. A file that grew more
// than this past the size seen at a NUL byte that is still NUL was truncated under a running client.
const HOLE_SLACK_BYTES = 256 * 1024;
// The head mark: the file's first bytes, which tell a rewritten file from the one being read.
const HEAD_MARK_BYTES = 64;
// UI sessions remembered for the bytes read past a hole.
const TAIL_UI_LIMIT = 32;

// A read that comes back short is read on; fewer bytes than asked for means the file ends there.
async function readAt(handle, length, position) {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return buffer.subarray(0, filled);
}

function beforeNul(bytes) {
  const nul = bytes.indexOf(0);
  return nul === -1 ? bytes : bytes.subarray(0, nul);
}
// The frame text after its WCL1_ tag: seven fields joined by _, each a run of one class within its widths.
const FRAME_FIELDS = [['[0-9A-F]', 8, 8], ['[0-9A-F]', 8, 8], ['[0-9A-F]', 8, 8], ['[0-9A-F]', 4, 4], ['[0-9A-F]', 6, 6],
  ['[A-Z2-7]', 2, 976], ['[0-9A-F]', 8, 8]].map(([cls, min, max]) => ({ cls, min, max, char: new RegExp(`^${cls}$`, 'u') }));
const FRAME_RE = new RegExp(`^WCL1_${FRAME_FIELDS.map(({ cls, min, max }) => `(${cls}{${min},${max}})`).join('_')}$`, 'u');
const LINE_RE = /^\d{1,2}\/\d{1,2} \d{2}:\d{2}:\d{2}\.\d{3} {2}\[N\]\[Lua\] (WCL1_[0-9A-Z_]+)\r?$/u;
// The line start up to the frame tag for each stamp width (D is any digit).
const LINE_STARTS = ['D/D', 'DD/D', 'D/DD', 'DD/DD'].map(date => `${date} DD:DD:DD.DDD  [N][Lua] WCL1_`);

// Whether text after the frame tag can still become frame text: each field runs within its class up to
// its width and is ended by _ once it has its least width; a \r may follow only complete frame text.
function framePrefix(text) {
  let at = 0;
  for (const [index, field] of FRAME_FIELDS.entries()) {
    const begin = at;
    while (at < text.length && at - begin < field.max && field.char.test(text[at])) at += 1;
    if (at === text.length) return true;
    if (at - begin < field.min) return false;
    if (index === FRAME_FIELDS.length - 1) return text.slice(at) === '\r';
    if (text[at] !== '_') return false;
    at += 1;
  }
  return false;
}

// An unterminated tail that is a prefix of some frame line: only these can still become one.
function frameStart(text) {
  return LINE_STARTS.some(start => [...text.slice(0, start.length)].every((char, index) =>
    (start[index] === 'D' ? char >= '0' && char <= '9' : char === start[index]))
    && (text.length <= start.length || framePrefix(text.slice(start.length))));
}

export function encodeLogFrame({ epoch, nonce, uiNonce, slot, seq, payload }) {
  const bytes = Buffer.from(payload ?? []);
  if (bytes.length < 1 || bytes.length > MAX_PAYLOAD_BYTES) throw new TypeError('Log carrier payload must be 1..610 bytes');
  const allowZero = epoch === ZERO && nonce === ZERO;
  const fields = ['WCL1', fixedHex(epoch, 'epoch', allowZero), fixedHex(nonce, 'nonce', allowZero),
    fixedHex(uiNonce, 'UI nonce'), hex(slot, 4, 'slot'), hex(seq, 6, 'sequence'), encodeBase32(bytes)];
  if (slot < 1 || slot > 9999 || (seq < 1 && !heartbeatShape({ epoch, seq, part: 1, count: 1, payload: bytes }))) {
    throw new TypeError('Invalid carrier frame coordinates');
  }
  const core = fields.join('_');
  return `${core}_${crc32Ascii(core)}`;
}

export function encodeLogLine(frame, stamp = '11/23 19:41:31.260') {
  return `${stamp}  [N][Lua] ${encodeLogFrame(frame)}`;
}

function parseLogFrame(text) {
  const match = FRAME_RE.exec(text);
  if (!match) return null;
  const [, epochRaw, nonceRaw, uiRaw, slotRaw, seqRaw, encoded, crc] = match;
  if (crc32Ascii(text.slice(0, text.length - crc.length - 1)) !== crc) return null;
  let payload;
  try { payload = decodeBase32(encoded); } catch { return null; }
  const frame = { epoch: epochRaw.toLowerCase(), nonce: nonceRaw.toLowerCase(), uiNonce: uiRaw.toLowerCase(),
    slot: Number.parseInt(slotRaw, 16), seq: Number.parseInt(seqRaw, 16), part: 1, count: 1, payload };
  // The binding parser's rule: only text the encoder would write is a frame.
  try { if (encodeLogFrame(frame) !== text) return null; } catch { return null; }
  // The receiver's duplicate fingerprint leaves out the slot (and the CRC that covers it), so a frame
  // logged again naming a newer slot is a duplicate rather than a sequence mutation.
  frame.action = `WCL1_${epochRaw}_${nonceRaw}_${uiRaw}_${seqRaw}_${encoded}`;
  return frame;
}

// One line of General.log without its line end; a trailing \r is tolerated. Returns a frame or null.
export function parseLogLine(line) {
  if (typeof line !== 'string' || line.length > MAX_LINE_BYTES) return null;
  const match = LINE_RE.exec(line);
  return match ? parseLogFrame(match[1]) : null;
}

export class LogCarrier {
  constructor({ logFile, receiver, onError = () => {}, pollMs = 250, maxPassBytes = 4 * 1024 * 1024, watch = fsNative.watch } = {}) {
    if (!path.isAbsolute(logFile ?? '') || !(receiver instanceof BindingReceiver)
      || !Number.isInteger(maxPassBytes) || maxPassBytes < 1) throw new TypeError('Invalid log carrier configuration');
    Object.assign(this, { logFile: path.resolve(logFile), receiver, onError, pollMs, maxPassBytes, watch });
    this.stopped = false; this.scanning = false; this.queued = false;
    // offset is null until the first scan places it; size is the last stat's; carry holds an unterminated tail.
    // parkSize is the file size seen when the cursor stopped at a NUL byte (null when not parked); head is the mark.
    this.offset = null; this.birth = null; this.size = null; this.carry = []; this.carryBytes = 0; this.overflow = false;
    // skipped is where a hole the cursor moved over begins (null when it moved over none). tailFrom is where
    // the bytes after that hole begin and tailUis the UI sessions of the frames read from them. reread is that
    // span and those sessions once the cursor went back: { from, to, uis }.
    this.parkSize = null; this.head = Buffer.alloc(0); this.skipped = null;
    this.tailFrom = null; this.tailUis = new Set(); this.reread = null;
  }

  restart() {
    this.offset = 0; this.size = null; this.carry = []; this.carryBytes = 0; this.overflow = false;
    this.parkSize = null; this.head = Buffer.alloc(0); this.skipped = null;
    this.tailFrom = null; this.tailUis = new Set(); this.reread = null;
  }

  async scan() {
    if (this.stopped) return;
    if (this.scanning) { this.queued = true; return; }
    this.scanning = true;
    try {
      do {
        this.queued = false;
        await this.read();
      } while (this.queued && !this.stopped);
    } catch (error) { if (!this.stopped) this.onError(error); }
    finally { this.scanning = false; }
  }

  async read() {
    let stat;
    try { stat = await fs.stat(this.logFile); }
    catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      // No file (or no folder) is not an error. The next file to appear is a new client run.
      this.restart(); this.birth = null;
      return;
    }
    const starting = this.offset === null;
    if (starting && stat.size === 0) {
      this.offset = 0; this.birth = stat.birthtimeMs; this.size = 0; this.overflow = false;
      return;
    }
    if (!starting) {
      // A file that shrank is a new file, wherever the offset is.
      if ((this.size !== null && stat.size < this.size) || (this.birth !== null && stat.birthtimeMs !== this.birth)) this.restart();
      this.birth = stat.birthtimeMs; this.size = stat.size;
      // A hole the cursor moved over is looked at on every pass, also when nothing follows the cursor.
      if (stat.size <= this.offset && this.skipped === null) return;
    }
    let handle;
    try { handle = await fs.open(this.logFile, 'r'); }
    catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      // The file went away between stat and open: the missing-file case above.
      this.restart(); this.birth = null;
      return;
    }
    try {
      if (starting) await this.place(handle, stat);
      else await this.readOn(handle, stat);
    } finally { await handle.close(); }
  }

  // The first scan: the cursor goes to the live end, which is the file's end unless its last 256 KiB hold a
  // NUL byte. Then the live end is the smallest position holding a NUL (bytes before a hole are not NUL).
  // Every read here must be complete: a file that ended short of its stat places nothing, and the next
  // scan starts again.
  async place(handle, stat) {
    const markBytes = Math.min(HEAD_MARK_BYTES, stat.size), from = Math.max(0, stat.size - HOLE_SLACK_BYTES);
    const mark = await readAt(handle, markBytes, 0), window = await readAt(handle, stat.size - from, from);
    if (mark.length < markBytes || window.length < stat.size - from) return;
    // A file that does not end with a line end there: what is appended next ends a line whose start was
    // never read, so the reader skips to that line's end.
    let offset = stat.size, parkSize = null, overflow = window[window.length - 1] !== 0x0a;
    const nul = window.indexOf(0);
    if (nul !== -1) {
      let low = 0, high = from + nul;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        const [byte] = await readAt(handle, 1, middle);
        if (byte === undefined) return;
        if (byte === 0) high = middle; else low = middle + 1;
      }
      let before = 0x0a;
      if (high > 0) {
        [before] = await readAt(handle, 1, high - 1);
        if (before === undefined) return;
      }
      offset = high; parkSize = stat.size; overflow = before !== 0x0a;
    }
    Object.assign(this, { offset, parkSize, overflow, birth: stat.birthtimeMs, size: stat.size,
      head: Buffer.from(beforeNul(mark)) });
  }

  async readOn(handle, stat) {
    // A file that no longer starts with the head mark is a new file; a short mark grows with the file.
    const first = beforeNul(await readAt(handle, Math.min(HEAD_MARK_BYTES, stat.size), 0));
    if (first.length < this.head.length || !first.subarray(0, this.head.length).equals(this.head)) {
      this.restart(); this.size = stat.size;
    }
    this.head = Buffer.from(first);
    // The cursor moved over a hole because the file grew past it. A byte written at the hole's start means a
    // writer is filling it from there after all (the size of a far write can show in steps, which looks like
    // growth): the cursor goes back to that byte. What lies before it was not kept, so a line cut there is
    // skipped to its end.
    if (this.skipped !== null) {
      const [byte] = await readAt(handle, 1, this.skipped);
      if (byte !== undefined && byte !== 0) {
        let before = 0x0a;
        if (this.skipped > 0) {
          [before] = await readAt(handle, 1, this.skipped - 1);
          if (before === undefined) return;
        }
        // The bytes from tailFrom to the cursor were read once already; the cursor will reach them again.
        if (this.tailFrom !== null) {
          this.reread = { from: Math.min(this.tailFrom, this.reread?.from ?? this.tailFrom),
            to: Math.max(this.offset, this.reread?.to ?? 0), uis: new Set([...(this.reread?.uis ?? []), ...this.tailUis]) };
        }
        Object.assign(this, { offset: this.skipped, skipped: null, parkSize: null, carry: [], carryBytes: 0,
          overflow: before !== 0x0a, tailFrom: null, tailUis: new Set() });
      }
    }
    if (stat.size <= this.offset) return;
    // Parked at a NUL byte: a filled byte lets reading go on. While the byte is NUL and the file grew no more
    // than the slack, the one-byte look is all this pass does.
    if (this.parkSize !== null && stat.size - this.parkSize <= HOLE_SLACK_BYTES) {
      const [byte] = await readAt(handle, 1, this.offset);
      if (byte !== undefined && byte !== 0) { this.parkSize = null; this.queued = true; }
      return;
    }
    // One bounded read per pass. While bytes remain, scan runs another pass, which stats the file again.
    const chunk = await readAt(handle, Math.min(this.maxPassBytes, stat.size - this.offset), this.offset);
    if (!chunk.length) return;
    let at = 0;
    if (this.parkSize !== null) {
      // Nothing is filling the hole: move over its NUL bytes; the byte after it starts a line.
      while (at < chunk.length && chunk[at] === 0) at += 1;
      // The line state goes with the first NUL passed, so a later pass that begins after the hole starts clean.
      if (at > 0) {
        if (this.skipped === null) this.skipped = this.offset;
        this.carry = []; this.carryBytes = 0; this.overflow = false;
      }
      this.offset += at;
      if (at === chunk.length) { if (this.offset < stat.size) this.queued = true; return; }
      this.parkSize = null;
      if (this.skipped !== null && this.tailFrom === null) this.tailFrom = this.offset;
    }
    // A read never consumes a NUL byte: the cursor parks at the first one.
    const rest = chunk.subarray(at), nul = rest.indexOf(0);
    const live = nul === -1 ? rest : rest.subarray(0, nul);
    const base = this.offset;
    this.offset += live.length;
    await this.consume(live, base);
    if (nul !== -1) this.parkSize = stat.size;
    else if (this.offset < stat.size) this.queued = true;
  }

  // A line that is not a frame is never stored, logged, traced or passed on. base is the chunk's place in the
  // file. A frame line inside the span read before the cursor went back, from a UI session read there, was
  // delivered then and is not delivered again.
  async consume(chunk, base) {
    let start = 0;
    for (let end = chunk.indexOf(0x0a, start); end !== -1 && !this.stopped; end = chunk.indexOf(0x0a, start)) {
      const piece = chunk.subarray(start, end);
      start = end + 1;
      const overflow = this.overflow || this.carryBytes + piece.length > MAX_LINE_BYTES;
      const bytes = overflow ? null : (this.carryBytes ? Buffer.concat([...this.carry, piece]) : piece);
      this.carry = []; this.carryBytes = 0; this.overflow = false;
      const frame = bytes && parseLogLine(bytes.toString('latin1'));
      if (!frame) continue;
      const lineStart = base + end - bytes.length;
      if (this.reread && lineStart >= this.reread.from && base + end < this.reread.to && this.reread.uis.has(frame.uiNonce)) continue;
      if (this.skipped !== null) {
        this.tailUis.delete(frame.uiNonce); this.tailUis.add(frame.uiNonce);
        if (this.tailUis.size > TAIL_UI_LIMIT) this.tailUis.delete(this.tailUis.values().next().value);
      }
      try { await this.receiver.accept(frame); } catch (error) { if (!this.stopped) this.onError(error); }
    }
    const tail = chunk.subarray(start);
    if (!tail.length || this.overflow || this.stopped) return;
    // A tail is kept only while it can still start a frame line; anything else is skipped to its line end.
    const joined = this.carryBytes ? Buffer.concat([...this.carry, tail]) : tail;
    if (joined.length > MAX_FRAME_LINE_BYTES || !frameStart(joined.toString('latin1'))) {
      this.carry = []; this.carryBytes = 0; this.overflow = true; return;
    }
    this.carry = [Buffer.from(joined)]; this.carryBytes = joined.length;
  }

  async start() {
    await this.scan();
    if (this.stopped) return;
    try {
      this.watcher = this.watch(path.dirname(this.logFile), { persistent: false }, () => { void this.scan(); });
      // A watched folder that goes away reports an error event; the poll still reads.
      this.watcher?.on?.('error', () => {});
    } catch { /* No folder yet, or no watching here: the poll still reads. */ }
    this.timer = setInterval(() => { void this.scan(); }, this.pollMs);
    this.timer.unref?.();
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.watcher?.close();
    while (this.scanning) await new Promise(resolve => setTimeout(resolve, 5));
    this.carry = []; this.carryBytes = 0;
  }
}
