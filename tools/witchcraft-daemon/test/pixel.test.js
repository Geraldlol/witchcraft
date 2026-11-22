import test from 'node:test';
import assert from 'node:assert/strict';
import { PixelDecoder, encodeMessage, encodeHeartbeat, decodeFrame, decodeHeartbeat, rgbToValue, valueToRGB,
  calibrationCells, sampleFrame, calibrate } from '../src/pixel.js';

const message = (overrides = {}) => ({ epoch: '0123abcd', id: 1, tab: 'claude', action: 'text', text: 'hello', ...overrides });
function recheck(values) { values[21] = values.slice(0, 21).reduce((sum, value, i) => (sum + value * (i + 1)) % 64, 0); return values.map(valueToRGB); }
function draw(image, cells, x, y) {
  cells.forEach((rgb, i) => { for (let dy = 0; dy < 6; dy++) for (let dx = 0; dx < 6; dx++) {
    const offset = ((y + dy) * image.width + x + i * 6 + dx) * 4;
    image.data.set([...rgb, 255], offset);
  } });
}

test('pixel: fixed Lua/Node interoperability vector and all RGB symbols', () => {
  const frames = encodeMessage(message({ id: 262143, tab: 'codex', text: 'hi |T' }));
  assert.deepEqual(frames.map(f => f.map(rgbToValue)), [
    [51, 63, 63, 63, 0, 11, 12, 3, 4, 50, 12, 54, 5, 34, 24, 54, 16, 50, 12, 6, 32, 49],
    [51, 63, 63, 63, 1, 36, 26, 18, 1, 60, 21, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 21],
  ]);
  for (let value = 0; value < 64; value++) assert.equal(rgbToValue(valueToRGB(value)), value);
});

test('pixel: reordered frames, repeats, Unicode, both tabs and all actions', () => {
  for (const tab of ['claude', 'codex']) for (const action of ['text', 'enter', 'interrupt', 'escape', 'up', 'down']) {
    const input = message({ tab, action, text: action === 'text' ? 'Привіт 🌕 |T hi \\"' : '' });
    const frames = encodeMessage(input), decoder = new PixelDecoder();
    let output = null;
    for (const cells of [...frames].reverse()) output = decoder.push(cells, 1) ?? output;
    assert.deepEqual(output, input);
    let repeat = null;
    for (const cells of frames) repeat = decoder.push(cells, 2) ?? repeat;
    assert.deepEqual(repeat, input, 'acceptance is external: full cycles must be emitted again');
  }
});

test('pixel: largest text takes 56 frames and survives a 5fps cycle', () => {
  const input = message({ text: 'é'.repeat(300) }), frames = encodeMessage(input), decoder = new PixelDecoder();
  assert.equal(frames.length, 56);
  let output = null;
  frames.forEach((cells, index) => { output = decoder.push(cells, index * 200) ?? output; });
  assert.deepEqual(output, input);
});

test('pixel: malformed messages are rejected before allocating frames', () => {
  for (const delta of [{ epoch: '00000000' }, { epoch: 'x123abcd' }, { id: 0 }, { id: 262144 }, { id: 1.5 },
    { tab: 'other' }, { action: 'execute' }, { action: 'interrupt', text: 'anything' }, { text: 'x'.repeat(601) },
    { text: 'line\nnext' }, { text: 'esc\x1b[2J' }, { text: '\x7f' }, { text: '\u0080' }, { text: '\ud800' }])
    assert.throws(() => encodeMessage(message(delta)), TypeError);
});

test('pixel: checksum, quantization gaps, padding and malformed lengths reject', () => {
  const cells = encodeMessage(message({ action: 'enter', text: '' }))[0];
  const noisy = cells.map(rgb => rgb.map(c => c === 255 ? c - 40 : c + 40));
  assert.ok(decodeFrame(noisy));
  const gap = structuredClone(cells); gap[0][0] = 42; assert.equal(decodeFrame(gap), null);
  const corrupt = cells.map(rgbToValue); corrupt[7] ^= 1; assert.equal(decodeFrame(corrupt.map(valueToRGB)), null);
  const padding = cells.map(rgbToValue); padding[20] |= 1; assert.equal(decodeFrame(recheck(padding)), null);
  const length = cells.map(rgbToValue); length[5] = 44; assert.equal(decodeFrame(recheck(length)), null);
  const nonfinal = cells.map(rgbToValue); nonfinal[5] = 10; assert.equal(decodeFrame(recheck(nonfinal)), null);
  assert.equal(decodeFrame(cells.slice(1)), null);
});

test('pixel: conflicting duplicate or final index discards incomplete message', () => {
  const decoder = new PixelDecoder(), first = encodeMessage(message({ text: 'A'.repeat(50) }));
  const changed = encodeMessage(message({ text: 'B'.repeat(50) }));
  assert.equal(decoder.push(first[0], 0), null);
  assert.equal(decoder.push(changed[0], 1), null);
  assert.equal(decoder.pending.size, 0);
  decoder.push(first[3], 2);
  const earlyEnd = changed[1].map(rgbToValue); earlyEnd[5] = 43;
  assert.equal(decoder.push(recheck(earlyEnd), 3), null);
  assert.equal(decoder.pending.size, 0);
});

test('pixel: invalid UTF-8 cannot reach terminal acceptance', () => {
  const values = encodeMessage(message({ text: 'a' }))[0].map(rgbToValue);
  // The final payload byte (text) is byte 11: replace ASCII with lone UTF-8 continuation 0x80.
  values[19] = (values[19] & 48) | 8;
  values[20] = 0;
  assert.equal(new PixelDecoder().push(recheck(values), 0), null);
});

test('pixel: pending IDs, timeout and epoch-transition clear are bounded', () => {
  const decoder = new PixelDecoder({ maxPending: 2, timeoutMs: 100 });
  for (let id = 1; id <= 3; id++) decoder.push(encodeMessage(message({ id, text: 'x'.repeat(50) }))[0], id);
  assert.equal(decoder.pending.size, 2); assert.equal(decoder.pending.has(1), false);
  decoder.push(Array(22).fill([0, 0, 0]), 103); assert.equal(decoder.pending.size, 0);
  decoder.push(encodeMessage(message())[0], 104); decoder.clear(); assert.equal(decoder.pending.size, 0);
  assert.throws(() => new PixelDecoder({ maxPending: Infinity }), TypeError);
});

test('pixel: heartbeat carries binary daemon epoch, UI nonce, cursor and flags', () => {
  const cells = encodeHeartbeat('89ABCDEF', 9999, 3, '10203040');
  assert.deepEqual(decodeHeartbeat(cells), { epoch: '89abcdef', uiNonce: '10203040', nextSeq: 9999, flags: 3, combat: true, reload: true });
  assert.deepEqual([...decodeFrame(cells).bytes], [137, 171, 205, 239, 16, 32, 48, 64, 39, 15, 3]);
  assert.equal(new PixelDecoder().push(cells, 0), null);
  assert.equal(decodeHeartbeat(encodeMessage(message())[0]), null);
  assert.equal(decodeHeartbeat(encodeHeartbeat('00000000', 1)).uiNonce, '00000000');
  assert.equal(decodeHeartbeat(encodeHeartbeat('0123abcd', 10000, 2, '12345678')).nextSeq, 10000);
  assert.equal(decodeHeartbeat(encodeHeartbeat('0123abcd', 65535)).nextSeq, 65535);
  assert.throws(() => encodeHeartbeat('0123abcd', 65536), TypeError);
  for (const args of [['00000000', 0], ['bad', 1], ['0123abcd', 1, 4], ['0123abcd', 1, 0, 'bad']])
    assert.throws(() => encodeHeartbeat(...args), TypeError);
});

test('pixel: calibration finds exact 132x12 anchor and samples both rows', () => {
  const image = { width: 180, height: 40, data: Buffer.alloc(180 * 40 * 4, 19) };
  draw(image, calibrationCells(), 17, 9);
  const heartbeat = encodeHeartbeat('0123abcd', 71, 1, '12345678'); draw(image, heartbeat, 17, 15);
  assert.deepEqual(calibrate(image), { x: 17, y: 9, width: 132, height: 12, cellSize: 6 });
  assert.deepEqual(sampleFrame(image, { x: 17, y: 9 }), calibrationCells());
  assert.deepEqual(sampleFrame(image, { x: 17, y: 9, row: 1 }), heartbeat);
  assert.equal(sampleFrame(image, { x: 100 }), null);
  assert.equal(calibrate({ ...image, data: image.data.subarray(1) }), null);
  assert.equal(calibrate({ width: 132, height: 12, data: Buffer.alloc(132 * 12 * 4) }), null);
});
