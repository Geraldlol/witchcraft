import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeText, paletteColor, renderRow, renderRows } from '../src/wowtext.js';

test('wowtext: pipes remain literal, controls become spaces and emoji become one fallback', () => {
  assert.equal(escapeText('|Ticon|t |Hspell:1|hName|h |cffff0000X|r\n😀\x1b'),
    '||Ticon||t ||Hspell:1||hName||h ||cffff0000X||r ? ');
  assert.equal(escapeText('Привіт 世界 e\u0301 \ud800'), 'Привіт 世界 e\u0301 ?');
});

test('wowtext: 16/256/truecolor foreground and ANSI bright/dim render deterministically', () => {
  assert.equal(paletteColor(16), 0x000000); assert.equal(paletteColor(231), 0xffffff);
  assert.equal(paletteColor(232), 0x080808); assert.equal(paletteColor(255), 0xeeeeee);
  assert.equal(paletteColor(256), null);
  assert.equal(renderRow([{ text: 'A', fg: 1, bold: true }, { text: 'B', fg: { mode: 'palette', value: 196 } },
    { text: 'C', fg: { mode: 'rgb', value: 0xabcdef } }, { text: 'D', fg: '#ffffff', dim: true }], { cols: 4 }),
  '|cffff0000AB|r|cffabcdefC|r|cffa6a6a6D|r');
});

test('wowtext: truncation counts unescaped text columns and pads short lines', () => {
  assert.equal(renderRow([{ text: '||Tbad', fg: '#abcdef' }], { cols: 3 }), '|cffabcdef||||T|r');
  assert.equal(renderRow([{ text: 'hi' }], { cols: 5 }), '|cffd4d4d4hi|r   ');
  assert.deepEqual(renderRows([[], [{ text: 'ok' }]], { cols: 2 }), ['  ', '|cffd4d4d4ok|r']);
});

test('wowtext: xterm cell widths preserve wide glyphs and combining marks', () => {
  assert.equal(renderRow([{ text: '界', width: 2 }, { text: '', width: 0 }, { text: 'e\u0301', width: 1 }], { cols: 4 }),
    '|cffd4d4d4界e\u0301|r ');
  assert.equal(renderRow([{ text: '界', width: 2 }], { cols: 1 }), ' ');
  assert.equal(renderRow([{ text: '', width: 1 }, { text: 'x', width: 1 }], { cols: 2 }), '|cffd4d4d4 x|r');
  assert.throws(() => renderRow([{ text: 'x', width: 99 }]), TypeError);
});

test('wowtext: a cell stacked with combining marks keeps its first four code points instead of failing', () => {
  // An agent printing Z plus 20 x U+0336 puts all 21 units in one xterm cell.
  assert.equal(renderRow([{ text: 'Z' + '̶'.repeat(20), width: 1 }, { text: 'k', width: 1 }], { cols: 3 }),
    '|cffd4d4d4Z̶̶̶k|r ');
  // The clamp bounds every row: 240 such cells stay under the addon's 8192-byte line limit.
  const widest = renderRow(Array.from({ length: 240 }, (_, index) => ({ text: 'e' + '́'.repeat(30), width: 1, fg: index % 2 })), { cols: 240 });
  assert.ok(Buffer.byteLength(widest) <= 8192);
});

test('wowtext: adjacent same-color xterm cells share one bounded color span', () => {
  const output = renderRow(Array.from({ length: 120 }, () => ({ text: 'x', width: 1 })));
  assert.equal(output, '|cffd4d4d4' + 'x'.repeat(120) + '|r');
  assert.ok(Buffer.byteLength(output) <= 160);
  const literal = Array.from('new |Tbad|t', text => ({ text, width: 1 }));
  assert.ok(renderRow(literal).includes('new ||Tbad||t'));
  assert.equal(renderRow([{ text: 'a', width: 1, fg: 1 }, { text: 'b', width: 1, fg: 1 },
    { text: '界', width: 2, fg: '#00ff00' }, { text: 'e\u0301', width: 1, fg: '#00ff00' },
    { text: 'c', width: 1, fg: 1 }], { cols: 6 }), '|cffcd0000ab|r|cff00ff00界e\u0301|r|cffcd0000c|r');
});

test('wowtext: input budgets and invalid shapes are enforced', () => {
  for (const cols of [0, 241, 1.5, NaN]) assert.throws(() => renderRow([], { cols }), TypeError);
  assert.throws(() => renderRow(Array(1025).fill({ text: '' })), TypeError);
  assert.throws(() => renderRows(Array(101).fill([])), TypeError);
  assert.throws(() => escapeText('x'.repeat(65537)), TypeError);
  assert.throws(() => renderRow([{ text: {} }]), TypeError);
});
