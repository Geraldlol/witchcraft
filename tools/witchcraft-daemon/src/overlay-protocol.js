import { randomBytes } from 'node:crypto';

/** @typedef {'claude' | 'codex'} OverlayTab */
/** @typedef {'hello' | 'input' | 'clipboard' | 'resize' | 'select' | 'ping' | 'resync' | 'disconnect'} ChildMessageType */
/** @typedef {'ready' | 'state' | 'output' | 'status' | 'error' | 'pong' | 'shutdown'} HostMessageType */

export const OVERLAY_PROTOCOL_VERSION = 1;
export const OVERLAY_TABS = Object.freeze(['claude', 'codex']);
export const MAX_OVERLAY_RECORD_BYTES = 256 * 1024;
export const MAX_OVERLAY_PENDING_BYTES = 512 * 1024;
export const MAX_OVERLAY_PENDING_RECORDS = 64;
export const MAX_OVERLAY_INPUT_BYTES = 16 * 1024;
export const MAX_OVERLAY_OUTPUT_BYTES = 64 * 1024;
export const MAX_OVERLAY_CLIPBOARD_BYTES = 64 * 1024;
export const MAX_OVERLAY_LINES = 100;
export const MAX_OVERLAY_LINE_BYTES = 8 * 1024;
export const MAX_OVERLAY_SERIALIZED_BYTES = 96 * 1024;

const CHILD_TYPES = new Set(['hello', 'input', 'clipboard', 'resize', 'select', 'ping', 'resync', 'disconnect']);
const HOST_TYPES = new Set(['ready', 'state', 'output', 'status', 'error', 'pong', 'shutdown']);
const LIFECYCLES = new Set(['starting', 'syncing', 'ready', 'stopping', 'stopped']);
const TAB_SET = new Set(OVERLAY_TABS);

export class OverlayProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'OverlayProtocolError';
    this.code = code;
  }
}

function fail(code, message) { throw new OverlayProtocolError(code, message); }
function isObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function object(value, label) {
  if (!isObject(value)) fail('INVALID_SHAPE', `${label} must be an object`);
  return value;
}
function exactKeys(value, required, optional = [], label = 'object') {
  const keys = Object.keys(value).sort();
  const allowed = new Set([...required, ...optional]);
  for (const key of required) if (!Object.hasOwn(value, key)) fail('INVALID_SHAPE', `${label}.${key} is required`);
  for (const key of keys) if (!allowed.has(key)) fail('UNKNOWN_FIELD', `${label}.${key} is not allowed`);
}
function integer(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail('INVALID_VALUE', `${label} is out of range`);
  return value;
}
function boolean(value, label) {
  if (typeof value !== 'boolean') fail('INVALID_VALUE', `${label} must be boolean`);
  return value;
}
function string(value, maxBytes, label, { minBytes = 0, pattern } = {}) {
  if (typeof value !== 'string') fail('INVALID_VALUE', `${label} must be a string`);
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes < minBytes || bytes > maxBytes) fail('INVALID_VALUE', `${label} exceeds its byte bound`);
  if (pattern && !pattern.test(value)) fail('INVALID_VALUE', `${label} has an invalid format`);
  return value;
}
function tab(value, label = 'tab') {
  if (!TAB_SET.has(value)) fail('INVALID_TAB', `${label} must be claude or codex`);
  return value;
}
function payloadOf(envelope) {
  return object(envelope.payload, `${envelope.type} payload`);
}
function boundedSeq(value, { hello = false } = {}) {
  return integer(value, hello ? 0 : 1, Number.MAX_SAFE_INTEGER, 'message.seq');
}

function baseEnvelope(value, allowedTypes, direction) {
  const envelope = object(value, `${direction} message`);
  exactKeys(envelope, ['v', 'type', 'seq', 'payload'], [], `${direction} message`);
  if (envelope.v !== OVERLAY_PROTOCOL_VERSION) fail('UNSUPPORTED_VERSION', `Unsupported overlay protocol version ${String(envelope.v)}`);
  if (typeof envelope.type !== 'string' || !allowedTypes.has(envelope.type)) fail('UNKNOWN_TYPE', `Unknown ${direction} message type`);
  return envelope;
}

function validateHello(envelope) {
  boundedSeq(envelope.seq, { hello: true });
  if (envelope.seq !== 0) fail('INVALID_SEQUENCE', 'hello must use sequence 0');
  const payload = payloadOf(envelope);
  exactKeys(payload, ['role', 'pid'], [], 'hello payload');
  if (payload.role !== 'electron-overlay') fail('INVALID_ROLE', 'hello role is not allowed');
  return { v: OVERLAY_PROTOCOL_VERSION, type: 'hello', seq: 0,
    payload: { role: 'electron-overlay', pid: integer(payload.pid, 1, 0x7fffffff, 'hello payload.pid') } };
}

/** Validate and return a canonical child-to-host message. */
export function validateChildMessage(value) {
  const envelope = baseEnvelope(value, CHILD_TYPES, 'child');
  if (envelope.type === 'hello') return validateHello(envelope);
  const seq = boundedSeq(envelope.seq), payload = payloadOf(envelope);
  switch (envelope.type) {
    case 'input':
      exactKeys(payload, ['tab', 'data'], [], 'input payload');
      return { v: OVERLAY_PROTOCOL_VERSION, type: 'input', seq,
        payload: { tab: tab(payload.tab), data: string(payload.data, MAX_OVERLAY_INPUT_BYTES, 'input payload.data', { minBytes: 1 }) } };
    case 'clipboard':
      exactKeys(payload, ['text'], [], 'clipboard payload');
      return { v: OVERLAY_PROTOCOL_VERSION, type: 'clipboard', seq,
        payload: { text: string(payload.text, MAX_OVERLAY_CLIPBOARD_BYTES, 'clipboard payload.text', { minBytes: 9 }) } };
    case 'resize':
      exactKeys(payload, ['cols', 'rows'], [], 'resize payload');
      return { v: OVERLAY_PROTOCOL_VERSION, type: 'resize', seq,
        payload: { cols: integer(payload.cols, 40, 160, 'resize payload.cols'), rows: integer(payload.rows, 10, 60, 'resize payload.rows') } };
    case 'select':
      exactKeys(payload, ['tab'], [], 'select payload');
      return { v: OVERLAY_PROTOCOL_VERSION, type: 'select', seq, payload: { tab: tab(payload.tab) } };
    case 'ping':
      exactKeys(payload, ['nonce'], [], 'ping payload');
      return { v: OVERLAY_PROTOCOL_VERSION, type: 'ping', seq,
        payload: { nonce: string(payload.nonce, 64, 'ping payload.nonce') } };
    case 'resync':
      exactKeys(payload, ['generation'], [], 'resync payload');
      return { v: OVERLAY_PROTOCOL_VERSION, type: 'resync', seq,
        payload: { generation: integer(payload.generation, 0, Number.MAX_SAFE_INTEGER, 'resync payload.generation') } };
    case 'disconnect':
      exactKeys(payload, [], ['reason'], 'disconnect payload');
      return { v: OVERLAY_PROTOCOL_VERSION, type: 'disconnect', seq, payload: {
        ...(payload.reason === undefined ? {} : { reason: string(payload.reason, 128, 'disconnect payload.reason') }),
      } };
    default: return fail('UNKNOWN_TYPE', 'Unknown child message type');
  }
}

function validateSession(value, index) {
  const session = object(value, `state payload.sessions[${index}]`);
  exactKeys(session, ['id', 'title', 'status', 'lines'], ['ansi'], `state payload.sessions[${index}]`);
  if (!Array.isArray(session.lines) || session.lines.length > MAX_OVERLAY_LINES) {
    fail('INVALID_VALUE', `state payload.sessions[${index}].lines exceeds its row bound`);
  }
  const lines = session.lines.map((line, lineIndex) => string(line, MAX_OVERLAY_LINE_BYTES,
    `state payload.sessions[${index}].lines[${lineIndex}]`));
  return { id: tab(session.id, `state payload.sessions[${index}].id`),
    title: string(session.title, 32, `state payload.sessions[${index}].title`, { minBytes: 1 }),
    status: string(session.status, 128, `state payload.sessions[${index}].status`, { minBytes: 1 }), lines,
    ...(session.ansi === undefined ? {} : {
      ansi: string(session.ansi, MAX_OVERLAY_SERIALIZED_BYTES, `state payload.sessions[${index}].ansi`),
    }) };
}

function validateStatePayload(payload) {
  exactKeys(payload, ['authoritative', 'generation', 'activeTab', 'cols', 'rows', 'sessions'], [], 'state payload');
  if (!Array.isArray(payload.sessions) || payload.sessions.length !== OVERLAY_TABS.length) {
    fail('INVALID_VALUE', 'state payload.sessions must contain exactly two terminals');
  }
  const sessions = payload.sessions.map(validateSession);
  if (sessions.some((session, index) => session.id !== OVERLAY_TABS[index])) {
    fail('INVALID_VALUE', 'state payload.sessions must be ordered claude, codex');
  }
  return { authoritative: boolean(payload.authoritative, 'state payload.authoritative'),
    generation: integer(payload.generation, 1, Number.MAX_SAFE_INTEGER, 'state payload.generation'),
    activeTab: tab(payload.activeTab, 'state payload.activeTab'),
    cols: integer(payload.cols, 40, 240, 'state payload.cols'), rows: integer(payload.rows, 10, 60, 'state payload.rows'), sessions };
}

/** Validate and return a canonical host-to-child message. */
export function validateHostMessage(value) {
  const envelope = baseEnvelope(value, HOST_TYPES, 'host');
  const seq = boundedSeq(envelope.seq), payload = payloadOf(envelope);
  switch (envelope.type) {
    case 'ready': {
      exactKeys(payload, ['sessionId', 'tabs', 'activeTab', 'lifecycle'], [], 'ready payload');
      if (!Array.isArray(payload.tabs) || payload.tabs.length !== 2 || payload.tabs.some((value, index) => value !== OVERLAY_TABS[index])) {
        fail('INVALID_VALUE', 'ready payload.tabs must be ordered claude, codex');
      }
      if (payload.lifecycle !== 'syncing') fail('INVALID_VALUE', 'ready payload.lifecycle must be syncing');
      return { v: OVERLAY_PROTOCOL_VERSION, type: 'ready', seq, payload: {
        sessionId: string(payload.sessionId, 64, 'ready payload.sessionId', { minBytes: 8, pattern: /^[A-Za-z0-9_-]+$/u }),
        tabs: [...OVERLAY_TABS], activeTab: tab(payload.activeTab, 'ready payload.activeTab'), lifecycle: 'syncing',
      } };
    }
    case 'state':
      return { v: OVERLAY_PROTOCOL_VERSION, type: 'state', seq, payload: validateStatePayload(payload) };
    case 'output':
      exactKeys(payload, ['tab', 'data', 'generation'], [], 'output payload');
      return { v: OVERLAY_PROTOCOL_VERSION, type: 'output', seq, payload: {
        tab: tab(payload.tab, 'output payload.tab'), data: string(payload.data, MAX_OVERLAY_OUTPUT_BYTES, 'output payload.data', { minBytes: 1 }),
        generation: integer(payload.generation, 1, Number.MAX_SAFE_INTEGER, 'output payload.generation'),
      } };
    case 'status':
      exactKeys(payload, ['tab', 'status', 'generation'], [], 'status payload');
      return { v: OVERLAY_PROTOCOL_VERSION, type: 'status', seq, payload: {
        tab: tab(payload.tab, 'status payload.tab'), status: string(payload.status, 128, 'status payload.status', { minBytes: 1 }),
        generation: integer(payload.generation, 1, Number.MAX_SAFE_INTEGER, 'status payload.generation'),
      } };
    case 'error':
      exactKeys(payload, ['code', 'message'], ['requestSeq'], 'error payload');
      return { v: OVERLAY_PROTOCOL_VERSION, type: 'error', seq, payload: {
        code: string(payload.code, 64, 'error payload.code', { minBytes: 1, pattern: /^[A-Z][A-Z0-9_]*$/u }),
        message: string(payload.message, 256, 'error payload.message', { minBytes: 1 }),
        ...(payload.requestSeq === undefined ? {} : { requestSeq: integer(payload.requestSeq, 1, Number.MAX_SAFE_INTEGER, 'error payload.requestSeq') }),
      } };
    case 'pong':
      exactKeys(payload, ['nonce'], [], 'pong payload');
      return { v: OVERLAY_PROTOCOL_VERSION, type: 'pong', seq, payload: { nonce: string(payload.nonce, 64, 'pong payload.nonce') } };
    case 'shutdown':
      exactKeys(payload, ['reason'], [], 'shutdown payload');
      return { v: OVERLAY_PROTOCOL_VERSION, type: 'shutdown', seq,
        payload: { reason: string(payload.reason, 128, 'shutdown payload.reason', { minBytes: 1 }) } };
    default: return fail('UNKNOWN_TYPE', 'Unknown host message type');
  }
}

/** Validate, canonicalize, and enforce the serialized record cap. */
export function encodeOverlayRecord(value, direction) {
  const message = direction === 'child' ? validateChildMessage(value)
    : direction === 'host' ? validateHostMessage(value)
      : fail('INVALID_DIRECTION', 'Overlay message direction must be child or host');
  const serialized = JSON.stringify(message);
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes > MAX_OVERLAY_RECORD_BYTES) fail('RECORD_TOO_LARGE', 'Overlay IPC record exceeds its byte bound');
  return { message, bytes };
}

/** Generate a non-secret identifier for one spawned overlay lifetime. */
export function createOverlaySessionId(random = randomBytes) {
  return random(18).toString('base64url');
}

/** Split a terminal stream without cutting a UTF-8 code point. */
export function splitOverlayOutput(value, maxBytes = MAX_OVERLAY_OUTPUT_BYTES) {
  if (typeof value !== 'string') fail('INVALID_VALUE', 'Terminal output must be a string');
  integer(maxBytes, 1, MAX_OVERLAY_OUTPUT_BYTES, 'maxBytes');
  if (!value) return [];
  const parts = [];
  let part = '', bytes = 0;
  for (const codePoint of value) {
    const size = Buffer.byteLength(codePoint, 'utf8');
    if (bytes && bytes + size > maxBytes) { parts.push(part); part = ''; bytes = 0; }
    part += codePoint; bytes += size;
  }
  if (part) parts.push(part);
  return parts;
}

export function isOverlayLifecycle(value) { return LIFECYCLES.has(value); }
