import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { attachTerminal } from '../src/pty.js';

function fixture(options = {}) {
  const stdin = new EventEmitter(), stdout = new EventEmitter();
  const writes = [], output = [], errors = [], raw = [], sizes = [];
  stdin.isTTY = true; stdin.isRaw = false;
  stdin.resume = () => {}; stdin.pause = () => {}; stdin.setRawMode = value => raw.push(value);
  stdout.write = text => output.push(text); stdout.columns = 90; stdout.rows = 30;
  const makeSession = (id, x, y) => ({ status: 'running', screen: { plain: () => `${id} screen`,
    terminal: { cols: 120, rows: 40, buffer: { active: { cursorX: x, cursorY: y } } } } });
  const pair = { sessions: new Map([['claude', makeSession('claude', 2, 3)], ['codex', makeSession('codex', 6, 8)]]),
    write: (tab, data) => writes.push([tab, data]), resize: (...size) => sizes.push(size) };
  if (options.inactive) pair.sessions.get(options.inactive).status = 'not started';
  // A mirrored tab carries no xterm screen: the console it shows lives in its own window.
  if (options.mirrored) { const session = pair.sessions.get(options.mirrored); delete session.screen; session.mirrored = true; }
  const attached = attachTerminal(pair, { stdin, stdout, onError: error => errors.push(error.message), initialTab: options.initialTab });
  return { stdin, stdout, pair, attached, writes, output, errors, raw, sizes };
}

test('terminal input: Ctrl+] routes both live tabs independently and restores target cursor', t => {
  const f = fixture(); t.after(() => f.attached.dispose());
  f.stdin.emit('data', Buffer.from('hello\x1dworld\x1dback'));
  assert.deepEqual(f.writes, [['claude', 'hello'], ['codex', 'world'], ['claude', 'back']]);
  assert.equal(f.output[0], '\x1b[0m\x1b[2J\x1b[Hcodex screen\x1b[9;7H');
  assert.equal(f.output[1], '\x1b[0m\x1b[2J\x1b[Hclaude screen\x1b[4;3H');
});

test('terminal input: single running terminal is selected and inactive tabs are skipped', t => {
  const f = fixture({ inactive: 'claude', initialTab: 'claude' }); t.after(() => f.attached.dispose());
  assert.doesNotThrow(() => f.stdin.emit('data', Buffer.from('hello\x1dagain')));
  assert.deepEqual(f.writes, [['codex', 'hello'], ['codex', 'again']]);
  assert.deepEqual(f.errors, []);
});

test('terminal input: child exits or write failures report without crashing or misrouting', t => {
  const f = fixture(); t.after(() => f.attached.dispose());
  f.stdin.emit('data', Buffer.from('\x1d'));
  f.pair.sessions.get('codex').status = 'exited (0)';
  assert.doesNotThrow(() => f.stdin.emit('data', Buffer.from('intended for codex')));
  assert.deepEqual(f.writes, []); assert.match(f.errors[0], /codex terminal is not running/u);
  f.stdin.emit('data', Buffer.from('\x1dClaude still works'));
  assert.deepEqual(f.writes, [['claude', 'Claude still works']]);
  f.pair.write = () => { throw new Error('write failed'); };
  assert.doesNotThrow(() => f.stdin.emit('data', Buffer.from('next')));
  assert.equal(f.errors.at(-1), 'write failed');
});

test('terminal input: UTF-8 survives arbitrary stdin Buffer boundaries before tab routing', t => {
  const f = fixture(); t.after(() => f.attached.dispose());
  const input = Buffer.from('éПривіт🌕');
  for (const byte of input) f.stdin.emit('data', Buffer.from([byte]));
  assert.equal(f.writes.map(([, text]) => text).join(''), 'éПривіт🌕');
  assert.ok(f.writes.every(([tab]) => tab === 'claude'));
  f.stdin.emit('data', Buffer.from('\x1d\x03'));
  assert.deepEqual(f.writes.at(-1), ['codex', '\x03']);
});

test('terminal input: resize errors, output errors and teardown stay contained', () => {
  const f = fixture();
  f.stdout.emit('resize'); assert.deepEqual(f.sizes, [[90, 30]]);
  f.pair.resize = () => { throw new Error('resize failed'); };
  assert.doesNotThrow(() => f.stdout.emit('resize')); assert.equal(f.errors.at(-1), 'resize failed');
  f.stdout.write = () => { throw new Error('output closed'); };
  assert.doesNotThrow(() => f.attached.output('claude', 'data')); assert.equal(f.errors.at(-1), 'output closed');
  f.attached.dispose(); f.attached.dispose();
  assert.deepEqual(f.raw, [true, false]);
  assert.equal(f.stdin.listenerCount('data'), 0); assert.equal(f.stdout.listenerCount('resize'), 0);
  f.stdin.emit('data', Buffer.from('ignored')); assert.deepEqual(f.writes, []);
});

test('terminal input: a mirrored tab is skipped, because its console has its own window', t => {
  const f = fixture({ mirrored: 'claude' }); t.after(() => f.attached.dispose());
  // Claude is mirrored from a console the user already sees, so the local display starts on the
  // tab it can actually draw and Ctrl+] does not park on a blank screen.
  f.stdin.emit('data', Buffer.from('typed'));
  assert.deepEqual(f.writes, [['codex', 'typed']]);
  f.stdin.emit('data', Buffer.from('\x1dmore'));
  assert.deepEqual(f.writes, [['codex', 'typed'], ['codex', 'more']], 'there is no second tab to switch to');
});
