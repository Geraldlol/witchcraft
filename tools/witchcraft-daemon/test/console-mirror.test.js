import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { ConsoleMirror, consoleRuns, CONSOLE_DEFAULT_ROWS } from '../src/console-mirror.js';

// The console packs colour into one attribute word: bit 0 blue, 1 green, 2 red, 3 intensity,
// and the same again shifted for the background.
const attr = (fg, bg = 0) => fg | (bg << 4);

function fake() {
  const child = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.written = [];
  child.stdin.on('data', chunk => child.written.push(...String(chunk).trim().split('\n').filter(Boolean)));
  child.killed = 0;
  child.kill = () => { child.killed += 1; };
  const spawn = (file, args) => { child.file = file; child.args = args; return child; };
  return { child, spawn };
}
const line = (child, value) => child.stdout.write(JSON.stringify(value) + '\n');
const settle = () => new Promise(resolve => setImmediate(resolve));
const unmarked = row => row.replace(/\|c[0-9a-f]{8}|\|r|\|\|/gu, value => value === '||' ? '|' : '').trimEnd();

test('console attributes become palette runs, and the console default stays ordinary text', () => {
  const runs = consoleRuns([[attr(4), 'red'], [attr(12), 'bright'], [attr(7), 'plain'], [attr(2), 'green']], attr(7));
  assert.deepEqual(runs.map(run => run.text), ['red', 'bright', 'plain', 'green']);
  // Console red is bit 2; ANSI red is index 1. Intensity is carried as bold, which the renderer
  // turns into the bright half of the palette, so the mapping stays the terminal's own.
  assert.deepEqual(runs[0].fg, { mode: 'palette', value: 1 });
  assert.equal(runs[0].bold, false);
  assert.deepEqual(runs[1].fg, { mode: 'palette', value: 1 });
  assert.equal(runs[1].bold, true, 'the intensity bit is bold, not a separate colour');
  assert.equal(runs[2].fg, undefined, 'the console default carries no colour of its own');
  assert.deepEqual(runs[3].fg, { mode: 'palette', value: 2 });
  // Every console colour maps somewhere in the sixteen, and none collide.
  const mapped = Array.from({ length: 8 }, (_, value) => consoleRuns([[value, 'x']], 0xff)[0].fg.value);
  assert.deepEqual([...mapped].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7]);
});

test('a frame becomes the session snapshot the ring already publishes', async () => {
  const { child, spawn } = fake();
  const mirror = new ConsoleMirror({ pid: 4242, spawn, cols: 12 });
  mirror.start();
  assert.match(child.args.join(' '), /console-mirror\.ps1/u);
  assert.match(child.args.join(' '), /-TargetPid 4242/u);
  assert.equal(mirror.snapshot().lines.length, 0, 'nothing is published before the first frame');

  line(child, { type: 'ready', pid: 4242 });
  line(child, {
    type: 'frame', cols: 12, rows: 2, bufferRows: 3000, default: attr(7), cursor: [3, 9], scrolled: 7,
    lines: [[[attr(7), 'hello'], [attr(4), 'RED']], []],
    history: [[[attr(7), 'older']]],
  });
  await settle();

  const snapshot = mirror.snapshot();
  assert.equal(snapshot.scrolled, 7);
  assert.equal(snapshot.cols, 12);
  assert.equal(snapshot.rows, 2);
  assert.equal(snapshot.lines.length, 2, 'every window row is published, blank ones included');
  assert.match(snapshot.lines[0], /hello/u);
  assert.match(snapshot.lines[0], /\|cff/u, 'a coloured run carries its colour');
  assert.equal(snapshot.history.length, 1);
  assert.match(snapshot.history[0], /older/u);
  // Rows are padded to the column count, as the terminal path does.
  assert.equal(snapshot.lines[1].length > 0, true);
});

test('typing and named keys reach the helper, and an unchanged screen is not re-rendered', async () => {
  const { child, spawn } = fake();
  const mirror = new ConsoleMirror({ pid: 7, spawn, cols: 8 });
  mirror.start();
  line(child, { type: 'frame', cols: 8, rows: 1, default: 7, cursor: [0, 0], scrolled: 0, lines: [[[7, 'one']]], history: [] });
  await settle();
  const first = mirror.snapshot();
  const again = mirror.snapshot();
  assert.equal(again, first, 'an unchanged frame returns the same rendered snapshot');

  mirror.write('hi there');
  mirror.key('enter');
  mirror.refresh();
  assert.deepEqual(child.written.map(JSON.parse), [
    { type: 'text', text: 'hi there' },
    { type: 'key', name: 'enter' },
    { type: 'frame' },
  ]);
  mirror.key('nonsense');
  assert.equal(child.written.length, 3, 'an unknown key is refused rather than sent');
});

test('an error after the helper is ready ends it, so its tab is seen to exit', async () => {
  const { child, spawn } = fake();
  const exits = [];
  const mirror = new ConsoleMirror({ pid: 9, spawn, onExit: code => exits.push(code) });
  mirror.start();
  line(child, { type: 'ready', pid: 9 });
  line(child, { type: 'error', message: 'the console could not be read; it has probably closed' });
  await settle();
  assert.equal(child.killed, 1, 'a helper that can no longer read the console is ended, not left waiting');
  child.emit('exit', 3);
  assert.deepEqual(exits, [3]);
});

test('once the helper has failed, input is refused and a broken pipe never throws into the daemon', async () => {
  const { child, spawn } = fake();
  const errors = [];
  const mirror = new ConsoleMirror({ pid: 9, spawn, onError: error => errors.push(error.message) });
  mirror.start();
  line(child, { type: 'ready', pid: 9 });
  line(child, { type: 'error', message: 'the console could not be read; it has probably closed' });
  await settle();
  // The helper is being killed but has not exited yet: its stdin may already be a broken pipe.
  assert.equal(mirror.write('hello'), false, 'typing is refused, so the outbox reports it dropped');
  assert.equal(mirror.key('enter'), false);
  assert.doesNotThrow(() => child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })),
    'an unhandled stdin error would crash the daemon');
  assert.match(errors.join(' '), /EPIPE/u);
});

test('helper failures are reported and never throw into the daemon', async () => {
  const { child, spawn } = fake();
  const errors = [];
  const mirror = new ConsoleMirror({ pid: 9, spawn, onError: error => errors.push(error.message) });
  mirror.start();
  child.stdout.write('this is not json\n');
  line(child, { type: 'error', message: 'cannot attach to the console of process 9' });
  child.stderr.write('a warning from the helper\n');
  await settle();
  assert.equal(errors.length, 3, 'the unreadable line, the reported error and anything on stderr surface');
  assert.match(errors.join(' '), /cannot attach/u);
  assert.match(errors.join(' '), /a warning from the helper/u);
  assert.equal(mirror.snapshot().lines.length, 0);

  mirror.stop();
  assert.deepEqual(child.written.map(JSON.parse).at(-1), { type: 'stop' });
  mirror.stop();
  assert.equal(child.killed <= 1, true, 'stopping twice does not kill twice');
});

test('a frame wider or taller than the game asks for is bounded on the way out', async () => {
  const { child, spawn } = fake();
  const mirror = new ConsoleMirror({ pid: 1, spawn, cols: 6, rows: 2, historyRows: 1 });
  mirror.start();
  line(child, {
    type: 'frame', cols: 40, rows: 4, default: 7, cursor: [0, 0], scrolled: 2,
    lines: [[[7, 'aaaaaaaaaaaa']], [[7, 'b']], [[7, 'c']], [[7, 'd']]],
    history: [[[7, 'h1']], [[7, 'h2']], [[7, 'h3']]],
  });
  await settle();
  const snapshot = mirror.snapshot();
  assert.equal(snapshot.lines.length, 2, 'only the rows the game shows are published');
  assert.deepEqual(snapshot.lines.map(row => row.replace(/\|c[0-9a-f]{8}|\|r/gu, '').trimEnd()), ['c', 'd']);
  // The window rows the game cannot show are the nearest history, not lost: scrollback and window
  // are one sequence, so scrolling up from the bottom walks a continuous screen.
  assert.equal(snapshot.history.length, 1, 'history is bounded too');
  assert.deepEqual(snapshot.history.map(row => row.replace(/\|c[0-9a-f]{8}|\|r/gu, '').trimEnd()), ['b']);
  assert.equal(CONSOLE_DEFAULT_ROWS > 0, true);
});

test('plain mirror presentation keeps literal text and the same wrapped viewport as the game', async () => {
  const { child, spawn } = fake();
  const mirror = new ConsoleMirror({ pid: 1, spawn, cols: 6, rows: 2 });
  mirror.start();
  assert.equal(mirror.plain(), '', 'no frame means no terminal text');
  line(child, {
    type: 'frame', default: 7, lines: [
      [[7, 'hidden']], [[4, 'red|'], [7, 'text']], [[7, 'last']],
    ], history: [],
  });
  await settle();
  assert.equal(mirror.plain(), 'xt\r\nlast');
  assert.deepEqual(mirror.snapshot().lines.map(unmarked), ['xt', 'last']);
  assert.deepEqual(mirror.snapshot().history.map(unmarked), ['hidden', 'red|te']);
  assert.match(mirror.snapshot().lines[0], /\|cff/u, 'the separate game snapshot retains formatting');
});

test('a 232-column attached console keeps text beyond column 120 in continuation rows', async () => {
  const { child, spawn } = fake();
  const mirror = new ConsoleMirror({ pid: 1, spawn, cols: 120 });
  mirror.start();
  const text = 'a'.repeat(119) + '|FULL_TAIL_' + 'b'.repeat(102);
  assert.equal(text.length, 232);
  line(child, { type: 'frame', cols: 232, default: 7, scrolled: 0,
    lines: [[[7, text]]], history: [] });
  await settle();
  const snapshot = mirror.snapshot();
  assert.deepEqual(snapshot.lines.map(unmarked), [text.slice(0, 120), text.slice(120)]);
  assert.equal(snapshot.lines.map(unmarked).join(''), text, 'no source suffix disappears');
  assert.equal(mirror.plain(), `${text.slice(0, 120)}\r\n${text.slice(120)}`);
  assert.deepEqual(child.written, [], 'presenting continuation rows never resizes or types into the source console');
});

test('wrapping spans attribute runs and preserves continuation colors and literal pipes', async () => {
  const { child, spawn } = fake();
  const mirror = new ConsoleMirror({ pid: 1, spawn, cols: 6, rows: 4 });
  mirror.start();
  line(child, { type: 'frame', cols: 20, default: 7, scrolled: 0,
    lines: [[[4, 'RED|'], [2, 'green'], [7, '|tail']]], history: [] });
  await settle();
  const snapshot = mirror.snapshot();
  assert.deepEqual(snapshot.lines.map(unmarked), ['RED|gr', 'een|ta', 'il']);
  assert.match(snapshot.lines[0], /\|cffcd0000RED\|\|\|r\|cff00cd00gr\|r/u);
  assert.match(snapshot.lines[1], /^\|cff00cd00een\|r\|cffd4d4d4\|\|ta\|r/u);
  assert.equal(mirror.plain(), 'RED|gr\r\neen|ta\r\nil');
});

test('source history, wrapped window overflow and visible rows remain a continuous bounded sequence', async () => {
  const { child, spawn } = fake();
  const mirror = new ConsoleMirror({ pid: 1, spawn, cols: 4, rows: 2, historyRows: 3 });
  mirror.start();
  line(child, { type: 'frame', cols: 12, default: 7, scrolled: 1,
    history: [[[7, 'old0old1old2']]], lines: [[[7, 'new0new1new2']], [[7, 'last']]] });
  await settle();
  const snapshot = mirror.snapshot();
  assert.deepEqual(snapshot.history.map(unmarked), ['old2', 'new0', 'new1']);
  assert.deepEqual(snapshot.lines.map(unmarked), ['new2', 'last']);
  assert.equal(snapshot.scrolled, 3, 'source offset plus wrapped window overflow');
  assert.equal(mirror.plain(), 'new2\r\nlast');
});

test('scroll anchoring counts wrapped rows crossing the viewport and resets on geometry changes', async () => {
  const { child, spawn } = fake();
  const mirror = new ConsoleMirror({ pid: 1, spawn, cols: 4, rows: 2 });
  mirror.start();
  const row = text => [[7, text]];
  const frame = (scrolled, history, lines, cols = 12) => line(child,
    { type: 'frame', cols, default: 7, scrolled, history: history.map(row), lines: lines.map(row) });
  frame(0, [], ['aaaaBBBB', 'cccc']);
  await settle();
  const first = mirror.snapshot();
  assert.equal(first.scrolled, 1);
  frame(1, ['aaaaBBBB'], ['cccc', 'ddddEEEEFFFF']);
  await settle();
  const second = mirror.snapshot();
  assert.equal(second.scrolled - first.scrolled, 3, 'three new destination rows push history by three');
  assert.deepEqual(second.history.map(unmarked), ['aaaa', 'BBBB', 'cccc', 'dddd']);
  assert.deepEqual(second.lines.map(unmarked), ['EEEE', 'FFFF']);
  assert.equal(mirror.snapshot(), second, 'cached snapshots never advance the counter twice');

  frame(1, ['aaaaBBBB'], ['cccc', 'ddddEEEEFFFFgggg']);
  await settle();
  const grown = mirror.snapshot();
  assert.equal(grown.scrolled, second.scrolled + 1, 'a newly wrapped continuation pushes the viewport too');

  frame(1, ['aaaaBBBB'], ['ccccdddd', 'EEEEFFFFgggg'], 20);
  await settle();
  assert.equal(mirror.snapshot().scrolled, grown.scrolled, 'source width changes rebase without inventing output');
  mirror.cols = 8;
  assert.deepEqual(mirror.snapshot().lines.map(unmarked), ['EEEEFFFF', 'gggg']);
  assert.equal(mirror.snapshot().scrolled, grown.scrolled, 'destination width changes also rebase');
  frame(0, [], ['reset', 'last'], 20);
  await settle();
  assert.equal(mirror.snapshot().scrolled, grown.scrolled, 'native counter regression starts a fresh baseline');
  frame(1, ['reset'], ['last', 'next'], 20);
  await settle();
  assert.equal(mirror.snapshot().scrolled, grown.scrolled + 1, 'new output advances from the reset baseline');
});

test('rows already within the mirror width retain their text, colors, blanks and scroll counter', async () => {
  const { child, spawn } = fake();
  const mirror = new ConsoleMirror({ pid: 1, spawn, cols: 8, rows: 3 });
  mirror.start();
  line(child, { type: 'frame', cols: 8, default: 7, scrolled: 9,
    lines: [[[4, 'red'], [7, '|end']], [], [[7, '12345678']]], history: [[[7, 'older']]] });
  await settle();
  assert.deepEqual(mirror.snapshot().lines.map(unmarked), ['red|end', '', '12345678']);
  assert.equal(mirror.snapshot().lines[0], '|cffcd0000red|r|cffd4d4d4||end|r ');
  assert.equal(mirror.snapshot().scrolled, 9);
  assert.equal(mirror.plain(), 'red|end\r\n\r\n12345678');
});

test('shrinking and restoring a TUI row never ratchets a reader into history', async () => {
  const { child, spawn } = fake();
  const mirror = new ConsoleMirror({ pid: 1, spawn, cols: 4, rows: 2 });
  mirror.start();
  const frame = middle => line(child, { type: 'frame', cols: 12, default: 7, scrolled: 0,
    lines: [[[7, 'aaaa']], [[7, middle]], [[7, 'cccc']]], history: [[[7, 'old0']], [[7, 'old1']]] });
  frame('bbbbbbbb'); await settle();
  const original = mirror.snapshot();
  assert.equal(original.scrolled, 2);
  for (let redraw = 0; redraw < 3; redraw++) {
    frame('bbbb'); await settle();
    assert.equal(mirror.snapshot().scrolled, original.scrolled, 'shrinking is not a native counter restart');
    frame('bbbbbbbb'); await settle();
    assert.equal(mirror.snapshot().scrolled, original.scrolled, 'restoring the same continuation is not new output');
    assert.deepEqual(mirror.snapshot().history, original.history, 'the history rows return to their original positions');
  }
  frame('bbbbbbbbbbbb'); await settle();
  assert.equal(mirror.snapshot().scrolled, original.scrolled + 1, 'a genuinely new continuation still advances');
});

test('zero history keeps no wrapped overflow and invalid widths are rejected before splitting', () => {
  const mirror = new ConsoleMirror({ pid: 1, cols: 4, rows: 1, historyRows: 0 });
  mirror.frame = { cols: 12, default: 7, lines: [[[7, 'aaaabbbbcccc']]], history: [[[7, 'older']]] };
  assert.deepEqual(mirror.snapshot().lines.map(unmarked), ['cccc']);
  assert.deepEqual(mirror.snapshot().history, []);
  for (const cols of [0, -1, 1.5, 241]) {
    mirror.cols = cols;
    assert.throws(() => mirror.snapshot(), /Invalid console mirror columns/u);
  }
});

test('history longer than one render batch comes through whole', async () => {
  const { child, spawn } = fake();
  // The default history depth, which is what a mirrored console runs with unless asked otherwise.
  const mirror = new ConsoleMirror({ pid: 1, spawn, cols: 6, rows: 2 });
  mirror.start();
  line(child, {
    type: 'frame', cols: 6, rows: 2, default: 7, cursor: [0, 0], scrolled: 0,
    lines: [[[7, 'a']], [[7, 'b']]],
    history: Array.from({ length: 150 }, (_, index) => [[7, `h${index}`]]),
  });
  await settle();
  const snapshot = mirror.snapshot();
  assert.equal(snapshot.history.length, 150, 'the renderer batches rows rather than refusing them');
  assert.match(snapshot.history[0], /h0/u);
  assert.match(snapshot.history.at(-1), /h149/u);
});

test('the helper going away is reported as an exit, not only as an error message', async () => {
  const { child, spawn } = fake();
  const exits = [];
  const mirror = new ConsoleMirror({ pid: 55, spawn, onExit: code => exits.push(code) });
  mirror.start();
  child.emit('exit', 1);
  await settle();
  assert.deepEqual(exits, [1], 'a reader should not have to parse an error string to know');

  const stopped = [];
  const quiet = new ConsoleMirror({ pid: 56, spawn: fake().spawn, onExit: code => stopped.push(code) });
  quiet.start();
  quiet.stop();
  assert.deepEqual(stopped, [], 'stopping on purpose is not the console closing');
});
