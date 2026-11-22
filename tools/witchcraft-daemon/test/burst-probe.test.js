import test from 'node:test';
import assert from 'node:assert/strict';
import { runBurstProbe } from '../bin/witchcraft.js';
import { burstProbeText, paginateBurst } from '../src/burst.js';
import { encodeContext, encodeHeartbeat, rgbToValue, valueToRGB } from '../src/pixel.js';

function paint(data, width, cells, row) {
  cells.forEach((rgb, column) => {
    for (let dy = 0; dy < 6; dy++) for (let dx = 0; dx < 6; dx++) {
      data.set([...rgb, 255], ((row * 6 + dy) * width + column * 6 + dx) * 4);
    }
  });
}

function imageFor(page, captureMs = 12, heartbeat = encodeHeartbeat('0123abcd', 1, 0, '89abcdef')) {
  const width = 132, height = 144, data = Buffer.alloc(width * height * 4, 0);
  paint(data, width, heartbeat, 1);
  page.forEach((cells, row) => paint(data, width, cells, row + 2));
  return { width, height, data, x: 7, y: 9, captureMs, foreground: true };
}

function pages(text = burstProbeText(), epoch = '0123abcd', uiNonce = '89abcdef', id = 262143) {
  return paginateBurst(encodeContext({ epoch, uiNonce, id, text }));
}

function fakeCapture(images, state) {
  return class FakeCapture {
    constructor(options) { this.options = options; this.stopped = false; state.options = options; }
    start() {
      this.options.onIdle?.();
      for (const image of images) {
        if (this.stopped) break;
        this.options.onFrame(image);
      }
    }
    stop() { this.stopped = true; state.stops++; }
  };
}

test('burst probe reuses only calibrated origin and passes its 99-of-100 native gate', async () => {
  const source = pages(), black = Array.from({ length: 22 }, () => Array.from({ length: 22 }, () => [0, 0, 0]));
  const images = [imageFor(black), imageFor(black),
    ...Array.from({ length: 100 }, (_, index) => imageFor(source[index % 3], 10 + index % 4))];
  const values = source[0][0].map(rgbToValue); values[6] = (values[6] + 1) % 64;
  const damaged = structuredClone(source[0]); damaged[0] = values.map(valueToRGB); images[17] = imageFor(damaged);
  const state = { stops: 0 };
  const result = await runBurstProbe({ region: { x: 7, y: 9, width: 132, height: 12, cellSize: 6 } },
    { timeout: '5' }, { Capture: fakeCapture(images, state) });
  assert.equal(result.passed, true); assert.equal(result.acceptedPages, 99);
  assert.equal(result.sampledPages, 100); assert.ok(result.validPayloads >= 1);
  assert.equal(result.rejectedPages['row-checksum'], 1); assert.equal(result.maxChannelError, 0);
  assert.equal(result.foregroundIdleRecords, 1); assert.equal(result.foregroundRecoveries, 1);
  assert.equal(result.blankPages, 2);
  assert.deepEqual(state.options.region, { x: 7, y: 9 }); assert.equal(state.options.profile, 'burst');
  assert.equal(state.stops, 1);
});

test('burst probe fails closed at 98 coherent pages and on an unexpected payload', async () => {
  const source = pages(), damaged = structuredClone(source[0]);
  const values = damaged[0].map(rgbToValue); values[7] = (values[7] + 1) % 64; damaged[0] = values.map(valueToRGB);
  const images = Array.from({ length: 100 }, (_, index) => imageFor(index === 11 || index === 37 ? damaged : source[index % 3]));
  await assert.rejects(runBurstProbe({ region: { x: 0, y: 0 } }, { timeout: 5 },
    { Capture: fakeCapture(images, { stops: 0 }) }), /failed its native gate/);

  const slow = Array.from({ length: 100 }, (_, index) => imageFor(source[index % 3], 101));
  await assert.rejects(runBurstProbe({ region: { x: 0, y: 0 } }, { timeout: 5 },
    { Capture: fakeCapture(slow, { stops: 0 }) }), /failed its native gate/);

  const other = pages('X'.repeat(560));
  await assert.rejects(runBurstProbe({ region: { x: 0, y: 0 } }, { timeout: 5 },
    { Capture: fakeCapture(Array.from({ length: 100 }, (_, index) => imageFor(other[index % 3])), { stops: 0 }) }),
  /unexpected payload/);
});

test('burst probe binds every assembled payload to the current heartbeat session', async () => {
  const oldPages = pages(burstProbeText(), '0123abcd', '89abcdef');
  const newPages = pages(burstProbeText(), 'fedcba98', '76543210');
  const oldHeartbeat = encodeHeartbeat('0123abcd', 1, 0, '89abcdef');
  const newHeartbeat = encodeHeartbeat('fedcba98', 1, 0, '76543210');
  const images = [imageFor(oldPages[0], 10, oldHeartbeat)];
  for (let index = 1; index < 100; index++) images.push(imageFor(newPages[index % 2 + 1], 10, newHeartbeat));
  await assert.rejects(runBurstProbe({ region: { x: 0, y: 0 } }, { timeout: 5 },
    { Capture: fakeCapture(images, { stops: 0 }) }), /session changed/);

  const completeThenReload = [
    ...oldPages.map(page => imageFor(page, 10, oldHeartbeat)),
    ...Array.from({ length: 97 }, (_, index) => imageFor(newPages[index % 3], 10, newHeartbeat)),
  ];
  await assert.rejects(runBurstProbe({ region: { x: 0, y: 0 } }, { timeout: 5 },
    { Capture: fakeCapture(completeThenReload, { stops: 0 }) }), /session changed/);

  const wrongID = pages(burstProbeText(), '0123abcd', '89abcdef', 7);
  await assert.rejects(runBurstProbe({ region: { x: 0, y: 0 } }, { timeout: 5 },
    { Capture: fakeCapture(Array.from({ length: 100 }, (_, index) => imageFor(wrongID[index % 3])), { stops: 0 }) }),
  /failed its native gate/);
});

test('burst probe validates timeout before starting capture', async () => {
  await assert.rejects(runBurstProbe({ region: { x: 0, y: 0 } }, { timeout: 4 }), /5 to 300/);
  await assert.rejects(runBurstProbe({}, { timeout: 30 }), /Calibrate/);
});
