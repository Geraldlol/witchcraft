import test from 'node:test';
import assert from 'node:assert/strict';
import { ContextDecoder, PixelDecoder, encodeContext, encodeMessage, rgbToValue, valueToRGB } from '../src/pixel.js';
import { BURST_HEIGHT, BURST_ROWS, BURST_WIDTH, burstProbeText, decodeBurstPage,
  maxChannelError, paginateBurst, sampleBurstPage } from '../src/burst.js';

const context = (overrides = {}) => ({ epoch: '0123abcd', uiNonce: '89abcdef', id: 262143,
  text: burstProbeText(), ...overrides });

function imageFor(page) {
  const image = { width: BURST_WIDTH, height: BURST_HEIGHT,
    data: Buffer.alloc(BURST_WIDTH * BURST_HEIGHT * 4, 0) };
  page.forEach((cells, row) => cells.forEach((rgb, column) => {
    for (let dy = 0; dy < 6; dy++) for (let dx = 0; dx < 6; dx++) {
      const offset = (((row + 2) * 6 + dy) * BURST_WIDTH + column * 6 + dx) * 4;
      image.data.set([...rgb, 255], offset);
    }
  }));
  return image;
}

test('burst: 560-byte context uses three coherent pages and the existing decoder', () => {
  const frames = encodeContext(context()), pages = paginateBurst(frames), decoder = new ContextDecoder();
  assert.equal(frames.length, 53); assert.equal(pages.length, 3);
  let message = null;
  pages.forEach((rows, pageIndex) => {
    const page = decodeBurstPage(rows);
    assert.equal(page.status, 'page'); assert.equal(page.kind, 'context'); assert.equal(page.page, pageIndex);
    for (const row of page.rows) message = decoder.push(row, pageIndex * 1000) ?? message;
  });
  assert.equal(message.text, burstProbeText());
  assert.equal(message.epoch, '0123abcd'); assert.equal(message.uiNonce, '89abcdef');
});

test('burst: a whole page can carry terminal frames without crossing decoder types', () => {
  const frames = encodeMessage({ epoch: '0123abcd', id: 7, tab: 'codex', action: 'text', text: 'x'.repeat(200) });
  const page = decodeBurstPage(paginateBurst(frames)[0]);
  assert.equal(page.kind, 'terminal');
  const terminal = new PixelDecoder(), contextDecoder = new ContextDecoder(); let message = null;
  for (const row of page.rows) {
    message = terminal.push(row, 0) ?? message;
    assert.equal(contextDecoder.push(row, 0), null);
  }
  assert.equal(message.text, 'x'.repeat(200)); assert.equal(message.tab, 'codex');
});

test('burst: torn, mixed, corrupt, misaligned and live-after-padding pages reject', () => {
  const first = paginateBurst(encodeContext(context())), second = paginateBurst(encodeContext(context({ id: 8 })));
  const torn = structuredClone(first[0]); torn.splice(10, 12, ...structuredClone(first[1].slice(10)));
  assert.equal(decodeBurstPage(torn).reason, 'torn-indices');
  const mixed = structuredClone(first[0]); mixed[5] = structuredClone(second[0][5]);
  assert.equal(decodeBurstPage(mixed).reason, 'mixed-message');
  const corrupt = structuredClone(first[0]);
  const values = corrupt[0].map(rgbToValue); values[6] = (values[6] + 1) % 64; corrupt[0] = values.map(valueToRGB);
  assert.equal(decodeBurstPage(corrupt).reason, 'row-checksum');
  assert.equal(decodeBurstPage(first[1].slice(1).concat(first[1].slice(0, 1))).reason, 'page-alignment');
  const padded = structuredClone(first[2]); padded[12] = structuredClone(first[0][0]);
  assert.equal(decodeBurstPage(padded).reason, 'live-after-padding');
});

test('burst: image sampling is fixed at 132x144 beneath the live strip', () => {
  const page = paginateBurst(encodeContext(context()))[0], image = imageFor(page);
  assert.deepEqual(sampleBurstPage(image), page);
  assert.equal(maxChannelError(page), 0);
  const tolerated = structuredClone(page); tolerated[0][0][0] = 40;
  assert.equal(maxChannelError(tolerated), 40);
  const rejected = structuredClone(page); rejected[0][0][0] = 41;
  assert.equal(maxChannelError(rejected), 41);
  assert.equal(sampleBurstPage({ ...image, height: BURST_HEIGHT - 1,
    data: image.data.subarray(0, BURST_WIDTH * (BURST_HEIGHT - 1) * 4) }), null);
  assert.equal(BURST_ROWS, 22);
});
