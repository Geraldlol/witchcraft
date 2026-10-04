// Read-only host adapter for Witchcraft frames embedded in the client-owned
// cooldownmanager.txt payload. This module never writes game files.
import fs from 'node:fs/promises';
import path from 'node:path';
import { inflateRawSync, inflateSync } from 'node:zlib';

export const COOLDOWN_CARRIER = Object.freeze({
  protocol: 2,
  layoutEncoding: 1,
  minLayoutVersion: 1,
  maxLayoutVersion: 5,
  filename: 'cooldownmanager.txt',
  maxFileBytes: 128 * 1024,
  maxCompressedBytes: 96 * 1024,
  maxCborBytes: 64 * 1024,
  maxCborNodes: 20_000,
  maxCborDepth: 16,
  maxCollectionEntries: 10_000,
  maxPayloadBytes: 512,
  maxParts: 16,
  maxMessageBytes: 8 * 1024,
  ttlMs: 30_000,
});

// Protocol 2 frame: FC, protocol, kind, epoch(4), nonce(4), uiNonce(4), seq(3), message(3),
// part, count, slot(2), payload length(2), payload, CRC-32 over everything before it.
const MAGIC = Buffer.from('FC', 'ascii');
const FRAME_HEADER_BYTES = 28;
const FRAME_TRAILER_BYTES = 4;
const MAX_U24 = 0xffffff;
const MAX_SLOT = 9999;
const ZERO = '00000000';
const KIND_TO_CODE = Object.freeze({ context: 1, heartbeat: 2 });
const CODE_TO_KIND = Object.freeze({ 1: 'context', 2: 'heartbeat' });
const HEARTBEAT_COMBAT = 1, HEARTBEAT_RELOAD = 2;
const utf8 = new TextDecoder('utf-8', { fatal: true });

const integer = (value, low, high) => Number.isInteger(value) && value >= low && value <= high;
const hex8 = value => typeof value === 'string' && /^[0-9a-f]{8}$/u.test(value) && value !== ZERO;

export function cooldownCRC(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u24(buffer, offset) {
  return buffer[offset] * 0x10000 + buffer[offset + 1] * 0x100 + buffer[offset + 2];
}

function putU24(buffer, value, offset) {
  buffer[offset] = Math.floor(value / 0x10000);
  buffer[offset + 1] = Math.floor(value / 0x100) & 0xff;
  buffer[offset + 2] = value & 0xff;
}

// A heartbeat is one flags byte at message 0, part 1 of 1. Only a heartbeat may carry the zero
// session ids (bootstrap, before the addon has a host session), and then both must be zero.
export function encodeCooldownFrame({ epoch, nonce, uiNonce, seq, message, part, count, slot, kind = 'context', payload }) {
  const body = Buffer.from(payload ?? []), kindCode = KIND_TO_CODE[kind], heartbeat = kind === 'heartbeat';
  const zeroIds = epoch === ZERO && nonce === ZERO;
  const sessionOk = (hex8(epoch) && hex8(nonce)) || (heartbeat && zeroIds);
  const shapeOk = heartbeat ? (message === 0 && part === 1 && count === 1 && body.length === 1)
    : (integer(message, 1, MAX_U24) && body.length >= 1 && body.length <= COOLDOWN_CARRIER.maxPayloadBytes
      && (part === count || body.length === COOLDOWN_CARRIER.maxPayloadBytes));
  if (!sessionOk || !hex8(uiNonce) || !integer(seq, 1, MAX_U24) || !integer(part, 1, COOLDOWN_CARRIER.maxParts)
      || !integer(count, part, COOLDOWN_CARRIER.maxParts) || !integer(slot, 1, MAX_SLOT) || !kindCode || !shapeOk) {
    throw new TypeError('Invalid cooldown carrier frame');
  }
  const frame = Buffer.alloc(FRAME_HEADER_BYTES + body.length + FRAME_TRAILER_BYTES);
  MAGIC.copy(frame, 0); frame[2] = COOLDOWN_CARRIER.protocol; frame[3] = kindCode;
  Buffer.from(epoch, 'hex').copy(frame, 4); Buffer.from(nonce, 'hex').copy(frame, 8);
  Buffer.from(uiNonce, 'hex').copy(frame, 12); putU24(frame, seq, 16); putU24(frame, message, 19);
  frame[22] = part; frame[23] = count; frame.writeUInt16BE(slot, 24); frame.writeUInt16BE(body.length, 26);
  body.copy(frame, 28);
  frame.writeUInt32BE(cooldownCRC(frame.subarray(0, -4)), frame.length - 4);
  return frame;
}

export function decodeCooldownFrame(source) {
  const frame = Buffer.from(source ?? []);
  if (frame.length < FRAME_HEADER_BYTES + 1 + FRAME_TRAILER_BYTES
      || frame.length > FRAME_HEADER_BYTES + COOLDOWN_CARRIER.maxPayloadBytes + FRAME_TRAILER_BYTES
      || !frame.subarray(0, 2).equals(MAGIC) || frame[2] !== COOLDOWN_CARRIER.protocol
      || frame.readUInt32BE(frame.length - 4) !== cooldownCRC(frame.subarray(0, -4))) {
    throw new Error('Cooldown carrier header or checksum');
  }
  const length = frame.readUInt16BE(26);
  if (frame.length !== FRAME_HEADER_BYTES + length + FRAME_TRAILER_BYTES) throw new Error('Cooldown carrier length');
  const decoded = {
    epoch: frame.toString('hex', 4, 8), nonce: frame.toString('hex', 8, 12),
    uiNonce: frame.toString('hex', 12, 16), seq: u24(frame, 16), message: u24(frame, 19),
    part: frame[22], count: frame[23], slot: frame.readUInt16BE(24), kind: CODE_TO_KIND[frame[3]],
    payload: frame.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + length),
  };
  if (!encodeCooldownFrame(decoded).equals(frame)) throw new Error('Noncanonical cooldown carrier frame');
  return decoded;
}

export function encodeCooldownContext({ id, text }) {
  const body = Buffer.from(typeof text === 'string' ? text : '', 'utf8');
  // The context lane shares the 18-bit id space the context cache accepts, as input already does.
  if (!Number.isInteger(id) || id < 1 || id > 262143 || !body.length
      || body.length + 4 > COOLDOWN_CARRIER.maxMessageBytes) throw new Error('Invalid cooldown context');
  const head = Buffer.alloc(4);
  head.write('C', 0, 'ascii');
  head.writeUIntBE(id, 1, 3);
  return Buffer.concat([head, body]);
}

export function decodeCooldownApplication(source, kind) {
  const payload = Buffer.from(source ?? []);
  if (kind === 'context') {
    if (payload.length < 5 || payload.length > COOLDOWN_CARRIER.maxMessageBytes
        || payload.toString('ascii', 0, 1) !== 'C') throw new Error('Invalid cooldown context');
    const id = u24(payload, 1), text = utf8.decode(payload.subarray(4));
    if (id < 1 || id > 262143) throw new Error('Invalid cooldown context');
    return { kind, id, text };
  }
  // Context is the only application payload this lane carries; a heartbeat has no body to decode.
  throw new Error('Unknown cooldown application kind');
}

class CborMap {
  constructor(entries) { this.entries = entries; }
  getNumber(key) { return this.entries.find(([candidate]) => candidate === key)?.[1]; }
  numericKeys() { return this.entries.map(([key]) => key); }
}

function scalarKey(value) {
  if (typeof value === 'number') return `n:${Object.is(value, -0) ? '-0' : value}`;
  if (typeof value === 'string') return `s:${value}`;
  if (Buffer.isBuffer(value)) return `b:${value.toString('hex')}`;
  if (typeof value === 'boolean') return `o:${value}`;
  if (value === null) return 'z:';
  throw new Error('Unsupported CBOR map key');
}

class CborDecoder {
  constructor(source) { this.source = source; this.offset = 0; this.nodes = 0; }
  take(length) {
    if (!integer(length, 0, COOLDOWN_CARRIER.maxCborBytes) || this.offset + length > this.source.length)
      throw new Error('Truncated CBOR payload');
    const value = this.source.subarray(this.offset, this.offset + length); this.offset += length; return value;
  }
  length(additional) {
    let value;
    if (additional < 24) return additional;
    if (additional === 24) value = this.take(1).readUInt8(0);
    else if (additional === 25) value = this.take(2).readUInt16BE(0);
    else if (additional === 26) value = this.take(4).readUInt32BE(0);
    else if (additional === 27) {
      const high = this.take(4).readUInt32BE(0), low = this.take(4).readUInt32BE(0);
      value = high * 0x100000000 + low;
      if (!Number.isSafeInteger(value)) throw new Error('CBOR integer exceeds safe range');
    } else throw new Error('Indefinite or reserved CBOR length');
    if ((additional === 24 && value < 24) || (additional === 25 && value <= 0xff)
        || (additional === 26 && value <= 0xffff) || (additional === 27 && value <= 0xffffffff))
      throw new Error('Noncanonical CBOR integer or length');
    return value;
  }
  read(depth = 0) {
    if (++this.nodes > COOLDOWN_CARRIER.maxCborNodes || depth > COOLDOWN_CARRIER.maxCborDepth)
      throw new Error('CBOR structure exceeds bounds');
    const initial = this.take(1)[0], major = initial >>> 5, additional = initial & 31;
    if (major === 0) return this.length(additional);
    if (major === 1) return -1 - this.length(additional);
    if (major === 2) return Buffer.from(this.take(this.length(additional)));
    if (major === 3) return utf8.decode(this.take(this.length(additional)));
    if (major === 4) {
      const length = this.length(additional);
      if (length > COOLDOWN_CARRIER.maxCollectionEntries) throw new Error('CBOR array exceeds bounds');
      return Array.from({ length }, () => this.read(depth + 1));
    }
    if (major === 5) {
      const length = this.length(additional), entries = [], keys = new Set();
      if (length > COOLDOWN_CARRIER.maxCollectionEntries) throw new Error('CBOR map exceeds bounds');
      for (let index = 0; index < length; index++) {
        const key = this.read(depth + 1), identity = scalarKey(key);
        if (keys.has(identity)) throw new Error('Duplicate CBOR map key');
        keys.add(identity); entries.push([key, this.read(depth + 1)]);
      }
      return new CborMap(entries);
    }
    if (major === 7 && additional === 20) return false;
    if (major === 7 && additional === 21) return true;
    if (major === 7 && additional === 22) return null;
    if (major === 7 && additional === 25) {
      const bits = this.take(2).readUInt16BE(0), sign = bits >>> 15 ? -1 : 1;
      const exponent = (bits >>> 10) & 31, fraction = bits & 1023;
      const value = exponent === 0 ? sign * 2 ** -14 * (fraction / 1024)
        : exponent === 31 ? (fraction ? Number.NaN : sign * Number.POSITIVE_INFINITY)
          : sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
      if (!Number.isFinite(value)) throw new Error('Nonfinite CBOR number');
      return value;
    }
    if (major === 7 && additional === 26) {
      const value = this.take(4).readFloatBE(0); if (!Number.isFinite(value)) throw new Error('Nonfinite CBOR number'); return value;
    }
    if (major === 7 && additional === 27) {
      const value = this.take(8).readDoubleBE(0); if (!Number.isFinite(value)) throw new Error('Nonfinite CBOR number'); return value;
    }
    throw new Error('Unsupported CBOR type');
  }
}

function inflateExact(compressed) {
  const attempts = [];
  for (const inflate of [inflateSync, inflateRawSync]) {
    try {
      const result = inflate(compressed, { info: true, maxOutputLength: COOLDOWN_CARRIER.maxCborBytes });
      if (result.engine.bytesWritten !== compressed.length) throw new Error('Deflate stream has trailing bytes');
      return result.buffer;
    } catch (error) { attempts.push(error); }
  }
  throw new Error(`Invalid bounded Deflate stream: ${attempts.at(-1)?.message ?? 'decode failed'}`);
}

function collectionOrMissing(value) {
  return value === undefined || value instanceof CborMap || (Array.isArray(value) && value.length === 0);
}

export function decodeCooldownLayout(source) {
  const raw = Buffer.isBuffer(source) ? source : Buffer.from(source ?? []);
  if (raw.length === 0) return { empty: true, frame: null, layoutVersion: null, cbor: null };
  if (raw.length > COOLDOWN_CARRIER.maxFileBytes) throw new Error('Cooldown layout exceeds file budget');
  const text = raw.toString('ascii');
  if (!Buffer.from(text, 'ascii').equals(raw) || !text.startsWith('1|') || text.indexOf('|', 2) !== -1)
    throw new Error('Cooldown layout envelope');
  const encoded = text.slice(2);
  if (!encoded || encoded.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded))
    throw new Error('Cooldown layout Base64');
  const compressed = Buffer.from(encoded, 'base64');
  if (!compressed.length || compressed.length > COOLDOWN_CARRIER.maxCompressedBytes
      || compressed.toString('base64') !== encoded) throw new Error('Noncanonical cooldown layout Base64');
  const cbor = inflateExact(compressed);
  const decoder = new CborDecoder(cbor), root = decoder.read();
  if (decoder.offset !== cbor.length || !(root instanceof CborMap)) throw new Error('Cooldown layout root');
  const keys = root.numericKeys();
  if (keys.some(key => !integer(key, 1, 127) || ![1, 2, 3, 4, 127].includes(key)))
    throw new Error('Unknown cooldown layout field');
  const version = root.getNumber(1);
  if (!integer(version, COOLDOWN_CARRIER.minLayoutVersion, COOLDOWN_CARRIER.maxLayoutVersion)
      || !collectionOrMissing(root.getNumber(2)) || !collectionOrMissing(root.getNumber(3))
      || !collectionOrMissing(root.getNumber(4))) throw new Error('Unsupported cooldown layout shape');
  const marker = root.getNumber(127);
  if (marker !== undefined && !Buffer.isBuffer(marker)) throw new Error('Unknown cooldown carrier marker');
  return { empty: false, frame: marker === undefined ? null : decodeCooldownFrame(marker), layoutVersion: version,
    cborBytes: cbor.length, cborNodes: decoder.nodes };
}

async function boundedRead(filename) {
  let handle;
  try { handle = await fs.open(filename, 'r'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > COOLDOWN_CARRIER.maxFileBytes) throw new Error('Invalid cooldown layout file');
    const output = Buffer.alloc(stat.size), { bytesRead } = await handle.read(output, 0, output.length, 0);
    if (bytesRead !== output.length) throw new Error('Short cooldown layout read');
    return output;
  } finally { await handle.close(); }
}

export async function readStableCooldownLayout(filename, { read = boundedRead,
  delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)), delayMs = 50 } = {}) {
  const first = await read(filename); await delay(delayMs); const second = await read(filename);
  if (first === null || second === null) return first === second ? null : undefined;
  if (!Buffer.from(first).equals(Buffer.from(second))) return undefined;
  return decodeCooldownLayout(second);
}

export function cooldownLayoutFilename(characterDir) {
  if (typeof characterDir !== 'string' || !path.isAbsolute(characterDir))
    throw new TypeError('Explicit absolute character cache directory required');
  const resolved = path.resolve(characterDir);
  if (path.basename(resolved).toLowerCase() === COOLDOWN_CARRIER.filename)
    throw new TypeError('Pass the character directory, not a filename');
  return path.join(resolved, COOLDOWN_CARRIER.filename);
}

export class CooldownCarrierReceiver {
  // uiNonce null adopts the UI session of the first frame whose cursor the host accepts.
  constructor({ epoch, nonce, uiNonce = null, onMessage, onCursor = () => true, now = Date.now } = {}) {
    if (!hex8(epoch) || !hex8(nonce) || (uiNonce !== null && !hex8(uiNonce)) || typeof onMessage !== 'function'
        || typeof onCursor !== 'function') throw new TypeError('Fresh cooldown carrier session and data consumer required');
    Object.assign(this, { epoch, nonce, uiNonce, onMessage, onCursor, now, ack: 0, message: 0,
      pending: null, last: null, lastChecksum: null, busy: false });
  }
  async accept(input) {
    const wire = encodeCooldownFrame(input), frame = decodeCooldownFrame(wire);
    const reject = reason => ({ accepted: false, reason, ack: this.ack, checksum: this.lastChecksum });
    if (this.busy) return reject('busy');
    // Every frame advertises the addon's ring demand, before any session or sequence rule: a frame
    // from another UI session is how the host learns of the reload, as on the binding lane.
    const heartbeat = frame.kind === 'heartbeat', flags = heartbeat ? frame.payload[0] : 0;
    const followed = await this.onCursor({ uiNonce: frame.uiNonce, nextSeq: frame.slot,
      combat: Boolean(flags & HEARTBEAT_COMBAT), reload: Boolean(flags & HEARTBEAT_RELOAD) }) === true;
    // A heartbeat exists only to move the cursor, so a refused one is refused outright, and adopting
    // a UI session always needs a cursor the host followed or a retired UI's stale frame would claim
    // this receiver. Once the session is adopted the cursor is best effort on a data frame: its slot
    // may already be behind because another lane moved it, and refusing there would strand a message
    // the addon cannot send again at that sequence.
    if (!followed && (heartbeat || this.uiNonce === null)) return reject('cursor');
    const bootstrap = heartbeat && frame.epoch === ZERO && frame.nonce === ZERO;
    if ((!bootstrap && (frame.epoch !== this.epoch || frame.nonce !== this.nonce))
        || (this.uiNonce !== null && frame.uiNonce !== this.uiNonce)) return reject('session');
    this.uiNonce ??= frame.uiNonce;
    if (heartbeat) {
      // A heartbeat is current when it names the addon's next data sequence; it neither advances
      // the acknowledgement nor becomes the frame the addon must repeat.
      if (frame.seq !== this.ack + 1 && frame.seq !== this.ack) return reject('sequence');
      return { accepted: true, heartbeat: true, ack: this.ack, checksum: this.lastChecksum };
    }
    const fingerprint = wire.toString('hex'), checksum = wire.readUInt32BE(wire.length - 4);
    if (frame.seq === this.ack) {
      // A different frame at an acknowledged sequence is a sender that restarted without seeing the
      // acknowledgement. Refusing keeps the poll loop quiet and lets it resync from the published ack.
      if (fingerprint !== this.last) return reject('mutation');
      return { accepted: true, duplicate: true, ack: this.ack, checksum: this.lastChecksum };
    }
    if (frame.seq !== this.ack + 1) return reject('sequence');
    if (this.pending && this.now() - this.pending.started > COOLDOWN_CARRIER.ttlMs) return reject('expired');
    // A first part at the next sequence number is a sender starting a message, whether or not a
    // fragment was pending: a restarted sender reuses its unfinished number, and one that never
    // saw a completion ACK reuses the completed one. Either abandons the old fragment.
    const restart = frame.part === 1 && (frame.message === this.message + 1 || frame.message === this.message);
    const pending = (restart || !this.pending) ? { message: restart ? frame.message : this.message + 1, count: frame.count,
      kind: frame.kind, chunks: [], bytes: 0, started: this.now() } : this.pending;
    if (frame.message !== pending.message || frame.count !== pending.count || frame.kind !== pending.kind
        || frame.part !== pending.chunks.length + 1) return reject('fragment order');
    if (pending.bytes + frame.payload.length > COOLDOWN_CARRIER.maxMessageBytes) return reject('message budget');
    const chunks = [...pending.chunks, Buffer.from(frame.payload)];
    this.busy = true;
    try {
      if (frame.part === frame.count) {
        const message = decodeCooldownApplication(Buffer.concat(chunks), frame.kind);
        const outcome = await this.onMessage(message, { kind: frame.kind, epoch: frame.epoch,
          uiNonce: frame.uiNonce, message: frame.message });
        if (outcome !== true) return reject('application');
        this.message = frame.message; this.pending = null;
      } else this.pending = { ...pending, chunks, bytes: pending.bytes + frame.payload.length };
      this.ack = frame.seq; this.last = fingerprint; this.lastChecksum = checksum;
      return { accepted: true, ack: this.ack, checksum };
    } finally { this.busy = false; }
  }
}

export class CooldownCarrierReader {
  constructor({ characterDir, receiver, read = readStableCooldownLayout, pollMs = 250,
    onError = () => {}, onResult = () => {} } = {}) {
    if (!(receiver instanceof CooldownCarrierReceiver)) throw new TypeError('Cooldown carrier receiver required');
    Object.assign(this, { filename: cooldownLayoutFilename(characterDir), receiver, read, pollMs, onError, onResult,
      busy: false, stopped: false, last: null });
  }
  async poll() {
    if (this.busy || this.stopped) return null;
    this.busy = true;
    try {
      const layout = await this.read(this.filename);
      if (layout === undefined || layout === null || !layout.frame) return null;
      const fingerprint = encodeCooldownFrame(layout.frame).toString('hex');
      if (fingerprint === this.last) return this.report({ accepted: true, duplicatePoll: true, ack: this.receiver.ack,
        checksum: this.receiver.lastChecksum }, layout.frame);
      const result = await this.receiver.accept(layout.frame);
      if (result.accepted) this.last = fingerprint;
      return this.report(result, layout.frame, fingerprint);
    } finally { this.busy = false; }
  }
  report(result, frame, fingerprint) { this.onResult(result, frame, fingerprint); return result; }
  // An unreadable layout is reported and retried; it must never escape the interval and kill polling.
  async tick() {
    try { return await this.poll(); }
    catch (error) { if (!this.stopped) this.onError(error); return null; }
  }
  async start() {
    await this.tick();
    if (this.stopped) return;
    this.timer = setInterval(() => { void this.tick(); }, this.pollMs);
    this.timer.unref?.();
  }
  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    while (this.busy) await new Promise(resolve => setTimeout(resolve, 5));
  }
}
