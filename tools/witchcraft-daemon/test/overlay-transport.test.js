import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { OverlayHost } from '../src/overlay-host.js';
import { OverlayChildTransport } from '../src/overlay-child.js';

class IpcEndpoint extends EventEmitter {
  constructor(pid) { super(); this.pid = pid; this.connected = true; this.exitCode = null; this.signalCode = null; this.sent = []; this.killCount = 0; }
  send(message, callback) {
    if (!this.connected) throw new Error('IPC disconnected');
    const copy = structuredClone(message); this.sent.push(copy);
    queueMicrotask(() => {
      if (this.peer.connected) this.peer.emit('message', copy);
      if (!this.suppressCallbacks) callback?.();
    });
    return true;
  }
  disconnect() {
    if (!this.connected) return;
    this.connected = false; this.peer.connected = false;
    queueMicrotask(() => { this.emit('disconnect'); this.peer.emit('disconnect'); });
  }
  kill() {
    this.killCount++;
    this.exitCode = 1;
    this.disconnect();
    queueMicrotask(() => this.emit('exit', 1, null));
    return true;
  }
}
function ipcPair(pid = 4242) {
  const parent = new IpcEndpoint(pid), child = new IpcEndpoint(process.pid);
  parent.peer = child; child.peer = parent;
  return { parent, child, pid };
}
function terminalFixture() {
  const writes = [], sizes = [], disposed = [];
  const sessions = new Map([
    ['claude', { id: 'claude', title: 'Claude', status: 'running', screen: { pending: Promise.resolve(), plain: () => 'Claude authoritative\r\nready', serialize: () => '\u001b[31mClaude authoritative\u001b[0m' } }],
    ['codex', { id: 'codex', title: 'Codex', status: 'running', screen: { pending: Promise.resolve(), plain: () => 'Codex authoritative\r\nready' } }],
  ]);
  return { cols: 120, rows: 40, sessions, writes, sizes, disposed,
    write(tab, data) { writes.push([tab, data]); },
    resize(cols, rows) { this.cols = cols; this.rows = rows; sizes.push([cols, rows]); },
    snapshot() { return []; }, dispose() { disposed.push(true); } };
}
async function connectedFixture(t, terminal = terminalFixture()) {
  const ipc = ipcPair();
  const host = new OverlayHost({ child: ipc.parent, terminal, handshakeTimeoutMs: 500, shutdownTimeoutMs: 100 });
  const overlay = new OverlayChildTransport({ channel: ipc.child, pid: ipc.pid, handshakeTimeoutMs: 500 });
  overlay.on('shutdown', reason => { void overlay.close(reason); });
  const hostReady = host.start(), childReady = overlay.start();
  await Promise.all([hostReady, childReady]);
  t.after(async () => { await overlay.close().catch(() => {}); await host.stop().catch(() => {}); });
  return { ipc, terminal, host, overlay };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('overlay transport: inherited child handshakes then receives an authoritative two-tab snapshot', async t => {
  const { host, overlay } = await connectedFixture(t);
  assert.equal(host.lifecycle, 'ready'); assert.equal(overlay.lifecycle, 'ready');
  assert.equal(overlay.latestState.authoritative, true);
  assert.deepEqual(overlay.latestState.sessions.map(session => [session.id, session.lines[0]]), [
    ['claude', 'Claude authoritative'], ['codex', 'Codex authoritative'], ['copilot', undefined], ['agy', undefined],
  ]);
  assert.equal(overlay.latestState.sessions[0].ansi, '\u001b[31mClaude authoritative\u001b[0m');
  assert.equal(host.lastChildSeq, 0); assert.equal(overlay.lastHostSeq, 2);
});

test('overlay transport: a mirrored terminal uses plain presentation and explicit frame invalidation', async t => {
  const terminal = terminalFixture();
  delete terminal.sessions.get('claude').screen;
  let text = 'before | literal';
  terminal.plain = tab => tab === 'claude' ? text : undefined;
  terminal.snapshot = () => [{ id: 'claude', lines: [`|cffd4d4d4${text}|r`] }];
  const { host, overlay } = await connectedFixture(t, terminal);
  assert.deepEqual(overlay.latestState.sessions[0].lines, ['before | literal']);
  assert.equal(overlay.latestState.sessions[0].ansi, undefined);

  const nextState = once(overlay, 'state');
  text = 'after | literal';
  host.publishState();
  const [updated] = await nextState;
  assert.deepEqual(updated.sessions[0].lines, ['after | literal']);
  assert.equal(updated.generation, 2);
});

test('overlay transport: pathological combining marks are bounded without splitting a grapheme or killing sync', async t => {
  const ipc = ipcPair(), terminal = terminalFixture();
  const pathological = `A${'\u0301'.repeat(5000)}`;
  terminal.sessions.get('claude').screen = { pending: Promise.resolve(), plain: () => pathological,
    serialize: () => pathological };
  const host = new OverlayHost({ child: ipc.parent, terminal, handshakeTimeoutMs: 500, shutdownTimeoutMs: 100 });
  const overlay = new OverlayChildTransport({ channel: ipc.child, pid: ipc.pid, handshakeTimeoutMs: 500 });
  overlay.on('shutdown', reason => { void overlay.close(reason); });
  t.after(async () => { await overlay.close().catch(() => {}); await host.stop().catch(() => {}); });
  await Promise.all([host.start(), overlay.start()]);
  assert.equal(host.lifecycle, 'ready');
  assert.equal(overlay.latestState.sessions[0].lines[0], '');
  assert.equal(overlay.latestState.sessions[0].ansi, pathological);
});

test('overlay transport: only allowlisted terminal commands cross and errors stay in the overlay', async t => {
  const { host, overlay, terminal } = await connectedFixture(t);
  overlay.sendInput('codex', 'hello\r'); overlay.select('codex'); overlay.resize(160, 60);
  await tick(); await tick();
  assert.deepEqual(terminal.writes, [['codex', 'hello\r']]);
  assert.deepEqual(terminal.sizes, [[160, 60]]);
  assert.equal(host.activeTab, 'codex');
  assert.throws(() => overlay.sendInput('other', 'no'), error => error.code === 'INVALID_TAB');
  const failure = once(overlay, 'command-error');
  overlay.sendClipboard('NOTWITCHCRAFT|opaque');
  assert.equal((await failure)[0].code, 'TERMINAL_COMMAND_FAILED');
  assert.deepEqual(terminal.writes, [['codex', 'hello\r']]);
});

test('overlay transport: clipboard body stays opaque after host prefix validation', async t => {
  const { host, overlay } = await connectedFixture(t);
  const received = once(host, 'clipboard');
  const text = 'FAMCLIP1|tab=claude|opaque body 🌕';
  overlay.sendClipboard(text);
  assert.equal((await received)[0], text);
});

test('overlay transport: large UTF-8 output is split intact into sequenced deltas', async t => {
  const { host, overlay } = await connectedFixture(t);
  const chunks = [];
  overlay.on('output', payload => chunks.push(payload.data));
  const data = `start-${'🌕'.repeat(20000)}-end`;
  assert.equal(host.publishOutput('claude', data), true);
  while (chunks.join('').length < data.length) await tick();
  assert.equal(chunks.join(''), data);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(chunk => !chunk.includes('\ufffd')));
});

test('overlay transport: selected tab is authoritative before later output events', async t => {
  const { host, overlay } = await connectedFixture(t);
  const selected = once(overlay, 'state');
  overlay.select('codex');
  assert.equal(overlay.latestState.activeTab, 'codex', 'local state cannot flip back before the host resync arrives');
  assert.equal((await selected)[0].activeTab, 'codex');
  const output = once(overlay, 'output');
  host.publishOutput('codex', 'still on codex');
  await output;
  assert.equal(overlay.latestState.activeTab, 'codex');
  const authoritative = once(overlay, 'state');
  host.publishState();
  assert.equal((await authoritative)[0].activeTab, 'codex');
});

test('overlay transport: child crash retires only presentation and leaves PTY owner alive', async t => {
  const { ipc, host, terminal } = await connectedFixture(t);
  const closed = once(host, 'closed');
  ipc.parent.emit('exit', 9, null);
  const details = (await closed)[0];
  assert.equal(details.unexpected, true);
  assert.equal(host.lifecycle, 'stopped');
  assert.deepEqual(terminal.disposed, []);
  assert.equal(terminal.sessions.get('claude').status, 'running');
});

test('overlay transport: host shutdown completes through child close without timeout', async t => {
  const { ipc, host, overlay, terminal } = await connectedFixture(t);
  const childClosed = once(overlay, 'closed');
  const details = await host.stop('daemon requested shutdown');
  assert.equal((await childClosed)[0].unexpected, false);
  assert.equal(details.unexpected, false);
  assert.doesNotMatch(details.reason, /timeout/u);
  assert.equal(ipc.parent.killCount, 0);
  assert.equal(host.lifecycle, 'stopped');
  assert.equal(overlay.lifecycle, 'stopped');
  assert.deepEqual(terminal.disposed, []);
});

test('overlay transport: unexpected IPC disconnect kills the owned live child before recovery', async t => {
  const { ipc, host, terminal } = await connectedFixture(t);
  const closed = once(host, 'closed');
  ipc.child.disconnect();
  const details = (await closed)[0];
  assert.equal(details.unexpected, true);
  assert.equal(ipc.parent.killCount, 1);
  assert.equal(host.lifecycle, 'stopped');
  assert.deepEqual(terminal.disposed, []);
});

test('overlay transport: throwing protocol-error observer cannot suppress disconnect and host recovery', async t => {
  const { ipc, host, overlay, terminal } = await connectedFixture(t);
  overlay.on('protocol-error', () => { throw new Error('renderer observer is gone'); });
  const hostClosed = once(host, 'closed');
  const overlayClosed = overlay.abort('fatal renderer transport failure');
  const [hostDetails, childDetails] = await Promise.all([hostClosed.then(([details]) => details), overlayClosed]);
  assert.equal(childDetails.unexpected, true);
  assert.equal(hostDetails.unexpected, true);
  assert.equal(host.lifecycle, 'stopped');
  assert.equal(overlay.lifecycle, 'stopped');
  assert.equal(ipc.parent.killCount, 1);
  assert.deepEqual(terminal.disposed, []);
});

test('overlay transport: throwing host protocol-error observer cannot suppress child kill and retirement', async t => {
  const { ipc, host, terminal } = await connectedFixture(t);
  host.on('protocol-error', () => { throw new Error('host observer failed'); });
  const hostClosed = once(host, 'closed');
  ipc.child.send({ v: 1, type: 'ping', seq: 0, payload: { nonce: 'replayed-sequence' } });
  const details = (await hostClosed)[0];
  assert.equal(details.unexpected, true);
  assert.equal(host.lifecycle, 'stopped');
  assert.equal(ipc.parent.killCount, 1);
  assert.deepEqual(terminal.disposed, []);
});

test('overlay transport: PID mismatch and replayed sequence fail closed', async () => {
  const first = ipcPair(7001), terminal = terminalFixture();
  const host = new OverlayHost({ child: first.parent, terminal, handshakeTimeoutMs: 100 });
  const ready = host.start();
  first.child.send({ v: 1, type: 'hello', seq: 0, payload: { role: 'electron-overlay', pid: 7002 } });
  await assert.rejects(ready, error => error.code === 'CHILD_MISMATCH');
  assert.deepEqual(terminal.writes, []);

  const second = ipcPair(8001), host2 = new OverlayHost({ child: second.parent, terminal, handshakeTimeoutMs: 100 });
  const client = new OverlayChildTransport({ channel: second.child, pid: 8001, handshakeTimeoutMs: 100 });
  await Promise.all([host2.start(), client.start()]);
  const closed = once(host2, 'closed');
  second.child.send({ v: 1, type: 'ping', seq: 0, payload: { nonce: 'replay' } });
  assert.equal((await closed)[0].unexpected, true);
  assert.deepEqual(terminal.writes, []);
});

test('overlay transport: one resync is in flight and a stalled IPC send retires only the child', async t => {
  const { ipc, host, overlay, terminal } = await connectedFixture(t);
  assert.equal(overlay.requestResync(), true);
  assert.equal(overlay.requestResync(), false);
  await tick(); await tick();
  ipc.parent.suppressCallbacks = true;
  host.sender.sendTimeoutMs = 15;
  const closed = once(host, 'closed');
  host.publishOutput('claude', 'will reach renderer but never drain');
  const details = (await closed)[0];
  assert.match(details.reason, /did not drain/u);
  assert.deepEqual(terminal.disposed, []);
});
