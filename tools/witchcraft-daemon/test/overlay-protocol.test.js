import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_OVERLAY_CLIPBOARD_BYTES,
  MAX_OVERLAY_OUTPUT_BYTES,
  OVERLAY_PROTOCOL_VERSION,
  OverlayProtocolError,
  createOverlaySessionId,
  encodeOverlayRecord,
  splitOverlayOutput,
  validateChildMessage,
  validateHostMessage,
} from '../src/overlay-protocol.js';

const child = (type, seq, payload) => ({ v: OVERLAY_PROTOCOL_VERSION, type, seq, payload });
const host = (type, seq, payload) => ({ v: OVERLAY_PROTOCOL_VERSION, type, seq, payload });

test('overlay protocol: child commands are canonical, exact, and tab allowlisted', () => {
  assert.deepEqual(validateChildMessage(child('input', 4, { tab: 'codex', data: 'hello' })), child('input', 4, { tab: 'codex', data: 'hello' }));
  assert.throws(() => validateChildMessage(child('input', 4, { tab: 'other', data: 'hello' })), error => error.code === 'INVALID_TAB');
  assert.throws(() => validateChildMessage({ ...child('select', 5, { tab: 'claude' }), token: 'not-used' }), error => error.code === 'UNKNOWN_FIELD');
  assert.throws(() => validateChildMessage(child('resize', 6, { cols: 999, rows: 40 })), /out of range/u);
  assert.deepEqual(validateChildMessage(child('resize', 6, { cols: 160, rows: 60 })).payload, { cols: 160, rows: 60 });
  assert.throws(() => validateChildMessage(child('resize', 6, { cols: 161, rows: 60 })), /out of range/u);
  assert.throws(() => validateChildMessage(child('resize', 6, { cols: 160, rows: 61 })), /out of range/u);
  assert.throws(() => validateChildMessage(child('hello', 1, { role: 'electron-overlay', pid: 123 })), /sequence 0/u);
});

test('overlay protocol: clipboard is bounded text and host state is an ordered two-tab snapshot', () => {
  const clipboard = child('clipboard', 1, { text: 'FAMCLIP1|opaque' });
  assert.deepEqual(validateChildMessage(clipboard), clipboard);
  assert.throws(() => validateChildMessage(child('clipboard', 1, { text: 'x'.repeat(MAX_OVERLAY_CLIPBOARD_BYTES + 1) })), /byte bound/u);
  const payload = { authoritative: true, generation: 2, activeTab: 'claude', cols: 120, rows: 40,
    sessions: [
      { id: 'claude', title: 'Claude', status: 'running', lines: ['one'] },
      { id: 'codex', title: 'Codex', status: 'running', lines: ['two'] },
      { id: 'copilot', title: 'Copilot', status: 'not started', lines: [] },
    ] };
  assert.deepEqual(validateHostMessage(host('state', 3, payload)).payload, payload);
  const reversed = { ...payload, sessions: [...payload.sessions].reverse() };
  assert.throws(() => validateHostMessage(host('state', 3, reversed)), /ordered claude, codex/u);
  assert.throws(() => validateHostMessage(host('state', 3, { ...payload, injected: true })), error => error.code === 'UNKNOWN_FIELD');
  // The pane width can reach 240 columns, the renderer's own bound.
  assert.equal(validateHostMessage(host('state', 3, { ...payload, cols: 240 })).payload.cols, 240);
  assert.throws(() => validateHostMessage(host('state', 3, { ...payload, cols: 241 })), /out of range/u);
});

test('overlay protocol: serialized record and terminal stream byte bounds use UTF-8 bytes', () => {
  const data = '🌕'.repeat(Math.ceil(MAX_OVERLAY_OUTPUT_BYTES / 4) + 7);
  const parts = splitOverlayOutput(data);
  assert.equal(parts.join(''), data);
  assert.ok(parts.length > 1);
  assert.ok(parts.every(part => Buffer.byteLength(part, 'utf8') <= MAX_OVERLAY_OUTPUT_BYTES));
  assert.ok(parts.every(part => !part.includes('\ufffd')));
  const hugeState = host('state', 1, { authoritative: true, generation: 1, activeTab: 'claude', cols: 120, rows: 60,
    sessions: [
      { id: 'claude', title: 'Claude', status: 'running', lines: Array(100).fill('x'.repeat(4000)) },
      { id: 'codex', title: 'Codex', status: 'running', lines: Array(100).fill('x'.repeat(4000)) },
      { id: 'copilot', title: 'Copilot', status: 'not started', lines: [] },
    ] });
  assert.throws(() => encodeOverlayRecord(hugeState, 'host'), error => error.code === 'RECORD_TOO_LARGE');
  // Three populated tabs, each at the host's allowance of 48 KiB of lines and 64 KiB of ANSI, still fit.
  const full = (id, title) => ({ id, title, status: 'running', lines: Array(6).fill('x'.repeat(7900)), ansi: 'x'.repeat(64 * 1024) });
  const fullState = host('state', 2, { authoritative: true, generation: 1, activeTab: 'claude', cols: 120, rows: 40,
    sessions: [full('claude', 'Claude'), full('codex', 'Codex'), full('copilot', 'Copilot')] });
  assert.ok(encodeOverlayRecord(fullState, 'host').bytes > 256 * 1024);
});

test('overlay protocol: per-run identifiers are non-secret, bounded identifiers', () => {
  const first = createOverlaySessionId(), second = createOverlaySessionId();
  assert.match(first, /^[A-Za-z0-9_-]{24}$/u);
  assert.notEqual(first, second);
  assert.ok(new OverlayProtocolError('TEST', 'message') instanceof Error);
});
