import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { MAX_CHUNK_BYTES, quoteLua, serializeChunk } from './lua.js';

export function chunkName(index) {
  if (!Number.isInteger(index) || index < 1 || index > 9999) throw new Error('Invalid chunk index');
  return `Witchcraft_Chunk_${String(index).padStart(4, '0')}`;
}
export async function assertOwnedChunk(addonsDir, index) {
  const name = chunkName(index), directory = path.join(path.resolve(addonsDir), name);
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || await fs.realpath(directory) !== directory) throw new Error(`Refusing linked chunk: ${name}`);
  const tocPath = path.join(directory, `${name}.toc`);
  const tocInfo = await fs.lstat(tocPath);
  if (!tocInfo.isFile() || tocInfo.isSymbolicLink()) throw new Error(`Invalid chunk TOC: ${name}`);
  const toc = await fs.readFile(tocPath, 'utf8');
  if (!/^## X-Witchcraft-Chunk: 1\s*$/mu.test(toc) || !/^## Dependencies: Witchcraft\s*$/mu.test(toc)
    || !/^## LoadOnDemand: 1\s*$/mu.test(toc)) throw new Error(`Unowned chunk: ${name}`);
  return directory;
}
// Windows refuses to replace a file that another process has open (the game's
// loader reading the slot, or a virus scanner touching the fresh temp file).
// Those are momentary, so the rename is retried briefly before giving up.
export const TRANSIENT_WRITE_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
export function isTransientWriteError(error) { return TRANSIENT_WRITE_CODES.has(error?.code); }
export async function atomicWrite(filename, contents, { rename = fs.rename, attempts = 12, delayMs = 25 } = {}) {
  const temporary = `${filename}.witchcraft-${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, contents, { flag: 'wx', mode: 0o600 });
    for (let attempt = 1; ; attempt++) {
      try { await rename(temporary, filename); return attempt; }
      catch (error) {
        if (!isTransientWriteError(error) || attempt >= attempts) throw error;
        await new Promise(resolve => setTimeout(resolve, delayMs * attempt));
      }
    }
  } finally { await fs.rm(temporary, { force: true }); }
}
// Ring.lua copies history under its line rules and counts it in the same 300000-byte session
// budget as lines, so the oldest history rows are dropped here rather than have the addon reject the chunk.
export const SESSION_BYTE_BUDGET = 300000;
const lineBytes = line => Buffer.byteLength(line, 'utf8');
const validLine = line => typeof line === 'string' && !/[\u0000-\u001f\u007f]/u.test(line) && lineBytes(line) <= 8192;
export function boundSessionHistory(sessions) {
  if (!Array.isArray(sessions)) return sessions;
  return sessions.map(session => {
    if (!session || typeof session !== 'object') return session;
    // The scrolled counter anchors a reader's scroll position, so a malformed one is refused
    // rather than dropped: the addon would otherwise slide its view against the wrong number.
    const { scrolled } = session;
    if (scrolled !== undefined && (!Number.isInteger(scrolled) || scrolled < 0 || scrolled > 2147483647)) {
      throw new TypeError('Invalid session scrolled counter');
    }
    if (session.history === undefined) return session;
    const { history } = session;
    // Rows arrive rendered and bounded (renderRow clamps cells), so a bad history is a programming error, which stops.
    if (!Array.isArray(history) || history.length > 1000 || !history.every(validLine)) throw new TypeError('Invalid session history');
    let budget = SESSION_BYTE_BUDGET - (Array.isArray(session.lines) ? session.lines : []).reduce((total, line) => total + (typeof line === 'string' ? lineBytes(line) : 0), 0);
    let keep = 0;
    for (let index = history.length - 1; index >= 0 && budget >= lineBytes(history[index]); index--) { budget -= lineBytes(history[index]); keep++; }
    return { ...session, history: history.slice(history.length - keep) };
  });
}

// Raw per-session limits do not bound Lua source: Unicode bytes become decimal escapes.
// Reserve the complete current screens and envelope, then share the remaining source bytes
// across history suffixes. The tab retaining fewer bytes gets the next row, so one tab's
// backlog cannot consume the other tab's allowance. Unused space remains available to either.
function serializeHistoryChunk(payload) {
  if (!Array.isArray(payload.sessions)) return serializeChunk(payload);
  const sessions = boundSessionHistory(payload.sessions);
  const histories = sessions.map((session, index) => Array.isArray(session?.history)
    ? { index, rows: session.history, kept: 0, bytes: 0 } : null).filter(Boolean);
  const baseSessions = sessions.map(session => Array.isArray(session?.history) ? { ...session, history: [] } : session);
  const base = serializeChunk({ ...payload, sessions: baseSessions });
  let remaining = MAX_CHUNK_BYTES - base.length;
  const pending = histories.filter(history => history.rows.length > 0);
  if (!pending.length) return base;
  while (pending.length) {
    const next = pending.reduce((least, history) => history.bytes < least.bytes ? history : least);
    const row = next.rows[next.rows.length - next.kept - 1];
    const bytes = quoteLua(row).length + (next.kept > 0 ? 1 : 0);
    if (bytes > remaining) {
      pending.splice(pending.indexOf(next), 1);
      continue;
    }
    next.kept++;
    next.bytes += bytes;
    remaining -= bytes;
    if (next.kept === next.rows.length) pending.splice(pending.indexOf(next), 1);
  }
  for (const history of histories) {
    // scrolled is a lifetime count, not the number retained; trimming must not move its anchor.
    sessions[history.index] = { ...sessions[history.index], history: history.rows.slice(history.rows.length - history.kept) };
  }
  return serializeChunk({ ...payload, sessions });
}

export class RingWriter {
  constructor({ addonsDir, ringSize = 3000, epoch, write = atomicWrite, check = assertOwnedChunk }) {
    if (!Number.isInteger(ringSize) || ringSize < 3 || ringSize > 9999 || !/^[0-9a-f]{8}$/u.test(epoch) || epoch === '00000000') {
      throw new Error('Invalid ring configuration');
    }
    Object.assign(this, { addonsDir: path.resolve(addonsDir), ringSize, epoch, write, check });
    this.cursor = 1; this.generation = 0; this.chain = Promise.resolve(); this.stopped = false;
    this.uiNonce = '00000000'; this.retired = new Set(); this.changed = false; this.written = new Set();
  }
  request(heartbeat) {
    if (this.stopped || !heartbeat || !/^[0-9a-f]{8}$/u.test(heartbeat.epoch)
      || !/^[0-9a-f]{8}$/u.test(heartbeat.uiNonce) || heartbeat.uiNonce === '00000000'
      || !Number.isInteger(heartbeat.nextSeq) || heartbeat.nextSeq < 1 || heartbeat.nextSeq > this.ringSize) return false;
    if (heartbeat.uiNonce !== this.uiNonce) {
      if (this.retired.has(heartbeat.uiNonce)) return false;
      this.retired.add(this.uiNonce);
      if (this.retired.size > 32) this.retired.delete(this.retired.values().next().value);
      this.uiNonce = heartbeat.uiNonce;
      this.reset();
    }
    if (heartbeat.nextSeq < this.cursor) return false;
    if (heartbeat.nextSeq !== this.cursor) this.changed = false;
    this.cursor = heartbeat.nextSeq;
    return true;
  }
  reset() { this.generation++; this.cursor = 1; this.changed = false; }
  publish(snapshot) {
    // Protocol 4: game context is pulled on demand, never streamed. contextWant is the request
    // id and contextWantMask names the domains (1 player, 2 quests, 4 progress, 8 errors) it asks for.
    if (snapshot.contextProtocol !== undefined || snapshot.contextAck !== undefined
      || snapshot.contextWant !== undefined || snapshot.contextWantMask !== undefined) {
      if (snapshot.contextProtocol !== 4 || !Number.isInteger(snapshot.contextAck)
        || snapshot.contextAck < 0 || snapshot.contextAck > 262143
        || !Number.isInteger(snapshot.contextWant)
        || snapshot.contextWant < 0 || snapshot.contextWant > 262143
        || !Number.isInteger(snapshot.contextWantMask)
        || snapshot.contextWantMask < 0 || snapshot.contextWantMask > 15)
        throw new TypeError('Invalid context acknowledgement extension');
    }
    if (snapshot.bindingProtocol !== undefined || snapshot.bindingNonce !== undefined || snapshot.bindingAck !== undefined) {
      if (snapshot.bindingProtocol !== 1 || !/^[0-9a-f]{8}$/u.test(snapshot.bindingNonce ?? '')
        || snapshot.bindingNonce === '00000000' || !Number.isInteger(snapshot.bindingAck)
        || snapshot.bindingAck < 0 || snapshot.bindingAck > 16777215) {
        throw new TypeError('Invalid binding acknowledgement extension');
      }
    }
    const generation = this.generation, seq = this.cursor;
    this.changed ||= snapshot.changed === true;
    const payload = { ...snapshot, changed: this.changed, protocol: 1, ready: true, epoch: this.epoch,
      uiNonce: this.uiNonce, seq, ringSize: this.ringSize };
    const source = serializeHistoryChunk(payload);
    const operation = this.chain.catch(() => {}).then(async () => {
      if (this.stopped || generation !== this.generation || seq !== this.cursor) return false;
      const directory = await this.check(this.addonsDir, seq);
      if (this.stopped || generation !== this.generation || seq !== this.cursor) return false;
      await this.write(path.join(directory, 'Chunk.lua'), source);
      this.written.add(seq);
      return true;
    });
    this.chain = operation;
    return operation;
  }
  // Published chunks hold both terminal transcripts, so each goes back to the init placeholder
  // rather than outliving the run in the AddOns folder.
  async scrubSlot(seq) {
    const directory = await this.check(this.addonsDir, seq);
    await this.write(path.join(directory, 'Chunk.lua'), serializeChunk({ protocol: 1, ready: false, seq, ringSize: this.ringSize }));
  }
  // A crashed run never reached stop(); clear any ready chunk it left before this run publishes.
  async scrubStale() {
    const failed = [];
    let scrubbed = 0;
    for (let seq = 1; seq <= this.ringSize; seq++) {
      try {
        const directory = await this.check(this.addonsDir, seq);
        // Only a missing chunk is nothing to clear; any other read failure may hide a transcript.
        const source = await fs.readFile(path.join(directory, 'Chunk.lua'), 'utf8')
          .catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
        if (!/\["ready"\]=true/u.test(source)) continue;
        await this.scrubSlot(seq); scrubbed++;
      } catch (error) { failed.push(`slot ${seq}: ${error.message}`); }
    }
    return { scrubbed, failed };
  }
  async stop() {
    this.stopped = true; this.generation++; await this.chain.catch(() => {});
    const failed = [];
    for (const seq of this.written) {
      try { await this.scrubSlot(seq); this.written.delete(seq); }
      catch (error) { failed.push(`slot ${seq}: ${error.message}`); }
    }
    if (failed.length) throw new Error(`Terminal transcript left in ${failed.length} ring chunk(s): ${failed.join('; ')}`);
  }
}
