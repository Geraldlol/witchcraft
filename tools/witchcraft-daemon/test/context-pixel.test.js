import test from 'node:test';
import assert from 'node:assert/strict';
import { ContextDecoder, PixelDecoder, encodeContext, encodeMessage, decodeFrame, decodeContextFrame,
  encodeHeartbeat, rgbToValue, valueToRGB } from '../src/pixel.js';

const input = (fields = {}) => ({ epoch: '0123abcd', uiNonce: 'abcdef01', id: 1, text: '[1,"state",1,1,1,0,[true]]', ...fields });
function recheck(values) {
  values[21] = values.slice(0, 21).reduce((sum, value, i) => (sum + value * (i + 1)) % 64, 0);
  return values.map(valueToRGB);
}
function receive(decoder, frames, start = 0) {
  let output = null;
  frames.forEach((cells, index) => { output = decoder.push(cells, start + index * 200) ?? output; });
  return output;
}

test('context pixels are a disjoint typed channel with epoch and UI nonce', () => {
  const value = input(), frames = encodeContext(value);
  assert.equal(frames[0].map(rgbToValue)[0], 50);
  assert.equal(decodeFrame(frames[0]), null);
  assert.ok(decodeContextFrame(frames[0]));
  assert.equal(receive(new PixelDecoder(), frames), null);
  const output = receive(new ContextDecoder(), frames);
  assert.deepEqual(output, { kind: 'context', ...value, transportAgeSeconds: 30 + (frames.length - 1) / 5 });
  const terminal = encodeMessage({ epoch: value.epoch, id: 1, tab: 'codex', action: 'text', text: 'hello' });
  assert.equal(receive(new ContextDecoder(), terminal), null);
  assert.equal(new ContextDecoder().push(encodeHeartbeat(value.epoch, 1, 0, value.uiNonce)), null);
});

test('interleaved terminal and context transfers with the same ID remain independent', () => {
  const value = input({ text: 'é'.repeat(290) });
  const context = encodeContext(value), terminal = encodeMessage({ epoch: value.epoch, id: 1, tab: 'claude', action: 'text', text: 'x'.repeat(600) });
  const cd = new ContextDecoder(), td = new PixelDecoder();
  let game, prompt;
  for (let index = 0; index < Math.max(context.length, terminal.length); index++) {
    for (const cells of [context[index], terminal[index]].filter(Boolean)) {
      game = cd.push(cells, index * 200) ?? game;
      prompt = td.push(cells, index * 200) ?? prompt;
    }
  }
  assert.equal(context.length, 55); assert.equal(terminal.length, 56);
  assert.equal(game.text, value.text); assert.equal(game.transportAgeSeconds, 40.8);
  assert.equal(prompt.tab, 'claude'); assert.equal(prompt.text.length, 600);
  assert.equal(cd.pending.size, 0); assert.equal(td.pending.size, 0);
});

test('context bounds reject malformed UTF-8, controls, IDs, identity and excessive text', () => {
  for (const fields of [{ epoch: '00000000' }, { uiNonce: '00000000' }, { uiNonce: 'not-hex!' },
    { id: 0 }, { id: 262144 }, { text: 'x'.repeat(581) }, { text: '\n' }, { text: '\u0080' }, { text: '\ud800' }])
    assert.throws(() => encodeContext(input(fields)), TypeError);
  const frames = encodeContext(input({ text: 'x'.repeat(580) }));
  const corrupt = frames[0].map(rgbToValue); corrupt[7] ^= 1;
  assert.equal(decodeContextFrame(corrupt.map(valueToRGB)), null);
  const wrongSync = frames[0].map(rgbToValue); wrongSync[0] = 51;
  assert.equal(decodeContextFrame(recheck(wrongSync)), null);
});

test('context multipart conflicts, timeouts, reordering and nonce changes stay bounded', () => {
  const frames = encodeContext(input()), changed = encodeContext(input({ uiNonce: '12345678' }));
  const decoder = new ContextDecoder({ timeoutMs: 1000, maxPending: 2 });
  decoder.push(frames[0], 0); decoder.push(changed[0], 1); assert.equal(decoder.pending.size, 0);
  for (let id = 1; id <= 3; id++) decoder.push(encodeContext(input({ id }))[0], id);
  assert.equal(decoder.pending.size, 2); assert.equal(decoder.pending.has(1), false);
  decoder.push([], 1003); assert.equal(decoder.pending.size, 0);
  const reversed = receive(new ContextDecoder(), frames.toReversed());
  assert.equal(reversed.uiNonce, input().uiNonce);
  assert.ok(reversed.transportAgeSeconds >= 30);
  decoder.clear(); assert.equal(decoder.pending.size, 0);
});
