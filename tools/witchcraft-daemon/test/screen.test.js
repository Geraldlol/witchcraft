import test from 'node:test';
import assert from 'node:assert/strict';
import { Screen } from '../src/screen.js';

test('headless terminal resolves redraws, ANSI foreground and literal WoW markup', async t => {
  const screen = new Screen({ cols: 40, rows: 10 }); t.after(() => screen.dispose());
  await screen.write('old output\r\x1b[2K\x1b[31mnew |Tbad|t\x1b[0m');
  const row = screen.snapshot().lines[0];
  assert.ok(row.includes('new ||Tbad||t')); assert.ok(!row.includes('old output'));
  assert.match(row, /\|cff[0-9a-f]{6}/iu);
});
test('independent screens retain their own buffers and viewport after resize', async t => {
  const claude = new Screen({ cols: 40, rows: 10 }), codex = new Screen({ cols: 40, rows: 10 });
  t.after(async () => { await claude.dispose(); await codex.dispose(); });
  await claude.write('Claude only'); await codex.write('Codex only');
  assert.match(claude.plain(), /Claude only/u); assert.doesNotMatch(claude.plain(), /Codex/u);
  assert.match(codex.plain(), /Codex only/u);
  codex.resize(50, 12); assert.equal(codex.snapshot().lines.length, 12);
});

test('screen serialization preserves terminal attributes and cursor placement for overlay recovery', async t => {
  const source = new Screen({ cols: 40, rows: 10 }), restored = new Screen({ cols: 40, rows: 10 });
  t.after(async () => { await Promise.all([source.dispose(), restored.dispose()]); });
  await source.write('plain \u001b[31mred\u001b[0m\r\nsecond\u001b[4;7H');
  const serialized = source.serialize();
  assert.match(serialized, /\u001b\[31m/u);
  await restored.write(serialized);
  assert.equal(restored.plain(), source.plain());
  assert.equal(restored.terminal.buffer.active.cursorX, source.terminal.buffer.active.cursorX);
  assert.equal(restored.terminal.buffer.active.cursorY, source.terminal.buffer.active.cursorY);
});

const text = line => line.replace(/\|cff[0-9a-f]{6}|\|r/giu, '').trim();
test('snapshot carries rendered history above the viewport, oldest first, capped at the configured lines', async t => {
  const screen = new Screen({ cols: 20, rows: 3, history: 5 }); t.after(() => screen.dispose());
  await screen.write('\x1b[31mline1 a|b\x1b[0m\r\n' + [2, 3, 4, 5, 6, 7, 8].map(n => `line${n}`).join('\r\n'));
  const first = screen.snapshot();
  assert.deepEqual(first.lines.map(text), ['line6', 'line7', 'line8']);
  assert.equal(first.history.length, 5);
  assert.deepEqual(first.history.slice(1).map(text), ['line2', 'line3', 'line4', 'line5']);
  assert.match(first.history[0], /^\|cffcd0000line1 a\|\|b\|r/u);
  await screen.write('\r\nline9');
  const next = screen.snapshot();
  assert.equal(next.history.length, 5);
  assert.deepEqual(next.history.map(text), ['line2', 'line3', 'line4', 'line5', 'line6']);
  assert.deepEqual(next.lines.map(text), ['line7', 'line8', 'line9']);
});
test('history is empty at zero, survives a resize, and rejects out-of-range configuration', async t => {
  const none = new Screen({ cols: 20, rows: 3, history: 0 }), some = new Screen({ cols: 20, rows: 3, history: 200 });
  t.after(async () => { await Promise.all([none.dispose(), some.dispose()]); });
  const text = Array.from({ length: 12 }, (_, n) => `line${n + 1}`).join('\r\n');
  await none.write(text); await some.write(text);
  assert.deepEqual(none.snapshot().history, []);
  assert.equal(some.snapshot().history.length, 9);
  some.resize(30, 6); none.resize(30, 6);
  for (const screen of [some, none]) {
    const snapshot = screen.snapshot();
    assert.equal(snapshot.lines.length, 6);
    assert.ok(Array.isArray(snapshot.history) && snapshot.history.length <= 200);
    assert.ok(snapshot.lines.every(line => line.length >= 30));
  }
  await some.write('\r\nmore');
  assert.match(some.snapshot().lines.join('\n'), /more/u);
  assert.throws(() => new Screen({ cols: 20, rows: 3, history: 1001 }), /history/u);
  assert.throws(() => new Screen({ cols: 20, rows: 3, history: -1 }), /history/u);
  assert.throws(() => new Screen({ cols: 20, rows: 3, history: 1.5 }), /history/u);
});

test('snapshot is rendered once per version: repeats share the render and a write or resize invalidates it', async t => {
  const screen = new Screen({ cols: 20, rows: 3, history: 5 }); t.after(() => screen.dispose());
  await screen.write('one\r\ntwo');
  const buffer = screen.terminal.buffer.active, getLine = buffer.getLine.bind(buffer);
  let reads = 0;
  buffer.getLine = y => { reads++; return getLine(y); };
  const first = screen.snapshot(), again = screen.snapshot();
  assert.equal(again, first, 'an unchanged screen returns the cached snapshot');
  assert.equal(reads, 3, 'three viewport rows read once');
  assert.deepEqual(again.lines.map(text), ['one', 'two', '']);
  await screen.write('\r\nthree');
  const next = screen.snapshot();
  assert.notEqual(next, first);
  assert.deepEqual(next.lines.map(text), ['one', 'two', 'three']);
  assert.equal(screen.snapshot(), next);
  screen.resize(20, 2);
  assert.equal(screen.snapshot().lines.length, 2);
});

test('scrolled counts every line that left the viewport since construction, with or without scrollback', async t => {
  const some = new Screen({ cols: 20, rows: 3, history: 5 }), none = new Screen({ cols: 20, rows: 3, history: 0 });
  t.after(async () => { await Promise.all([some.dispose(), none.dispose()]); });
  assert.equal(some.snapshot().scrolled, 0);
  await some.write('one\r\ntwo\r\nthree');
  assert.equal(some.snapshot().scrolled, 0, 'filling the viewport scrolls nothing');
  await some.write('\r\nfour\r\nfive');
  assert.equal(some.snapshot().scrolled, 2);
  // Beyond the scrollback the viewport position stops moving but lines keep leaving the screen.
  await some.write('\r\n' + ['six', 'seven', 'eight', 'nine', 'ten'].join('\r\n'));
  assert.equal(some.snapshot().scrolled, 7);
  assert.equal(some.terminal.buffer.active.baseY, 5);
  await none.write(Array.from({ length: 12 }, (_, n) => `line${n + 1}`).join('\r\n'));
  assert.equal(none.snapshot().scrolled, 9);
  assert.equal(none.terminal.buffer.active.baseY, 0);
  // A resize keeps the count: nothing new left the viewport.
  some.resize(30, 6);
  assert.equal(some.snapshot().scrolled, 7);
});
