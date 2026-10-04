/** Witchcraft protocol v1. Pure codecs only; acceptance and PTY side effects belong to outbox. */
export const CELL_COUNT = 22;
export const CELL_SIZE = 6;
export const MAX_MESSAGE_ID = 262143;
export const MAX_TEXT_BYTES = 600;
export const MAX_CONTEXT_BYTES = 580;
const SYNC = 51;
const CONTEXT_SYNC = 50;
const ACTIONS = ['text', 'enter', 'interrupt', 'escape', 'up', 'down'];
const TABS = ['claude', 'codex'];
const decoder = new TextDecoder('utf-8', { fatal: true });

const integer = (n, min, max) => Number.isInteger(n) && n >= min && n <= max;
const validEpoch = (s, allowZero = false) => typeof s === 'string' && /^[0-9a-f]{8}$/i.test(s)
  && (allowZero || s !== '00000000');
const checksum = values => values.slice(0, 21).reduce((sum, value, i) => (sum + value * (i + 1)) % 64, 0);
export const valueToRGB = value => [Math.floor(value / 16) * 85, (Math.floor(value / 4) % 4) * 85, (value % 4) * 85];

export function rgbToValue(rgb) {
  if ((!Array.isArray(rgb) && !ArrayBuffer.isView(rgb)) || rgb.length < 3) return null;
  let value = 0;
  for (let i = 0; i < 3; i++) {
    const channel = rgb[i];
    if (!Number.isFinite(channel) || channel < 0 || channel > 255) return null;
    const level = Math.round(channel / 85);
    if (Math.abs(channel - level * 85) > 40) return null;
    value = value * 4 + level;
  }
  return value;
}

function pack(bytes) {
  const values = [];
  let bits = 0, accumulator = 0;
  for (let i = 0; i < 11; i++) {
    accumulator = accumulator * 256 + (bytes[i] ?? 0);
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      values.push(Math.floor(accumulator / 2 ** bits));
      accumulator %= 2 ** bits;
    }
  }
  values.push(accumulator * 2 ** (6 - bits));
  return values;
}

function unpack(values) {
  const bytes = [];
  let bits = 0, accumulator = 0;
  for (const value of values) {
    accumulator = accumulator * 64 + value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push(Math.floor(accumulator / 2 ** bits));
      accumulator %= 2 ** bits;
    }
  }
  return accumulator === 0 ? Uint8Array.from(bytes) : null;
}

function frame(id, index, bytes, final, sync = SYNC) {
  const values = [sync, Math.floor(id / 4096), Math.floor(id / 64) % 64, id % 64,
    index, bytes.length + (final ? 32 : 0), ...pack(bytes)];
  values.push(checksum(values));
  return values.map(valueToRGB);
}

function messageBody(message) {
  if (!message || !validEpoch(message.epoch) || !integer(message.id, 1, MAX_MESSAGE_ID))
    throw new TypeError('A nonzero eight-hex epoch and unexhausted message ID are required');
  const tab = message.tab ?? message.session;
  const action = ACTIONS.indexOf(message.action);
  const text = message.text ?? '';
  if (!TABS.includes(tab) || action < 0 || typeof text !== 'string' || /[\u0000-\u001f\u007f-\u009f]/u.test(text)
    || /[\ud800-\udfff]/u.test(text) || Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES || (action !== 0 && text !== ''))
    throw new TypeError('Invalid tab, action, or bounded control-free UTF-8 text');
  return Buffer.from(message.epoch.toLowerCase() + (TABS.indexOf(tab) + 1) + action + text, 'utf8');
}

export function encodeMessage(message) {
  const body = messageBody(message), frames = [];
  for (let start = 0; start < body.length; start += 11)
    frames.push(frame(message.id, start / 11, body.subarray(start, start + 11), start + 11 >= body.length));
  return frames;
}

function contextBody(message) {
  if (!message || !validEpoch(message.epoch) || !validEpoch(message.uiNonce)
    || !integer(message.id, 1, MAX_MESSAGE_ID) || typeof message.text !== 'string'
    || Buffer.byteLength(message.text, 'utf8') > MAX_CONTEXT_BYTES
    || /[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(message.text))
    throw new TypeError('Invalid bounded context envelope');
  return Buffer.from(message.epoch.toLowerCase() + message.uiNonce.toLowerCase() + message.text, 'utf8');
}

export function encodeContext(message) {
  const body = contextBody(message), frames = [];
  for (let start = 0; start < body.length; start += 11)
    frames.push(frame(message.id, start / 11, body.subarray(start, start + 11), start + 11 >= body.length, CONTEXT_SYNC));
  return frames;
}

export function encodeHeartbeat(epoch, nextSeq, flags = 0, uiNonce = '00000000') {
  if (!validEpoch(epoch, true) || !validEpoch(uiNonce, true) || !integer(nextSeq, 1, 65535) || !integer(flags, 0, 3))
    throw new TypeError('Invalid heartbeat');
  return frame(0, 0, Buffer.concat([Buffer.from(epoch, 'hex'), Buffer.from(uiNonce, 'hex'),
    Buffer.from([nextSeq >> 8, nextSeq & 255, flags])]), true);
}

function decodeWireFrame(cells, sync) {
  if (!Array.isArray(cells) || cells.length !== CELL_COUNT) return null;
  const values = cells.map(rgbToValue);
  if (values.some(v => v === null) || values[0] !== sync || checksum(values) !== values[21]) return null;
  const length = values[5] % 32, final = values[5] >= 32;
  if (length > 11 || (!final && length !== 11)) return null;
  const bytes = unpack(values.slice(6, 21));
  if (!bytes || bytes.subarray(length).some(byte => byte !== 0)) return null;
  return { id: values[1] * 4096 + values[2] * 64 + values[3], index: values[4],
    final, bytes: bytes.slice(0, length) };
}

export const decodeFrame = cells => decodeWireFrame(cells, SYNC);
export const decodeContextFrame = cells => decodeWireFrame(cells, CONTEXT_SYNC);

export function decodeHeartbeat(cells) {
  const decoded = decodeFrame(cells);
  if (!decoded || decoded.id !== 0 || decoded.index !== 0 || !decoded.final || decoded.bytes.length !== 11) return null;
  const epoch = Buffer.from(decoded.bytes.slice(0, 4)).toString('hex');
  const uiNonce = Buffer.from(decoded.bytes.slice(4, 8)).toString('hex');
  const nextSeq = decoded.bytes[8] * 256 + decoded.bytes[9], flags = decoded.bytes[10];
  if (!integer(nextSeq, 1, 65535) || flags > 3) return null;
  return { epoch, uiNonce, nextSeq, flags, combat: (flags & 1) !== 0, reload: (flags & 2) !== 0 };
}

class FrameAssembler {
  constructor({ timeoutMs = 30000, maxPending = 32 } = {}, sync = SYNC, maxBytes = 610) {
    if (!integer(timeoutMs, 1, 60000) || !integer(maxPending, 1, 128)) throw new TypeError('Invalid decoder bounds');
    this.timeoutMs = timeoutMs;
    this.maxPending = maxPending;
    this.pending = new Map();
    this.sync = sync;
    this.maxBytes = maxBytes;
  }
  clear() { this.pending.clear(); }
  assemble(cells, now = Date.now()) {
    if (!Number.isFinite(now)) return null;
    for (const [id, item] of this.pending) if (now < item.started || now - item.started >= this.timeoutMs) this.pending.delete(id);
    const part = decodeWireFrame(cells, this.sync);
    if (!part || part.id === 0) return null;
    let item = this.pending.get(part.id);
    if (!item) {
      if (this.pending.size >= this.maxPending) this.pending.delete(this.pending.keys().next().value);
      item = { started: now, parts: new Map(), final: null, bytes: 0 };
      this.pending.set(part.id, item);
    }
    const old = item.parts.get(part.index);
    if ((old && (old.final !== part.final || !Buffer.from(old.bytes).equals(part.bytes)))
      || (item.final !== null && (part.index > item.final || (part.final && part.index !== item.final)))
      || (part.final && [...item.parts.keys()].some(index => index > part.index))) {
      this.pending.delete(part.id);
      return null;
    }
    if (!old) { item.parts.set(part.index, part); item.bytes += part.bytes.length; }
    if (part.final) item.final = part.index;
    if (item.bytes > this.maxBytes) { this.pending.delete(part.id); return null; }
    if (item.final === null || item.parts.size !== item.final + 1) return null;
    const body = Buffer.concat(Array.from({ length: item.final + 1 }, (_, i) => item.parts.get(i).bytes));
    this.pending.delete(part.id);
    return { body, id: part.id, transportAgeSeconds: Math.max(0, now - item.started) / 1000 };
  }
}

export class PixelDecoder extends FrameAssembler {
  push(cells, now = Date.now()) {
    const assembled = this.assemble(cells, now);
    if (!assembled) return null;
    const { body, id } = assembled;
    if (body.length < 10 || body.length > 610) return null;
    let content;
    try { content = decoder.decode(body); } catch { return null; }
    const message = { epoch: content.slice(0, 8), id, tab: TABS[Number(content[8]) - 1],
      action: ACTIONS[Number(content[9])], text: content.slice(10) };
    try { if (!messageBody(message).equals(body)) return null; } catch { return null; }
    return message;
  }
}

export class ContextDecoder extends FrameAssembler {
  constructor(options) { super(options, CONTEXT_SYNC, 596); }
  push(cells, now = Date.now()) {
    const assembled = this.assemble(cells, now);
    if (!assembled) return null;
    const { body, id } = assembled;
    if (body.length < 16 || body.length > 596) return null;
    let content;
    try { content = decoder.decode(body); } catch { return null; }
    const message = { kind: 'context', epoch: content.slice(0, 8), uiNonce: content.slice(8, 16), id, text: content.slice(16) };
    try { if (!contextBody(message).equals(body)) return null; } catch { return null; }
    // A first captured frame may come from a repeated sender cycle. Lua renews
    // the static body at 30 seconds; charge that full allowance so cache age
    // remains conservative even when earlier complete cycles were missed.
    message.transportAgeSeconds = assembled.transportAgeSeconds + 30;
    return message;
  }
}

export function calibrationCells() {
  const colors = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255], [0, 0, 0]];
  for (let i = 0; i < 16; i++) colors.push([(i % 4) * 85, Math.floor(i / 4) * 85, ((i + 1) % 4) * 85]);
  colors.push([255, 0, 255]);
  return colors;
}

function validImage(image) {
  return image && integer(image.width, 1, 16384) && integer(image.height, 1, 16384)
    && image.width * image.height <= 67108864 && (Buffer.isBuffer(image.data) || image.data instanceof Uint8Array)
    && image.data.length === image.width * image.height * 4;
}

export function sampleFrame(image, { x = 0, y = 0, cellSize = CELL_SIZE, row = 0 } = {}) {
  if (!validImage(image) || !integer(cellSize, 1, 32) || !integer(x, 0, image.width) || !integer(y, 0, image.height)
    || !integer(row, 0, 1) || x + CELL_COUNT * cellSize > image.width || y + (row + 1) * cellSize > image.height) return null;
  return Array.from({ length: CELL_COUNT }, (_, i) => {
    const offset = ((y + row * cellSize + Math.floor(cellSize / 2)) * image.width + x + i * cellSize + Math.floor(cellSize / 2)) * 4;
    return [...image.data.subarray(offset, offset + 3)];
  });
}

export function calibrate(image) {
  if (!validImage(image)) return null;
  const expected = calibrationCells().map(rgbToValue), size = CELL_SIZE;
  // Scan a single center per possible anchor, then require the entire proven header.
  for (let y = 0; y <= image.height - size * 2; y++) {
    for (let x = 0; x <= image.width - CELL_COUNT * size; x++) {
      const offset = ((y + 3) * image.width + x + 3) * 4;
      if (rgbToValue(image.data.subarray(offset, offset + 3)) !== expected[0]) continue;
      const cells = sampleFrame(image, { x, y });
      if (!cells.every((rgb, i) => rgbToValue(rgb) === expected[i])) continue;
      // Solid corners distinguish the true anchor from one-pixel partial overlaps.
      if (![0, size - 1].every(dy => [0, size - 1].every(dx => expected.every((value, i) => {
        const p = ((y + dy) * image.width + x + i * size + dx) * 4;
        return rgbToValue(image.data.subarray(p, p + 3)) === value;
      })))) continue;
      return { x, y, width: CELL_COUNT * size, height: size * 2, cellSize: size };
    }
  }
  return null;
}
