// Experimental source-only backend. This module never writes game files.
import fs from 'node:fs/promises';
import path from 'node:path';

export const ADDONS_STATE = Object.freeze({ bytes: 32, payload: 8, bits: 256, parts: 64,
  maxMessage: 512, maxFile: 8 * 1024 * 1024, ttlMs: 900_000, commit: 'WitchcraftStateCommit' });
export const ADDONS_STATE_NAMES = Object.freeze(Array.from({ length: 256 }, (_, i) => `WitchcraftStateBit${String(i).padStart(3, '0')}`));
export const ADDONS_STATE_BANK = Object.freeze([...ADDONS_STATE_NAMES, ADDONS_STATE.commit]);
const names = new Set(ADDONS_STATE_BANK);
const sessionValid = value => typeof value === 'string' && /^[0-9a-f]{16}$/u.test(value) && value !== '0000000000000000';
const integer = (value, low, high) => Number.isInteger(value) && value >= low && value <= high;

export function stateCRC(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function encodeStateFrame({ session, seq, message, part, count, payload }) {
  const data = Buffer.from(payload ?? []);
  if (!sessionValid(session) || !integer(seq, 1, 65535) || !integer(message, 1, 65535)
      || !integer(part, 1, 64) || !integer(count, part, 64) || data.length < 1 || data.length > 8
      || (part < count && data.length !== 8)) throw new Error('Invalid AddOns-state frame');
  const bytes = Buffer.alloc(32);
  bytes.write('FS', 0, 'ascii'); bytes[2] = 1; bytes[3] = data.length;
  Buffer.from(session, 'hex').copy(bytes, 4);
  bytes.writeUInt16BE(seq, 12); bytes.writeUInt16BE(message, 14);
  bytes[16] = part; bytes[17] = count; data.copy(bytes, 18);
  bytes.writeUInt32BE(stateCRC(bytes.subarray(0, 28)), 28);
  return bytes;
}

export function decodeStateFrame(source) {
  const bytes = Buffer.from(source);
  if (bytes.length !== 32 || bytes.toString('ascii', 0, 2) !== 'FS' || bytes[2] !== 1
      || bytes.readUInt32BE(28) !== stateCRC(bytes.subarray(0, 28))) throw new Error('AddOns-state header or CRC');
  const frame = { session: bytes.toString('hex', 4, 12), seq: bytes.readUInt16BE(12),
    message: bytes.readUInt16BE(14), part: bytes[16], count: bytes[17], payload: bytes.subarray(18, 18 + bytes[3]) };
  if (!encodeStateFrame(frame).equals(bytes)) throw new Error('Noncanonical AddOns-state frame');
  return frame;
}

export function frameStates(frame, committed = true) {
  const bytes = encodeStateFrame(frame), states = new Map();
  for (let bit = 0; bit < 256; bit++) states.set(ADDONS_STATE_NAMES[bit], (bytes[bit >> 3] >> (7 - bit % 8)) & 1);
  states.set(ADDONS_STATE.commit, committed ? 1 : 0);
  return states;
}

// Only fixed bank rows are parsed; no Lua evaluation, inheritance guesses or account scanning.
export function parseAddonsState(source) {
  const bytes = Buffer.isBuffer(source) ? source : Buffer.from(source);
  if (bytes.length > ADDONS_STATE.maxFile) throw new Error('AddOns.txt exceeds byte budget');
  const states = new Map();
  for (const line of bytes.toString('latin1').split(/\r?\n/u)) {
    if (!line.startsWith('WitchcraftState')) continue;
    const match = /^(WitchcraftState(?:Bit[0-9]{3}|Commit)): (enabled|disabled)$/u.exec(line);
    if (!match || !names.has(match[1]) || states.has(match[1])) throw new Error('Malformed or duplicate bank row');
    states.set(match[1], match[2] === 'enabled' ? 1 : 0);
  }
  if (states.size !== 257) throw new Error('Incomplete AddOns-state bank');
  if (states.get(ADDONS_STATE.commit) === 0) return null;
  const frame = Buffer.alloc(32);
  for (let bit = 0; bit < 256; bit++) frame[bit >> 3] |= states.get(ADDONS_STATE_NAMES[bit]) << (7 - bit % 8);
  return decodeStateFrame(frame);
}

async function boundedRead(filename) {
  const handle = await fs.open(filename, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > ADDONS_STATE.maxFile) throw new Error('Invalid AddOns.txt file');
    const buffer = Buffer.alloc(ADDONS_STATE.maxFile + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > ADDONS_STATE.maxFile) throw new Error('AddOns.txt grew beyond byte budget');
    return buffer.subarray(0, length);
  } finally { await handle.close(); }
}

export async function readStableAddonsState(filename, { read = boundedRead,
  delay = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const first = await read(filename);
  await delay(50);
  const second = await read(filename);
  return first.equals(second) ? parseAddonsState(second) : null;
}

// An explicitly selected character's file, pinned fresh session, and serialized acceptance.
// onMessage is data-only; durable application deduplication remains the caller's responsibility.
export class AddonsStateReceiver {
  constructor({ session, onMessage, now = Date.now } = {}) {
    if (!sessionValid(session) || typeof onMessage !== 'function') throw new Error('Fresh AddOns-state session and explicit data consumer required');
    Object.assign(this, { session, onMessage, now, ack: 0, message: 0, pending: null, last: null, busy: false });
  }

  async accept(input) {
    const frame = decodeStateFrame(encodeStateFrame(input));
    if (frame.session !== this.session) return { accepted: false, reason: 'session' };
    if (this.busy) return { accepted: false, reason: 'busy' };
    const fingerprint = encodeStateFrame(frame).toString('hex');
    if (frame.seq === this.ack) {
      if (fingerprint !== this.last) throw new Error('AddOns-state sequence mutation');
      return { accepted: true, duplicate: true, session: this.session, ack: this.ack };
    }
    if (frame.seq !== this.ack + 1) return { accepted: false, reason: 'sequence' };
    if (this.pending && this.now() - this.pending.started > ADDONS_STATE.ttlMs) {
      return { accepted: false, reason: 'expired; start a fresh session' };
    }
    const pending = this.pending ?? { message: this.message + 1, count: frame.count, chunks: [], started: this.now() };
    if (frame.message !== pending.message || frame.count !== pending.count || frame.part !== pending.chunks.length + 1) {
      return { accepted: false, reason: 'fragment order' };
    }
    const chunks = [...pending.chunks, Buffer.from(frame.payload)];
    this.busy = true;
    try {
      if (frame.part === frame.count) {
        const outcome = await this.onMessage(Buffer.concat(chunks), { session: this.session, message: frame.message });
        if (outcome !== true) return { accepted: false, reason: 'application' };
        this.message = frame.message; this.pending = null;
      } else this.pending = { ...pending, chunks };
      this.ack = frame.seq; this.last = fingerprint;
      return { accepted: true, session: this.session, ack: this.ack };
    } finally { this.busy = false; }
  }
}

export class AddonsStateReader {
  constructor({ filename, receiver, read = readStableAddonsState } = {}) {
    if (!path.isAbsolute(filename ?? '') || path.basename(filename).toLowerCase() !== 'addons.txt'
        || !(receiver instanceof AddonsStateReceiver)) throw new Error('Explicit character AddOns.txt required');
    Object.assign(this, { filename, receiver, read, busy: false });
  }
  async poll() {
    if (this.busy) return null;
    this.busy = true;
    try { const frame = await this.read(this.filename); return frame ? await this.receiver.accept(frame) : null; }
    finally { this.busy = false; }
  }
}

// Returns inert source files for a reviewable staging package; deliberately performs no writes.
export function inertStateBank() {
  return ADDONS_STATE_BANK.map(name => ({ name, filename: `${name}/${name}.toc`,
    source: `## Interface: 16001\n## Title: ${name}\n## Notes: Inert Witchcraft state carrier; no executable payload.\n## LoadOnDemand: 1\n## DefaultState: disabled\n` }));
}
