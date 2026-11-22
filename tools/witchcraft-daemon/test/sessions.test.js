import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionSet } from '../src/sessions.js';
import { Outbox } from '../src/outbox.js';

// A stand-in for the spawned pair: it records what it was asked for without starting a process.
class FakePair {
  constructor(options) {
    this.options = options;
    this.written = [];
    this.cols = options.cols ?? 120;
    this.rows = options.rows ?? 40;
    this.sessions = new Map(['claude', 'codex', 'copilot'].map(tab => [tab, {
      id: tab, title: { claude: 'Claude', codex: 'Codex', copilot: 'Copilot' }[tab],
      status: options.commands[tab] ? 'running' : 'not started', screen: {},
    }]));
    this.disposed = 0;
  }
  write(tab, data) { this.written.push([tab, data]); }
  snapshot() {
    return [...this.sessions.values()].map(session => ({ id: session.id, title: session.title, status: session.status, lines: [`${session.id} spawned`], history: [], scrolled: 0 }));
  }
  resize(cols, rows) { this.cols = cols; this.rows = rows; }
  dispose() { this.disposed += 1; return Promise.resolve(); }
}

class FakeMirror {
  constructor(options) { Object.assign(this, options); this.text = []; this.keys = []; this.started = 0; this.stopped = 0; }
  start() { this.started += 1; return this; }
  write(text) { this.text.push(text); return true; }
  key(name) { this.keys.push(name); return true; }
  plain() { return `plain console ${this.pid}`; }
  snapshot() { return { lines: [`console ${this.pid}`], history: ['older'], scrolled: 3, cols: this.cols, rows: 1 }; }
  stop() { this.stopped += 1; }
}

const build = (attach, extra = {}) => {
  const made = [];
  const set = new SessionSet({
    commands: { claude: { file: 'claude', args: [] }, codex: { file: 'codex', args: [] } },
    attach, cwd: '.', cols: 80, rows: 20, history: 50,
    TerminalPair: FakePair,
    ConsoleMirror: function (options) { const mirror = new FakeMirror(options); made.push(mirror); return mirror; },
    ...extra,
  });
  return { set, made };
};

test('an attached tab is not spawned, and the other tab still is', () => {
  const { set, made } = build({ claude: 24492 });
  assert.deepEqual(Object.keys(set.pair.options.commands).filter(tab => set.pair.options.commands[tab]), ['codex'],
    'the attached tab is never launched');
  assert.equal(made.length, 1);
  assert.equal(made[0].pid, 24492);
  assert.equal(made[0].started, 1);
  assert.equal(made[0].rows, 20, 'the mirror is bounded to what the game shows');
  assert.equal(made[0].historyRows, 50);
});

test('both tabs snapshot in order, whichever source is behind them', () => {
  const { set } = build({ claude: 24492 });
  const snapshot = set.snapshot();
  assert.deepEqual(snapshot.map(session => session.id), ['claude', 'codex', 'copilot']);
  assert.deepEqual(snapshot[0].lines, ['console 24492']);
  assert.equal(snapshot[0].scrolled, 3, 'the mirror decides the anchor for an attached tab');
  assert.equal(snapshot[0].title, 'Claude');
  assert.equal(snapshot[0].status, 'running');
  assert.deepEqual(snapshot[1].lines, ['codex spawned']);
});

test('an attached frame explicitly invalidates presentation and exposes plain text without an owned screen', () => {
  const frames = [], data = [];
  const { set, made } = build({ claude: 24492 }, {
    onFrame: tab => frames.push(tab), onData: (...args) => data.push(args),
  });
  made[0].onFrame();
  assert.deepEqual(frames, ['claude']);
  assert.deepEqual(data, [['claude', '']], 'existing onData observers remain compatible');
  assert.equal(set.plain('claude'), 'plain console 24492');
  assert.equal(set.sessions.get('claude').screen, undefined, 'presentation does not imply PTY ownership');
});

test('the game\'s input reaches the console as typing and named keys', () => {
  const { set, made } = build({ claude: 24492 });
  // The outbox sends text with the newline already appended, and actions as their own name.
  set.write('claude', 'deploy the thing\r', 'text');
  set.write('claude', '\x1b[A', 'up');
  set.write('claude', '\x03', 'interrupt');
  assert.deepEqual(made[0].text, ['deploy the thing'], 'the trailing newline becomes a keypress, not literal text');
  assert.deepEqual(made[0].keys, ['enter', 'up', 'interrupt']);
});

test('a spawned tab still takes raw bytes, so nothing about the terminal path changes', () => {
  const { set } = build({ claude: 24492 });
  set.write('codex', 'hello\r', 'text');
  assert.deepEqual(set.pair.written, [['codex', 'hello\r']]);
});

test('an attached tab refuses input that arrives without an action', () => {
  const { set, made } = build({ claude: 24492 });
  assert.throws(() => set.write('claude', 'some keystrokes'), /mirrored/u);
  assert.deepEqual(made[0].text, [], 'a keystroke stream has no meaning for a console we only mirror');
});

test('a mirrored tab whose console has closed refuses input instead of swallowing it', () => {
  const { set, made } = build({ claude: 24492 });
  made[0].onExit(1);
  assert.throws(() => set.write('claude', 'hello\r', 'text'), error => error.code === 'TAB_NOT_RUNNING' && /exited/u.test(error.message));
  assert.deepEqual(made[0].text, []);
  assert.deepEqual(made[0].keys, []);
});

test('a mirrored write the helper refuses is reported, and its Enter is never sent', () => {
  const { set, made } = build({ claude: 24492 });
  made[0].write = () => false;
  assert.throws(() => set.write('claude', 'hello\r', 'text'), { code: 'TAB_NOT_RUNNING' });
  assert.deepEqual(made[0].keys, [], 'Enter must not submit whatever reached the console before the refusal');
  made[0].key = () => false;
  assert.throws(() => set.write('claude', '\x1b[A', 'up'), { code: 'TAB_NOT_RUNNING' });
});

test('the outbox records input to a closed console as dropped, not accepted', () => {
  const { set, made } = build({ claude: 24492 });
  made[0].onExit(1);
  const outbox = new Outbox({ epoch: 'abcd1234', write: (tab, data, action) => set.write(tab, data, action) });
  const result = outbox.accept({ epoch: 'abcd1234', id: 1, tab: 'claude', action: 'text', text: 'hello' });
  assert.equal(result.dropped, true);
  assert.match(result.reason, /exited/u);
});

test('a console that closes marks its tab exited and leaves the other one alone', () => {
  const exits = [];
  const { set, made } = build({ claude: 24492 }, { onExit: tab => exits.push(tab) });
  made[0].onExit(1);
  assert.deepEqual(exits, ['claude']);
  assert.match(set.sessions.get('claude').status, /exited/u);
  assert.equal(set.sessions.get('codex').status, 'running');
  // The last screen stays on show; a closed console should not blank the tab in game.
  assert.deepEqual(set.snapshot()[0].lines, ['console 24492']);
});

test('a closed console can be re-attached to a new pid in place', () => {
  const exits = [];
  const { set, made } = build({ claude: 5 }, { onExit: tab => exits.push(tab) });
  made[0].onExit(1);
  assert.equal(set.sessions.get('claude').status, 'exited (console 5 closed)');
  set.resize(100, 30, 'game');
  const session = set.reattach('claude', 9);
  assert.equal(session, set.sessions.get('claude'));
  assert.equal(set.sessions.get('claude').status, 'running');
  assert.equal(set.sessions.get('claude').title, 'Claude');
  assert.equal(set.pid('claude'), 9);
  assert.equal(made.length, 2);
  assert.equal(made[0].stopped, 1, 'the closed console\'s mirror is put down');
  assert.equal(made[1].started, 1);
  assert.deepEqual([made[1].pid, made[1].cols, made[1].rows, made[1].historyRows], [9, 100, 30, 50],
    'the new mirror takes the set\'s current size');
  assert.deepEqual(set.snapshot()[0].lines, ['console 9']);
  // A late exit from the replaced mirror says nothing about the console that took its place.
  made[0].onExit(1);
  assert.equal(set.sessions.get('claude').status, 'running');
  made[1].onExit(1);
  assert.equal(set.sessions.get('claude').status, 'exited (console 9 closed)');
  assert.deepEqual(exits, ['claude', 'claude']);
});

test('re-attaching a spawned tab or an unknown tab is refused', () => {
  const { set, made } = build({ claude: 5 });
  assert.throws(() => set.reattach('codex', 9), { code: 'TAB_NOT_ATTACHED' });
  assert.throws(() => set.reattach('browser', 9), { code: 'TAB_NOT_ATTACHED' });
  assert.throws(() => set.reattach('claude', 0), TypeError);
  assert.equal(made.length, 1);
  assert.equal(made[0].stopped, 0, 'a refused re-attach leaves the working mirror alone');
});

test('the bridge keeps running while any spawned tab lives, and an attached tab never ends it', () => {
  const { set, made } = build({ claude: 24492 });
  made[0].onExit(1);
  assert.equal(set.finished(), false, 'codex is still spawned and running');

  const attachedOnly = build({ claude: 24492, codex: 37272 });
  attachedOnly.made[0].onExit(1);
  attachedOnly.made[1].onExit(1);
  assert.equal(attachedOnly.set.finished(), false,
    'a console you closed can be reopened, so the bridge waits rather than stopping');
});

test('a mixed attached and spawned session set stays alive when its spawned tab exits', () => {
  const { set, made } = build({ claude: 24492 });
  set.pair.sessions.get('codex').status = 'exited (0)';
  assert.equal(set.sessions.get('claude').status, 'running');
  assert.equal(set.finished(), false, 'the attached console must retain its mirror and overlay');
  made[0].onExit(0);
  assert.equal(set.finished(), false, 'attached mode keeps its existing persistent lifetime');

  const spawnedOnly = build({});
  spawnedOnly.set.pair.sessions.get('claude').status = 'exited (0)';
  assert.equal(spawnedOnly.set.finished(), false);
  spawnedOnly.set.pair.sessions.get('codex').status = 'exited (0)';
  assert.equal(spawnedOnly.set.finished(), true, 'both owned terminals exiting still ends spawned-only mode');
});

test('a mirrored tab is not offered to the local display, which can only draw a spawned screen', () => {
  const { set } = build({ claude: 24492 });
  assert.equal(set.sessions.get('claude').screen, undefined);
  assert.ok(set.sessions.get('codex').screen, 'a spawned tab still carries the screen the display reads');
});

test('stopping puts down both sources', async () => {
  const { set, made } = build({ claude: 24492 });
  await set.dispose();
  assert.equal(made[0].stopped, 1);
  assert.equal(set.pair.disposed, 1);
  const moved = build({ claude: 24492 });
  moved.set.reattach('claude', 9);
  await moved.set.dispose();
  assert.equal(moved.made[1].stopped, 1, 'a re-attached mirror is stopped too');
});

test('a multi-line paste reaches a mirrored console as typed markers and lines, then one Enter', () => {
  const { set, made } = build({ claude: 24492 });
  set.write('claude', '\x1b[200~first\rsecond\x1b[201~\r', 'paste');
  assert.deepEqual(made[0].text, ['\x1b[200~first\rsecond\x1b[201~'], 'the paste is typed whole');
  assert.deepEqual(made[0].keys, ['enter'], 'the trailing return submits once');
  set.write('codex', '\x1b[200~a\rb\x1b[201~\r', 'paste');
  assert.deepEqual(set.pair.written, [['codex', '\x1b[200~a\rb\x1b[201~\r']], 'a spawned tab takes the paste as bytes');
});

test('once the game asks for a width, the daemon window changes only the rows', () => {
  const { set, made } = build({ claude: 24492 });
  set.resize(180, 40, 'game');
  assert.equal(set.cols, 180); assert.equal(made[0].cols, 180, 'the mirror wraps at the pane width');
  assert.deepEqual([set.pair.cols, set.pair.rows], [180, 40], 'spawned terminals take the pane width');
  set.resize(100, 30);
  assert.deepEqual([set.cols, set.rows, set.pair.cols, set.pair.rows], [180, 30, 180, 30]);
  set.resize(150, 30, 'game');
  assert.equal(set.pair.cols, 150, 'a later game request still wins');
});
