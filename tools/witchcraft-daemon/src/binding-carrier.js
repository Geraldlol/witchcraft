import fsNative from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

export const BINDING_KEYS = Object.freeze([
  'CTRL-ALT-SHIFT-F12',
  'CTRL-ALT-SHIFT-F11',
  'CTRL-ALT-SHIFT-F10',
  'CTRL-ALT-SHIFT-F9',
]);

const KEY_SET = new Set(BINDING_KEYS);
const ACTION_PREFIX = 'CLICK WitchcraftCarrier_';
const FRAME_RE = /^CLICK WitchcraftCarrier_V1_([0-9A-F]{8})_([0-9A-F]{8})_([0-9A-F]{8})_([0-9A-F]{4})_([0-9A-F]{6})_([0-9A-F]{2})_([0-9A-F]{2})_([A-Z2-7]{2,52})_([0-9A-F]{8}):LeftButton$/u;
const ZERO = '00000000';
const MAX_FILE_BYTES = 1024 * 1024;
const PROBE_BODY = Buffer.from('PFAM_BIND_PROBE', 'ascii');
const decoder = new TextDecoder('utf-8', { fatal: true });

const CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < 256; index++) {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  CRC_TABLE[index] = value >>> 0;
}

function crc32Ascii(value) {
  let crc = 0xffffffff;
  for (const byte of Buffer.from(value, 'ascii')) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return ((crc ^ 0xffffffff) >>> 0).toString(16).toUpperCase().padStart(8, '0');
}

export function encodeBase32(value) {
  const bytes = Buffer.from(value), alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, accumulator = 0, output = '';
  for (const byte of bytes) {
    accumulator = accumulator * 256 + byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += alphabet[Math.floor(accumulator / 2 ** bits)];
      accumulator %= 2 ** bits;
    }
  }
  if (bits) output += alphabet[accumulator * 2 ** (5 - bits)];
  return output;
}

export function decodeBase32(value) {
  if (typeof value !== 'string' || !/^[A-Z2-7]+$/u.test(value)) throw new Error('Invalid carrier base32');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', bytes = [];
  let bits = 0, accumulator = 0;
  for (const character of value) {
    accumulator = accumulator * 32 + alphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push(Math.floor(accumulator / 2 ** bits));
      accumulator %= 2 ** bits;
    }
  }
  if (accumulator !== 0 || encodeBase32(bytes) !== value) throw new Error('Non-canonical carrier base32');
  return Buffer.from(bytes);
}

const hex = (value, width, label) => {
  if (!Number.isInteger(value) || value < 0 || value >= 16 ** width) throw new TypeError(`Invalid carrier ${label}`);
  return value.toString(16).toUpperCase().padStart(width, '0');
};
const fixedHex = (value, label, zero = false) => {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}$/u.test(value) || (!zero && value === ZERO)) throw new TypeError(`Invalid carrier ${label}`);
  return value.toUpperCase();
};

export function encodeBindingAction({ epoch, nonce, uiNonce, slot, seq, part, count, payload }) {
  const bytes = Buffer.from(payload ?? []);
  if (bytes.length < 1 || bytes.length > 32) throw new TypeError('Carrier payload must be 1..32 bytes');
  const allowZero = epoch === ZERO && nonce === ZERO;
  const fields = ['V1', fixedHex(epoch, 'epoch', allowZero), fixedHex(nonce, 'nonce', allowZero),
    fixedHex(uiNonce, 'UI nonce'), hex(slot, 4, 'slot'), hex(seq, 6, 'sequence'), hex(part, 2, 'part'),
    hex(count, 2, 'part count'), encodeBase32(bytes)];
  if (part < 1 || count < 1 || part > count || count > 32 || slot < 1 || slot > 9999 || seq < 1) {
    throw new TypeError('Invalid carrier frame coordinates');
  }
  const core = `WitchcraftCarrier_${fields.join('_')}`;
  return `CLICK ${core}_${crc32Ascii(core)}:LeftButton`;
}

export function parseBindingAction(action) {
  if (typeof action !== 'string') throw new Error('Carrier action must be text');
  const match = FRAME_RE.exec(action);
  if (!match) throw new Error('Malformed carrier action');
  const [, epochRaw, nonceRaw, uiRaw, slotRaw, seqRaw, partRaw, countRaw, encoded, crc] = match;
  const core = action.slice('CLICK '.length, action.length - `_${crc}:LeftButton`.length);
  if (crc32Ascii(core) !== crc) throw new Error('Carrier CRC mismatch');
  const payload = decodeBase32(encoded);
  if (payload.length < 1 || payload.length > 32) throw new Error('Carrier payload size');
  const frame = { action, epoch: epochRaw.toLowerCase(), nonce: nonceRaw.toLowerCase(), uiNonce: uiRaw.toLowerCase(),
    slot: Number.parseInt(slotRaw, 16), seq: Number.parseInt(seqRaw, 16), part: Number.parseInt(partRaw, 16),
    count: Number.parseInt(countRaw, 16), payload };
  if (frame.slot < 1 || frame.slot > 9999 || frame.seq < 1 || frame.part < 1 || frame.count < 1
    || frame.count > 32 || frame.part > frame.count || frame.uiNonce === ZERO
    || ((frame.epoch === ZERO) !== (frame.nonce === ZERO))) throw new Error('Carrier frame coordinates');
  return frame;
}

export function parseBindingFile(source) {
  const bytes = Buffer.isBuffer(source) ? source : Buffer.from(source, 'utf8');
  if (bytes.length > MAX_FILE_BYTES) throw new Error('Binding file exceeds byte budget');
  const text = decoder.decode(bytes), frames = [];
  for (const line of text.split(/\r?\n/u)) {
    if (!line) continue;
    const match = /^bind ([A-Z0-9-]+) (.+)$/u.exec(line);
    if (!match) continue;
    const [, key, action] = match;
    if (!action.startsWith(ACTION_PREFIX)) continue;
    if (!KEY_SET.has(key)) throw new Error('Carrier action used a key outside the allowlist');
    frames.push({ key, ...parseBindingAction(action) });
  }
  if (frames.length > 1) throw new Error('Multiple carrier frames persisted at once');
  return frames;
}

export async function discoverBindingFiles(accountDir, { maxDepth = 4, maxEntries = 4096 } = {}) {
  const root = path.resolve(accountDir), found = [];
  let entries = 0;
  async function visit(directory, depth) {
    if (depth > maxDepth) return;
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
      if (++entries > maxEntries) throw new Error('Binding discovery exceeds entry budget');
      const filename = path.join(directory, item.name);
      if (item.isSymbolicLink()) continue;
      if (item.isDirectory()) await visit(filename, depth + 1);
      else if (item.isFile() && item.name.toLowerCase() === 'bindings-cache.wtf') found.push(filename);
    }
  }
  await visit(root, 0);
  return found.sort((left, right) => left.localeCompare(right));
}

export async function readStableBindingFile(filename, { delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)), delayMs = 20 } = {}) {
  const firstStat = await fs.stat(filename);
  if (!firstStat.isFile() || firstStat.size > MAX_FILE_BYTES) throw new Error('Invalid binding file');
  const first = await fs.readFile(filename);
  await delay(delayMs);
  const secondStat = await fs.stat(filename), second = await fs.readFile(filename);
  if (!secondStat.isFile() || secondStat.size > MAX_FILE_BYTES || firstStat.size !== secondStat.size
    || firstStat.mtimeMs !== secondStat.mtimeMs || !first.equals(second)) return null;
  return second;
}

function parseApplicationBody(body, frame, startedAt, now) {
  const type = String.fromCharCode(body[0] ?? 0);
  if (type === 'I') {
    if (body.length < 6 || body.length > 610) throw new Error('Invalid input carrier body');
    const id = body.readUIntBE(1, 3), tab = ['claude', 'codex'][body[4]];
    const action = ['text', 'enter', 'interrupt', 'escape', 'up', 'down'][body[5]];
    if (!id || !tab || !action) throw new Error('Invalid input carrier route');
    return { epoch: frame.epoch, id, tab, action, text: decoder.decode(body.subarray(6)) };
  }
  if (type === 'C') {
    if (body.length < 4 || body.length > 584) throw new Error('Invalid context carrier body');
    const id = body.readUIntBE(1, 3);
    if (!id) throw new Error('Invalid context carrier ID');
    return { kind: 'context', epoch: frame.epoch, uiNonce: frame.uiNonce, id,
      text: decoder.decode(body.subarray(4)), transportAgeSeconds: Math.max(0, now - startedAt) / 1000 };
  }
  throw new Error('Unknown carrier application kind');
}

export class BindingReceiver {
  constructor({ epoch, nonce, onCursor = () => true, onMessage = () => ({ accepted: true }), onAck = () => {}, now = Date.now } = {}) {
    this.epoch = fixedHex(epoch, 'host epoch').toLowerCase();
    this.nonce = fixedHex(nonce, 'host nonce').toLowerCase();
    Object.assign(this, { onCursor, onMessage, onAck, now });
    this.ack = 0; this.uiNonce = null; this.pending = null; this.seen = new Map(); this.quarantined = false;
  }

  quarantine(reason) { this.quarantined = reason; throw new Error(`Binding carrier quarantined: ${reason}`); }

  async accept(frame) {
    if (this.quarantined) return { accepted: false, reason: this.quarantined, ack: this.ack };
    const fingerprint = frame.action;
    if (this.seen.has(frame.seq)) {
      if (this.seen.get(frame.seq) !== fingerprint) return this.quarantine('sequence mutation');
      if (await this.onCursor(frame) !== true) return { accepted: false, reason: 'cursor', ack: this.ack };
      await this.onAck(this.ack, frame, { duplicate: true });
      return { accepted: true, duplicate: true, ack: this.ack };
    }
    if (await this.onCursor(frame) !== true) return { accepted: false, reason: 'cursor', ack: this.ack };
    const probe = frame.epoch === ZERO && frame.nonce === ZERO;
    if (probe) {
      if (this.ack !== 0 || frame.seq !== 1 || frame.part !== 1 || frame.count !== 1 || !frame.payload.equals(PROBE_BODY)) {
        return this.quarantine('invalid bootstrap probe');
      }
      this.uiNonce = frame.uiNonce; this.ack = 1; this.seen.set(1, fingerprint);
      await this.onAck(this.ack, frame, { probe: true });
      return { accepted: true, probe: true, ack: this.ack, uiNonce: this.uiNonce };
    }
    if (frame.epoch !== this.epoch || frame.nonce !== this.nonce || frame.uiNonce !== this.uiNonce) {
      return { accepted: false, reason: 'session', ack: this.ack };
    }
    if (frame.seq !== this.ack + 1) return { accepted: false, reason: 'sequence', ack: this.ack };
    if (frame.part === 1) {
      this.pending = { count: frame.count, chunks: [], startedAt: this.now() };
    } else if (!this.pending || this.pending.count !== frame.count || this.pending.chunks.length + 1 !== frame.part) {
      return this.quarantine('part ordering');
    }
    this.pending.chunks.push(frame.payload);
    let message, outcome = { accepted: true, partial: frame.part < frame.count };
    if (frame.part === frame.count) {
      const pending = this.pending;
      try {
        message = parseApplicationBody(Buffer.concat(pending.chunks), frame, pending.startedAt, this.now());
      } catch (error) {
        // The same bytes can never parse, so this is consumed once as rejected rather than
        // retried on every scan; only a delivery failure below is worth retrying.
        this.pending = null; this.ack = frame.seq; this.seen.set(frame.seq, fingerprint);
        while (this.seen.size > 64) this.seen.delete(this.seen.keys().next().value);
        const rejected = { accepted: false, reason: `malformed carrier body: ${error.message}` };
        await this.onAck(this.ack, frame, rejected);
        return { ...rejected, ack: this.ack };
      }
      try {
        outcome = await this.onMessage(message);
      } catch (error) {
        // Undo the append exactly as a returned rejection does, so the retransmitted final part
        // is retried rather than read as a part-ordering violation that quarantines the lane.
        pending.chunks.pop();
        throw error;
      }
      if (!outcome || outcome.accepted !== true) {
        pending.chunks.pop();
        return { accepted: false, reason: outcome?.reason ?? 'application', ack: this.ack };
      }
      this.pending = null;
    }
    this.ack = frame.seq; this.seen.set(frame.seq, fingerprint);
    while (this.seen.size > 64) this.seen.delete(this.seen.keys().next().value);
    await this.onAck(this.ack, frame, outcome);
    return { accepted: true, ack: this.ack, message, ...outcome };
  }
}

export class BindingCarrier {
  constructor({ accountDir, receiver, pollMs = 250, onError = () => {}, discover = discoverBindingFiles,
    stableRead = readStableBindingFile, watch = fsNative.watch } = {}) {
    if (!path.isAbsolute(accountDir ?? '') || !(receiver instanceof BindingReceiver)) throw new TypeError('Invalid binding carrier configuration');
    Object.assign(this, { accountDir: path.resolve(accountDir), receiver, pollMs, onError, discover, stableRead, watch });
    this.stopped = false; this.scanning = false; this.queued = false;
  }

  async scan() {
    if (this.stopped) return;
    if (this.scanning) { this.queued = true; return; }
    this.scanning = true;
    try {
      do {
        this.queued = false;
        for (const filename of await this.discover(this.accountDir)) {
          const source = await this.stableRead(filename);
          if (!source) continue;
          for (const frame of parseBindingFile(source)) await this.receiver.accept(frame);
        }
      } while (this.queued && !this.stopped);
    } catch (error) { if (!this.stopped) this.onError(error); }
    finally { this.scanning = false; }
  }

  async start() {
    await this.scan();
    if (this.stopped) return;
    try { this.watcher = this.watch(this.accountDir, { recursive: true, persistent: false }, () => { void this.scan(); }); }
    catch (error) { if (!['ERR_FEATURE_UNAVAILABLE_ON_PLATFORM', 'ERR_INVALID_ARG_VALUE'].includes(error.code)) this.onError(error); }
    this.timer = setInterval(() => { void this.scan(); }, this.pollMs);
    this.timer.unref?.();
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.watcher?.close();
    while (this.scanning) await new Promise(resolve => setTimeout(resolve, 5));
  }
}

export const BINDING_PROBE_BODY = Buffer.from(PROBE_BODY);
