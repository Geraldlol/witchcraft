import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import luaparse from 'luaparse';
import { runBridge } from '../bin/witchcraft.js';
import { initializeRing } from '../src/init.js';
import { encodeMessage, encodeContext, encodeHeartbeat } from '../src/pixel.js';
import { readContextFile } from '../src/context-cache.js';
import { BINDING_KEYS, BINDING_PROBE_BODY, encodeBindingAction } from '../src/binding-carrier.js';
import { atomicWrite } from '../src/ring.js';
import { encodeCooldownContext, encodeCooldownFrame } from '../src/cooldown-carrier.js';
import { cooldownLayout } from './helpers/cooldown-layout.js';
import { contextWantPath, requestContext } from '../src/context-want.js';

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(predicate, label, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await sleep(10); }
  throw new Error(`${label} timed out`);
}
async function within(promise, timeout = 4000) {
  let timer;
  try { return await Promise.race([promise, new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('Bridge did not stop')), timeout); })]); }
  finally { clearTimeout(timer); }
}

function chunkPayload(source) {
  const ast = luaparse.parse(source, { encodingMode: 'pseudo-latin1' });
  assert.equal(ast.body.length, 1);
  const call = ast.body[0].expression;
  assert.equal(call.type, 'CallExpression'); assert.equal(call.base.name, 'Witchcraft_ReceiveChunk');
  function literal(node) {
    if (node.type === 'StringLiteral') return Buffer.from(node.value, 'latin1').toString('utf8');
    if (['NumericLiteral', 'BooleanLiteral'].includes(node.type)) return node.value;
    if (node.type === 'NilLiteral') return null;
    assert.equal(node.type, 'TableConstructorExpression');
    if (node.fields.every(field => field.type === 'TableValue')) return node.fields.map(field => literal(field.value));
    return Object.fromEntries(node.fields.map(field => [literal(field.key), literal(field.value)]));
  }
  return literal(call.arguments[0]);
}

function image(top, heartbeat, foreground = true) {
  const data = Buffer.alloc(132 * 12 * 4);
  for (const [row, cells] of [top, heartbeat].entries()) {
    if (!cells) continue;
    cells.forEach((rgb, index) => {
      for (let y = 0; y < 6; y++) for (let x = 0; x < 6; x++)
        data.set([...rgb, 255], (((row * 6 + y) * 132) + index * 6 + x) * 4);
    });
  }
  return { width: 132, height: 12, data, foreground };
}

async function fixture(t, settings = {}) {
  const tempRoot = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(tempRoot, 'witchcraft-bridge-'));
  const addonsDir = path.join(root, 'AddOns'), localDir = path.join(root, 'local'), accountDir = path.join(root, 'account');
  const characterDir = path.join(root, 'character');
  const ringSize = settings.ringSize ?? 3;
  await fs.mkdir(addonsDir); await initializeRing({ addonsDir, ringSize });
  if (settings.binding) await fs.mkdir(accountDir);
  if (settings.cooldown) await fs.mkdir(characterDir);
  const state = { writes: [], pairDisposed: 0, displayDisposed: 0, captureStopped: 0, unwatched: 0,
    overlayStarted: 0, overlayStopped: 0, overlayOutput: [], overlayStatus: [], overlayFrames: 0,
    snapshotError: settings.snapshotError, settled: false };
  const initialSignals = { int: process.listenerCount('SIGINT'), term: process.listenerCount('SIGTERM'),
    hup: process.listenerCount('SIGHUP'), break: process.listenerCount('SIGBREAK') };
  class Pair {
    constructor(options) {
      state.options = options;
      if (settings.startupFailure) {
        const error = new Error('synthetic partial startup failure');
        error.cleanup = Promise.resolve().then(() => { state.partialCleaned = true; });
        throw error;
      }
      this.cols = options.cols; this.rows = options.rows; this.options = options;
      this.sessions = new Map(['claude', 'codex', 'copilot'].map(tab => [tab, { status: options.commands[tab] ? 'running' : 'not started' }]));
      state.pair = this;
    }
    write(tab, text) { state.writes.push([tab, text]); }
    snapshot() { if (state.snapshotError) throw state.snapshotError; return ['claude', 'codex', 'copilot'].map(id => ({ id, title: id, status: this.sessions.get(id).status,
      lines: Array.from({ length: this.rows }, (_, index) => `${id} row ${index}`),
      ...(settings.history ? { history: settings.history.map(line => `${id} ${line}`) } : {}) })); }
    async dispose() { state.pairDisposed++; if (settings.disposeFailure) throw new Error('synthetic dispose failure'); }
    emit(tab, data) { this.options.onData(tab, data); }
    finish() { for (const session of this.sessions.values()) session.status = 'exited (0)'; this.options.onExit(); }
  }
  class Capture {
    constructor(options) { this.options = options; state.capture = this; }
    start() { this.started = true; }
    stop() { state.captureStopped++; this.started = false; }
    emit(frame) { this.options.onFrame(frame); }
    fail(error) { this.options.onError(error); }
  }
  const config = { repoRoot: root, addonsDir, ringSize, region: { x: 0, y: 0, width: 132, height: 12 },
    savedVariables: path.join(root, 'Witchcraft.lua') };
  if (settings.noRegion) delete config.region;
  if (settings.binding) config.accountDir = accountDir;
  if (settings.cooldown) { config.cooldownCarrier = true; config.characterDir = characterDir; }
  if (settings.configOverlay) config.overlay = true;
  if (settings.commands) config.commands = settings.commands;
  const adapters = { TerminalPair: Pair, Capture, localDir, ...(settings.writeContext ? { writeContext: settings.writeContext } : {}),
    overlay: settings.overlay ? undefined : false,
    createOverlay() { return {
      on() {},
      async start() { state.overlayStarted++; await settings.overlayStart?.(state); },
      publishOutput(tab, data) { state.overlayOutput.push([tab, data]); },
      publishStatus(tab, status) { state.overlayStatus.push([tab, status]); },
      publishState() { state.overlayFrames++; },
      async stop() { state.overlayStopped++; await settings.overlayStop?.(state); },
    }; },
    attachTerminal() { return { output() {}, dispose() { state.displayDisposed++; } }; },
    watchSavedVariables(filename, callbacks) { state.watch = callbacks; return () => { state.unwatched++; }; },
    // Discovery reads the user's own Claude and Codex records; fixtures find nothing unless a test says so.
    async findClaudeSession() { return undefined; }, async findCodexThread() { return undefined; },
    // A session joining found stays alive unless a test restarts it.
    async claudeSessionAlive() { return true; },
    createSessionInfo() { return { start() { return this; }, stop() {}, get() { return {}; } }; },
    ...settings.adapters };
  const running = runBridge(config, { cols: 40, rows: 10, hz: 0.125, ...(settings.pixels ? { pixels: true } : {}),
    ...(settings.noPixels ? { noPixels: true } : {}), ...settings.options }, [], adapters);
  void running.then(() => { state.settled = true; }, () => { state.settled = true; });
  const lockPath = path.join(localDir, 'bridge.lock');
  t.after(async () => {
    if (!state.settled) state.pair?.finish();
    await within(running).catch(() => {});
    assert.equal(process.listenerCount('SIGINT'), initialSignals.int);
    assert.equal(process.listenerCount('SIGTERM'), initialSignals.term);
    assert.equal(process.listenerCount('SIGHUP'), initialSignals.hup);
    assert.equal(process.listenerCount('SIGBREAK'), initialSignals.break);
    const resolved = await fs.realpath(root);
    assert.equal(path.dirname(resolved), tempRoot);
    assert.match(path.basename(resolved), /^witchcraft-bridge-/u);
    await fs.rm(resolved, { recursive: true, force: true });
  });
  async function payload(seq, predicate = () => true) {
    const filename = path.join(addonsDir, `Witchcraft_Chunk_${String(seq).padStart(4, '0')}`, 'Chunk.lua');
    return until(async () => {
      // Windows refuses the read while the daemon renames the next chunk over this path; that is a
      // moment to retry, not a failure, and swallowing it keeps the timeout the only verdict.
      let source;
      try { source = await fs.readFile(filename, 'utf8'); } catch { return false; }
      const value = chunkPayload(source);
      return predicate(value) && value;
    }, 'Chunk publication');
  }
  return { state, config, adapters, running, lockPath, payload, characterDir,
    ready: () => until(() => (settings.noRegion || settings.noPixels || (settings.binding && !settings.pixels) || state.capture?.started) && state.watch, 'Bridge startup') };
}

test('bridge: the overlay stays off unless it is asked for', async t => {
  const f = await fixture(t, { overlay: true }); await f.ready();
  assert.equal(f.state.overlayStarted, 0, 'a default run starts no overlay process');
  f.state.pair.finish();
  assert.equal(await within(f.running), undefined);
});

test('bridge: overlay: true in the config starts it like --overlay', async t => {
  const f = await fixture(t, { overlay: true, configOverlay: true }); await f.ready();
  await until(() => f.state.overlayStarted === 1, 'Overlay startup');
});

test('bridge: a requested overlay receives live PTY output and closes without owning either PTY', async t => {
  const f = await fixture(t, { overlay: true, options: { overlay: true } }); await f.ready();
  await until(() => f.state.overlayStarted === 1, 'Overlay startup');
  assert.equal(f.state.overlayStarted, 1);
  f.state.pair.emit('codex', 'live delta');
  assert.deepEqual(f.state.overlayOutput, [['codex', 'live delta']]);
  f.state.pair.finish();
  assert.equal(await within(f.running), undefined);
  assert.equal(f.state.overlayStopped, 1);
  assert.equal(f.state.pairDisposed, 1);
});

test('bridge: an overlay still starting holds up neither the game link nor a clean stop', async t => {
  let resume;
  const delayed = new Promise(resolve => { resume = resolve; });
  t.after(() => resume());
  const f = await fixture(t, { overlay: true, options: { overlay: true },
    overlayStart: async state => { await delayed; state.overlayLive = true; },
    overlayStop: state => { state.overlayLive = false; } });
  await f.ready();
  await until(() => f.state.overlayStarted, 'Overlay startup');
  assert.ok(f.state.capture.started, 'the strip is read while the overlay is still starting');
  await f.payload(1);
  f.state.pair.finish();
  f.state.pair.finish();
  await until(() => f.state.overlayStopped === 1, 'Startup cancellation');
  assert.ok(await fs.stat(f.lockPath), 'an unfinished acquisition still belongs to this bridge');
  assert.equal(f.state.settled, false);
  resume();
  assert.equal(await within(f.running), undefined);
  assert.equal(f.state.overlayStopped, 2, 'a late acquisition is stopped after start settles');
  assert.equal(f.state.overlayLive, false);
  assert.equal(f.state.pairDisposed, 1);
  assert.equal(f.state.unwatched, 1);
  await assert.rejects(fs.stat(f.lockPath), { code: 'ENOENT' });
});

test('bridge: stop unblocks a pending service start and preserves startup and disposal failures', async t => {
  let rejectStart, started = false, stopCalls = 0;
  const failure = new Error('synthetic asynchronous startup failure');
  const delayed = new Promise((resolve, reject) => { rejectStart = reject; });
  t.after(() => rejectStart(failure));
  const f = await fixture(t, { binding: true, disposeFailure: true,
    adapters: { BindingReceiver: class {}, BindingCarrier: class {
      start() { started = true; return delayed; }
      stop() { stopCalls++; rejectStart(failure); }
    } } });
  await until(() => started, 'Service startup');
  f.state.pair.finish();
  const error = await within(f.running);
  assert.ok(error instanceof AggregateError);
  assert.ok(error.errors.includes(failure), 'the original startup failure is retained');
  assert.equal(error.errors.filter(item => item === failure).length, 1);
  assert.match(error.message, /synthetic dispose failure/u);
  assert.equal(stopCalls, 2);
  assert.equal(f.state.pairDisposed, 1);
  assert.equal(f.state.capture, undefined);
  assert.equal(f.state.watch, undefined);
  await assert.rejects(fs.stat(f.lockPath), { code: 'ENOENT' });
});

test('bridge: a fatal first snapshot stops without waiting on its own startup', async t => {
  const failure = new Error('synthetic first snapshot failure');
  const f = await fixture(t, { snapshotError: failure });
  const error = await within(f.running);
  assert.ok(error instanceof AggregateError);
  assert.ok(error.errors.includes(failure));
  assert.equal(f.state.pairDisposed, 1);
  assert.equal(f.state.capture, undefined);
  assert.equal(f.state.watch, undefined);
  await assert.rejects(fs.stat(f.lockPath), { code: 'ENOENT' });
});

test('bridge: a reply the Lua serializer refuses skips that frame and keeps both sessions alive', async t => {
  let reply = ['half a pair \ud83c'], changed;
  const f = await fixture(t, { adapters: { createSessionInfo(options) {
    changed = options.onChange;
    return { start() { return this; }, stop() {}, get(tab) { return tab === 'claude' ? { reply } : {}; } };
  } } });
  await f.ready();
  const nonce = '12345678', traceFile = path.join(path.dirname(f.lockPath), 'trace.log');
  f.state.capture.emit(image(null, encodeHeartbeat('00000000', 2, 0, nonce)));
  await until(async () => (await fs.readFile(traceFile, 'utf8').catch(() => '')).includes('"what":"publish-error"'), 'Refused publish');
  assert.equal(f.state.settled, false, 'display content must not stop the bridge');
  assert.equal(f.state.pairDisposed, 0);
  reply = ['a whole reply']; changed();
  const payload = await f.payload(2, value => value.uiNonce === nonce && value.sessions[0].reply?.[0] === 'a whole reply');
  assert.equal(payload.sessions[1].id, 'codex');
  f.state.pair.finish(); assert.equal(await within(f.running), undefined);
});

test('bridge: a joined Claude session without the WoW tools is flagged until its server announces itself', async t => {
  class Mirror {
    start() {}
    stop() {}
    snapshot() { return { lines: ['claude console'], history: [], scrolled: 0 }; }
  }
  // Joining found this process as the Claude session; it has started no WoW MCP server yet.
  const f = await fixture(t, { adapters: { ConsoleMirror: Mirror, presencePollMs: 20,
    async findClaudeSession() { return { pid: process.pid }; } } });
  try {
    await f.ready();
    f.state.capture.emit(image(null, encodeHeartbeat('00000000', 2, 0, '12345678')));
    const flagged = await f.payload(2, value => value.uiNonce === '12345678' && value.sessions[0].tools === false);
    assert.equal(flagged.sessions[1].tools, undefined, 'a spawned tab was given the server by its launcher');
    // The player ran mcp-setup and restarted Claude: its server records this process as its client.
    const dir = path.join(path.dirname(f.lockPath), 'mcp-clients');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, ppid: process.pid, startedAt: Date.now() }));
    f.state.capture.emit(image(null, encodeHeartbeat(flagged.epoch, 3, 0, '12345678')));
    await f.payload(3, value => value.uiNonce === '12345678' && value.sessions[0].tools === undefined);
  } finally {
    process.emit('SIGTERM'); await within(f.running).catch(() => {});
  }
});

test('bridge: a Claude restarted in the mirrored console is followed, and only its own server clears the notice', async t => {
  class Mirror {
    start() {}
    stop() {}
    snapshot() { return { lines: ['claude console'], history: [], scrolled: 0 }; }
  }
  // The joined session (this process) restarts in the same console as process.ppid, a live pid.
  let restarted = false;
  const f = await fixture(t, { ringSize: 5, adapters: { ConsoleMirror: Mirror, presencePollMs: 20,
    async findClaudeSession() { return { pid: restarted ? process.ppid : process.pid }; },
    async claudeSessionAlive(pid) { return pid === (restarted ? process.ppid : process.pid); } } });
  const dir = path.join(path.dirname(f.lockPath), 'mcp-clients');
  const announce = async (pid, ppid) => { await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${pid}.json`), JSON.stringify({ pid, ppid, startedAt: Date.now() })); };
  try {
    await f.ready();
    await announce(process.pid, process.pid);
    f.state.capture.emit(image(null, encodeHeartbeat('00000000', 2, 0, '12345678')));
    const first = await f.payload(2, value => value.uiNonce === '12345678' && value.sessions[0].tools === undefined);
    // Restarted without the tools: the old session's server says nothing about the new one.
    restarted = true;
    await fs.rm(path.join(dir, `${process.pid}.json`));
    f.state.capture.emit(image(null, encodeHeartbeat(first.epoch, 3, 0, '12345678')));
    const flagged = await f.payload(3, value => value.uiNonce === '12345678' && value.sessions[0].tools === false);
    // Its own server announces itself under the new pid: the notice clears.
    await announce(process.pid, process.ppid);
    f.state.capture.emit(image(null, encodeHeartbeat(flagged.epoch, 4, 0, '12345678')));
    await f.payload(4, value => value.uiNonce === '12345678' && value.sessions[0].tools === undefined);
  } finally {
    process.emit('SIGTERM'); await within(f.running).catch(() => {});
  }
});

test('bridge: a console mirror failure is recorded in the event log, not only on stderr', async t => {
  class Mirror {
    constructor(options) { this.options = options; }
    start() { this.options.onError(new Error('console mirror for process 1234 exited (3)')); }
    stop() {}
    snapshot() { return { lines: [], history: [], scrolled: 0 }; }
  }
  const f = await fixture(t, { options: { attach: { claude: { pid: 1234 } } }, adapters: { ConsoleMirror: Mirror } });
  try {
    await f.ready();
    const log = await fs.readFile(path.join(path.dirname(f.lockPath), 'events.log'), 'utf8').catch(() => '');
    assert.match(log, /"lane":"mirror","outcome":"error","reason":"console mirror for process 1234 exited \(3\)"/u);
  } finally {
    // Attached mode lives until an explicit stop, so stop it even when an assertion fails.
    process.emit('SIGTERM'); await within(f.running).catch(() => {});
  }
});

test('bridge: a mirrored console frame invalidates the overlay snapshot', async t => {
  let frame;
  class Mirror {
    constructor(options) { frame = options.onFrame; }
    start() {}
    stop() {}
    snapshot() { return { lines: ['console frame'], history: [], scrolled: 0 }; }
  }
  const f = await fixture(t, { overlay: true, options: { overlay: true, attach: { claude: { pid: 1234 } } }, adapters: { ConsoleMirror: Mirror } });
  await f.ready();
  frame();
  assert.equal(f.state.overlayFrames, 1);
  // Attached mode remains available when a spawned tab exits; an explicit stop owns teardown.
  process.emit('SIGTERM');
  assert.equal(await within(f.running), undefined);
  assert.equal(f.state.pairDisposed, 1);
});

test('bridge: a joined Claude console that closes is followed to the session started in its place', async t => {
  const made = [];
  class Mirror {
    constructor(options) { this.options = options; made.push(this); }
    start() {}
    stop() { this.stopped = true; }
    snapshot() { return { lines: ['claude console'], history: [], scrolled: 0 }; }
  }
  let live = 11, pidOf;
  const f = await fixture(t, { overlay: true, options: { overlay: true, noMcp: true }, adapters: { ConsoleMirror: Mirror,
    presencePollMs: 20, async findClaudeSession() { return live && { pid: live }; },
    createSessionInfo(options) { pidOf = options.pid; return { start() { return this; }, stop() {}, get() { return {}; } }; } } });
  try {
    await f.ready();
    await until(() => f.state.overlayStarted === 1, 'Overlay startup');
    assert.deepEqual(made.map(mirror => mirror.options.pid), [11]);
    // The terminal closed; until Claude starts again there is nothing to follow, so the tab waits.
    live = undefined;
    made[0].options.onExit(1);
    assert.deepEqual(f.state.overlayStatus.at(-1), ['claude', 'exited (console 11 closed)']);
    await sleep(80);
    assert.equal(made.length, 1, 'nothing found: no mirror is started');
    live = 12;
    await until(() => made.length === 2, 'Re-attach');
    assert.equal(made[1].options.pid, 12);
    assert.equal(made[0].stopped, true, 'the closed console\'s mirror is put down');
    assert.equal(pidOf('claude'), 12, 'the transcript lookup follows the new process');
    assert.deepEqual(f.state.overlayStatus.at(-1), ['claude', 'running']);
    const log = await fs.readFile(path.join(path.dirname(f.lockPath), 'events.log'), 'utf8');
    assert.match(log, /"kind":"reattach","tab":"claude","pid":12/u);
    await sleep(80);
    assert.equal(made.length, 2, 'a running tab is left alone');
  } finally {
    process.emit('SIGTERM'); await within(f.running).catch(() => {});
  }
});

test('bridge: --attach codex=~codex mirrors the newest console running Codex, and a pattern with no console stops the start', async t => {
  const seen = [], asked = [];
  const candidates = [{ pid: 41, command: 'pwsh.exe', running: 'claude' }, { pid: 42, command: 'pwsh.exe', running: 'Codex.exe resume' },
    { pid: 43, command: 'pwsh.exe', running: 'codex' }];
  const named = await fixture(t, { options: { noMcp: true, attach: { codex: { pattern: 'codex' } } },
    adapters: { ConsoleMirror: recordingMirror(seen), async listConsoles(query) { asked.push(query); return candidates; } } });
  await named.ready();
  assert.deepEqual(seen, [42], 'the newest console whose program mentions codex');
  assert.deepEqual(asked, [{ self: process.pid }], 'the lookup names the daemon, so its own console is passed over');
  assert.equal(named.state.options.commands.codex, null, 'an attached tab is never launched');
  process.emit('SIGTERM'); await within(named.running);
  const missing = await fixture(t, { options: { noMcp: true, attach: { codex: { pattern: 'nothing-runs-this' } } },
    adapters: { ConsoleMirror: recordingMirror(seen), async listConsoles() { return []; } } });
  await assert.rejects(missing.running, /~nothing-runs-this for the codex tab.*witchcraft consoles/u);
  await assert.rejects(fs.access(missing.lockPath), { code: 'ENOENT' }, 'the pattern is resolved before the lock is taken');
});

test('bridge: a ~TEXT console that closes is followed to the newest match, never to the daemon\'s own console', async t => {
  const made = [], asked = [];
  class Mirror {
    constructor(options) { this.options = options; made.push(this); }
    start() {}
    stop() { this.stopped = true; }
    snapshot() { return { lines: ['codex console'], history: [], scrolled: 0 }; }
  }
  let candidates = [{ pid: 21, command: 'pwsh.exe', running: 'codex' }];
  const f = await fixture(t, { overlay: true, options: { overlay: true, noMcp: true, attach: { codex: { pattern: 'codex' } } },
    adapters: { ConsoleMirror: Mirror, presencePollMs: 20, async listConsoles(query) { asked.push(query); return candidates; } } });
  try {
    await f.ready();
    await until(() => f.state.overlayStarted === 1, 'Overlay startup');
    assert.deepEqual(made.map(mirror => mirror.options.pid), [21]);
    // Codex closed. The shell Witchcraft runs in now shows Witchcraft, whose command line carries
    // ~codex; it is the daemon's own console and is passed over for the console Codex restarted in.
    candidates = [{ pid: 30, command: 'pwsh.exe', running: 'node bin/witchcraft.js run --attach codex=~codex', own: true },
      { pid: 22, command: 'pwsh.exe', running: 'codex' }];
    made[0].options.onExit(1);
    await until(() => made.length === 2, 'Re-attach');
    assert.equal(made[1].options.pid, 22, 'the daemon\'s own console is never re-attached');
    assert.ok(asked.length >= 2 && asked.every(query => query.self === process.pid), 'every lookup names the daemon');
  } finally {
    process.emit('SIGTERM'); await within(f.running).catch(() => {});
  }
});

function recordingMirror(seen) {
  return class {
    constructor(options) { seen.push(options.pid); }
    start() {} stop() {}
    snapshot() { return { lines: ['console frame'], history: [], scrolled: 0 }; }
  };
}

test('bridge: by default the Claude tab mirrors the running session and the Codex tab resumes its thread', async t => {
  const seen = [], thread = '01a0cd0c-b928-77f2-993d-026bb0978291', asked = [];
  const f = await fixture(t, { commands: { claude: { file: 'claude', args: [] }, codex: { file: 'codex', args: [] } },
    options: { noMcp: true }, adapters: { ConsoleMirror: recordingMirror(seen),
      async findClaudeSession(query) { asked.push(query.cwd); return { pid: 4321 }; },
      async findCodexThread(query) { asked.push(query.cwd); return { id: thread, source: 'vscode' }; } } });
  await f.ready();
  assert.deepEqual(seen, [4321], 'the found Claude console is mirrored');
  assert.equal(f.state.options.commands.claude, null, 'an attached tab is never launched');
  assert.deepEqual(f.state.options.commands.codex.args, ['resume', thread], 'the spawned Codex resumes the found thread');
  assert.equal(asked.length, 2); assert.ok(asked.every(cwd => path.isAbsolute(cwd)), 'discovery looks in the resolved --cwd');
  process.emit('SIGTERM'); await within(f.running);
});

test('bridge: --no-current and an explicit --attach both win over discovered sessions', async t => {
  const found = { async findClaudeSession() { return { pid: 4321 }; }, async findCodexThread() { return { id: 'x', source: 'vscode' }; } };
  const commands = { claude: { file: 'claude', args: [] }, codex: { file: 'codex', args: [] } };
  const fresh = await fixture(t, { commands, options: { noMcp: true, noCurrent: true }, adapters: found });
  await fresh.ready();
  assert.deepEqual(fresh.state.options.commands.codex.args, [], '--no-current starts a fresh Codex');
  assert.equal(fresh.state.options.commands.claude.file, 'claude', '--no-current launches Claude instead of mirroring');
  process.emit('SIGTERM'); await within(fresh.running);
  const seen = [];
  const named = await fixture(t, { commands, options: { noMcp: true, attach: { claude: { pid: 999 } } },
    adapters: { ...found, ConsoleMirror: recordingMirror(seen) } });
  await named.ready();
  assert.deepEqual(seen, [999], 'the console named with --attach is the one mirrored');
  process.emit('SIGTERM'); await within(named.running);
});

test('bridge: an oversized display snapshot is skipped and later output still publishes', async t => {
  const f = await fixture(t); await f.ready();
  f.state.snapshotError = Object.assign(new TypeError('Lua output exceeds byte budget'), { code: 'LUA_OUTPUT_BUDGET' });
  await f.state.watch.onReset();
  assert.equal(f.state.pairDisposed, 0);
  assert.equal(f.state.settled, false);
  delete f.state.snapshotError;
  const nonce = '12345678';
  f.state.capture.emit(image(null, encodeHeartbeat('00000000', 2, 0, nonce)));
  await f.payload(2, value => value.uiNonce === nonce && value.ready);
  f.state.pair.finish();
  assert.equal(await within(f.running), undefined);
});

test('bridge: a partial local command table keeps the other tab on its default', async t => {
  const f = await fixture(t, { commands: { codex: { file: 'codex.exe', args: [] } } }); await f.ready();
  assert.equal(f.state.pair.sessions.get('claude').status, 'running');
  assert.equal(f.state.pair.sessions.get('codex').status, 'running');
  assert.equal(f.state.options.commands.codex.file, 'codex.exe');
  f.state.pair.finish(); assert.equal(await within(f.running), undefined);
});

test('bridge: binding probe bootstraps LoD and routes input without screen capture', async t => {
  const f = await fixture(t, { binding: true, noPixels: true }); await f.ready();
  const uiNonce = 'abcdef01', bindingFile = path.join(f.config.accountDir, 'bindings-cache.wtf');
  const writeAction = value => fs.writeFile(bindingFile, `bind ${BINDING_KEYS[0]} ${value}\n`);
  const probe = encodeBindingAction({ epoch: '00000000', nonce: '00000000', uiNonce,
    slot: 1, seq: 1, part: 1, count: 1, payload: BINDING_PROBE_BODY });
  await writeAction(probe);
  const connected = await f.payload(1, value => value.uiNonce === uiNonce && value.bindingAck === 1);
  assert.equal(connected.bindingProtocol, 1); assert.match(connected.bindingNonce, /^[0-9a-f]{8}$/u);

  await fs.writeFile(bindingFile, '');
  const id = Buffer.alloc(3); id.writeUIntBE(1, 0, 3);
  const body = Buffer.concat([Buffer.from('I'), id, Buffer.from([1, 0]), Buffer.from('from binding')]);
  const input = encodeBindingAction({ epoch: connected.epoch, nonce: connected.bindingNonce, uiNonce,
    slot: 2, seq: 2, part: 1, count: 1, payload: body });
  await writeAction(input);
  const acknowledged = await f.payload(2, value => value.bindingAck === 2 && value.ack === 1);
  assert.equal(acknowledged.uiNonce, uiNonce);
  assert.deepEqual(f.state.writes, [['codex', 'from binding\r']]);
  f.state.pair.finish(); assert.equal(await within(f.running), undefined);
  assert.equal(f.state.capture, undefined);
});

test('bridge: heartbeat to real chunk, both tab inputs, ACK and clean resource teardown', async t => {
  const f = await fixture(t); await f.ready();
  const nonce = '12345678';
  f.state.capture.emit(image(null, encodeHeartbeat('00000000', 2, 0, nonce)));
  const payload = await f.payload(2, value => value.uiNonce === nonce && value.ready);
  assert.equal(payload.epoch, JSON.parse(await fs.readFile(f.lockPath, 'utf8')).epoch);
  assert.deepEqual(payload.sessions.map(session => session.id), ['claude', 'codex', 'copilot']);
  const heartbeat = encodeHeartbeat(payload.epoch, 2, 0, nonce);
  const first = { epoch: payload.epoch, id: 1, tab: 'codex', action: 'text', text: 'Codex request' };
  for (let repeat = 0; repeat < 2; repeat++) for (const frame of encodeMessage(first)) f.state.capture.emit(image(frame, heartbeat));
  for (const frame of encodeMessage({ ...first, id: 2, tab: 'claude', text: 'Claude request' })) f.state.capture.emit(image(frame, heartbeat));
  assert.deepEqual(f.state.writes, [['codex', 'Codex request\r'], ['claude', 'Claude request\r']]);
  const accepted = await f.payload(2, value => value.ack === 2);
  assert.equal(accepted.changed, true);
  for (const frame of encodeMessage({ ...first, id: 3, text: 'Not foreground' })) f.state.capture.emit(image(frame, heartbeat, false));
  for (const frame of encodeMessage({ ...first, epoch: payload.epoch === 'ffffffff' ? 'eeeeeeee' : 'ffffffff', id: 3 }))
    f.state.capture.emit(image(frame, heartbeat));
  assert.equal(f.state.writes.length, 2);
  f.state.pair.finish(); assert.equal(await within(f.running), undefined);
  await assert.rejects(fs.stat(f.lockPath), { code: 'ENOENT' });
  assert.equal(f.state.pairDisposed, 1); assert.equal(f.state.captureStopped, 1);
  assert.equal(f.state.displayDisposed, 1); assert.equal(f.state.unwatched, 1);
});

test('bridge: UI nonce changes clear incomplete input and reject retired UI demand', async t => {
  const f = await fixture(t); await f.ready();
  const firstNonce = '12345678', nextNonce = '87654321';
  f.state.capture.emit(image(null, encodeHeartbeat('00000000', 2, 0, firstNonce)));
  const first = await f.payload(2, value => value.uiNonce === firstNonce);
  const message = { epoch: first.epoch, id: 1, tab: 'claude', action: 'text', text: 'incomplete '.repeat(8) };
  const frames = encodeMessage(message);
  f.state.capture.emit(image(frames[0], encodeHeartbeat(first.epoch, 2, 0, firstNonce)));
  f.state.capture.emit(image(null, encodeHeartbeat(first.epoch, 1, 0, nextNonce)));
  for (const frame of frames.slice(1)) f.state.capture.emit(image(frame, encodeHeartbeat(first.epoch, 1, 0, nextNonce)));
  assert.deepEqual(f.state.writes, []);
  const reloaded = await f.payload(1, value => value.uiNonce === nextNonce);
  assert.equal(reloaded.epoch, first.epoch);
  f.state.capture.emit(image(null, encodeHeartbeat(first.epoch, 3, 0, firstNonce)));
  assert.equal((await f.payload(3)).ready, false, 'retired UI cannot choose a new writer slot');
  for (const frame of encodeMessage({ ...message, id: 2, tab: 'codex', text: 'new UI' }))
    f.state.capture.emit(image(frame, encodeHeartbeat(first.epoch, 1, 0, nextNonce)));
  assert.deepEqual(f.state.writes, [['codex', 'new UI\r']]);
  await f.payload(1, value => value.ack === 2);
  f.state.pair.finish(); assert.equal(await within(f.running), undefined);
});

test('bridge: capture and dispose failures are preserved while lock and other resources close', async t => {
  const f = await fixture(t, { disposeFailure: true }); await f.ready();
  f.state.capture.fail(new Error('synthetic capture failure'));
  const error = await within(f.running);
  assert.ok(error instanceof AggregateError);
  assert.match(error.message, /synthetic capture failure/u); assert.match(error.message, /synthetic dispose failure/u);
  await assert.rejects(fs.stat(f.lockPath), { code: 'ENOENT' });
  assert.equal(f.state.pairDisposed, 1); assert.equal(f.state.captureStopped, 1);
  assert.equal(f.state.displayDisposed, 1); assert.equal(f.state.unwatched, 1);
});

test('bridge: partial constructor cleanup completes before failed startup releases its lock', async t => {
  const f = await fixture(t, { startupFailure: true });
  const error = await within(f.running);
  assert.match(error.message, /synthetic partial startup failure/u);
  assert.equal(f.state.partialCleaned, true);
  await assert.rejects(fs.stat(f.lockPath), { code: 'ENOENT' });
});

// Windows raises SIGHUP when the daemon's console window is closed, and SIGBREAK on Ctrl+Break.
for (const signal of ['SIGHUP', 'SIGBREAK']) {
  test(`bridge: ${signal} stops the bridge cleanly and releases its lock`, async t => {
    const f = await fixture(t); await f.ready();
    process.emit(signal);
    assert.equal(await within(f.running), undefined);
    assert.equal(f.state.pairDisposed, 1);
    await assert.rejects(fs.stat(f.lockPath), { code: 'ENOENT' });
  });
}

test('bridge: a second bridge cannot acquire the active local lock', async t => {
  const f = await fixture(t); await f.ready();
  await assert.rejects(runBridge(f.config, {}, [], f.adapters), /A Witchcraft bridge owns/u);
  assert.ok(await fs.stat(f.lockPath));
  f.state.pair.finish(); assert.equal(await within(f.running), undefined);
  await assert.rejects(fs.stat(f.lockPath), { code: 'ENOENT' });
});

test('bridge: context reaches the MCP cache with independent ACKs and never reaches either PTY', async t => {
  const f = await fixture(t); await f.ready();
  const nonce = '12345678', cachePath = path.join(f.adapters.localDir, 'wow-context.json');
  f.state.capture.emit(image(null, encodeHeartbeat('00000000', 2, 0, nonce)));
  const ready = await f.payload(2, row => row.uiNonce === nonce && row.contextProtocol === 4);
  assert.equal(ready.contextWant, 0); assert.equal(ready.contextWantMask, 0);
  const heartbeat = encodeHeartbeat(ready.epoch, 2, 0, nonce);
  const send = (id, data, override = {}) => {
    const message = { kind: 'context', epoch: ready.epoch, uiNonce: nonce, id, text: JSON.stringify(data), ...override };
    for (const frame of encodeContext(message)) f.state.capture.emit(image(frame, heartbeat));
  };
  send(1, [1, 'player', 1, 1, 1, 2, ['Test player', 'Shaman', 10, 215, 'Mulgore', '', []]]);
  await f.payload(2, row => row.contextAck === 1);
  assert.equal((await readContextFile(cachePath)).player.data.location.zone, 'Mulgore');
  assert.deepEqual(f.state.writes, []);
  const quest = id => [id, 'Test quest', false, [['Collect supplies', 1, 4, false]], false];
  send(2, [1, 'quests', 1, 1, 2, 3, [true, '', 2, false, [quest(101)]]]);
  await f.payload(2, row => row.contextAck === 2);
  assert.equal((await readContextFile(cachePath)).quests.status, 'missing');
  send(3, [1, 'quests', 1, 2, 2, 4, [true, '', 2, false, [quest(102)]]]);
  await f.payload(2, row => row.contextAck === 3);
  assert.equal((await readContextFile(cachePath)).quests.data.quests.length, 2);
  for (const frame of encodeMessage({ epoch: ready.epoch, id: 1, tab: 'claude', action: 'text', text: 'My prompt' }))
    f.state.capture.emit(image(frame, heartbeat));
  await f.payload(2, row => row.ack === 1 && row.contextAck === 3);
  assert.deepEqual(f.state.writes, [['claude', 'My prompt\r']]);
  send(4, [1, 'state', 1, 1, 1, 0, [false]]);
  await f.payload(2, row => row.contextAck === 4);
  assert.equal((await readContextFile(cachePath)).status, 'disabled');
  send(5, [1, 'player', 2, 1, 1, 0, ['Old UI', 'Shaman', 10, 215, 'Mulgore', '', []]], { uiNonce: 'ffffffff' });
  assert.deepEqual(f.state.writes, [['claude', 'My prompt\r']]);
  f.state.capture.emit(image(null, encodeHeartbeat(ready.epoch, 1, 0, '87654321')));
  await f.payload(1, row => row.uiNonce === '87654321' && row.contextAck === 0);
  assert.equal((await readContextFile(cachePath)).player.status, 'missing');
  f.state.pair.finish(); assert.equal(await within(f.running), undefined);
  assert.equal((await readContextFile(cachePath)).connection.status, 'disconnected');
});

test('bridge: per-domain wants fold into one id carrying an incremental mask', async t => {
  const f = await fixture(t); await f.ready();
  const nonce = '12345678', cachePath = path.join(f.adapters.localDir, 'wow-context.json');
  f.state.capture.emit(image(null, encodeHeartbeat('00000000', 1, 0, nonce)));
  const first = await f.payload(1, row => row.uiNonce === nonce && row.contextProtocol === 4);
  assert.equal(first.contextWant, 0); assert.equal(first.contextWantMask, 0);
  // Two adapters ask for different domains before the next tick: one id, the combined mask.
  await requestContext(contextWantPath(cachePath, 'progress'), { now: Date.now() });
  await requestContext(contextWantPath(cachePath, 'quests'), { now: Date.now() });
  f.state.capture.emit(image(null, encodeHeartbeat(first.epoch, 2, 0, nonce)));
  const combined = await f.payload(2, row => row.contextWant === 1);
  assert.equal(combined.contextWantMask, 6);
  // A later request for another domain: a new id whose mask names only that domain.
  await requestContext(contextWantPath(cachePath, 'player'), { now: Date.now() });
  f.state.capture.emit(image(null, encodeHeartbeat(first.epoch, 3, 0, nonce)));
  const player = await f.payload(3, row => row.contextWant === 2);
  assert.equal(player.contextWantMask, 1);
  // Re-reading the same three files on a further publish raises no new id.
  await f.state.watch.onReset();
  const unchanged = await f.payload(1, row => row.contextWant === 2 && row.uiNonce === nonce);
  assert.equal(unchanged.contextWantMask, 1);
  f.state.pair.finish(); assert.equal(await within(f.running), undefined);
});

// A /reload is a new UI nonce with nothing served yet, so whatever want the chunk still names is asked again.
async function wantedThenReloaded(t, wantedAgoMs, waitMs) {
  const f = await fixture(t); await f.ready();
  const nonce = '12345678', reloaded = '87654321', cachePath = path.join(f.adapters.localDir, 'wow-context.json');
  f.state.capture.emit(image(null, encodeHeartbeat('00000000', 1, 0, nonce)));
  const first = await f.payload(1, row => row.uiNonce === nonce && row.contextProtocol === 4);
  await requestContext(contextWantPath(cachePath, 'errors'), { now: Date.now() - wantedAgoMs });
  f.state.capture.emit(image(null, encodeHeartbeat(first.epoch, 2, 0, nonce)));
  const asked = await f.payload(2, row => row.contextWant === 1);
  assert.equal(asked.contextWantMask, 8);
  await sleep(waitMs);
  f.state.capture.emit(image(null, encodeHeartbeat(first.epoch, 1, 0, reloaded)));
  return { f, after: await f.payload(1, row => row.uiNonce === reloaded) };
}

test('bridge: a reload does not ask the fresh UI session for a want that has since expired', async t => {
  // Raised 59 s ago, so it expires during the wait: an old wow_get_errors must not trigger a capture after /reload.
  const { f, after } = await wantedThenReloaded(t, 59_000, 1500);
  assert.equal(after.contextWant, 0); assert.equal(after.contextWantMask, 0);
  f.state.pair.finish(); assert.equal(await within(f.running), undefined);
});

test('bridge: a reload still serves a want raised just before it', async t => {
  const { f, after } = await wantedThenReloaded(t, 0, 0);
  const served = after.contextWant > 0 ? after : await f.payload(1, row => row.uiNonce === '87654321' && row.contextWant > 0);
  assert.equal(served.contextWantMask, 8);
  f.state.pair.finish(); assert.equal(await within(f.running), undefined);
});

test('bridge: failed context persistence retains context ACK while terminal input continues', async t => {
  const f = await fixture(t, { writeContext: async () => { throw Object.assign(new Error('fixture disk full'), { code: 'ENOSPC' }); } });
  await f.ready();
  const nonce = '12345678';
  f.state.capture.emit(image(null, encodeHeartbeat('00000000', 2, 0, nonce)));
  const ready = await f.payload(2, row => row.uiNonce === nonce);
  const heartbeat = encodeHeartbeat(ready.epoch, 2, 0, nonce);
  for (const frame of encodeContext({ kind: 'context', epoch: ready.epoch, uiNonce: nonce, id: 1,
    text: JSON.stringify([1, 'state', 1, 1, 1, 0, [true]]) })) f.state.capture.emit(image(frame, heartbeat));
  for (const frame of encodeMessage({ epoch: ready.epoch, id: 1, tab: 'codex', action: 'text', text: 'Still works' }))
    f.state.capture.emit(image(frame, heartbeat));
  const payload = await f.payload(2, row => row.ack === 1);
  assert.equal(payload.contextAck, 0);
  assert.deepEqual(f.state.writes, [['codex', 'Still works\r']]);
  f.state.pair.finish(); assert.equal(await within(f.running), undefined);
});

test('bridge: cooldown carrier reads the layout file and routes context through the ring', async t => {
  const f = await fixture(t, { binding: true, cooldown: true }); await f.ready();
  const uiNonce = 'abcdef01', bindingFile = path.join(f.config.accountDir, 'bindings-cache.wtf');
  const probe = encodeBindingAction({ epoch: '00000000', nonce: '00000000', uiNonce,
    slot: 1, seq: 1, part: 1, count: 1, payload: BINDING_PROBE_BODY });
  await fs.writeFile(bindingFile, `bind ${BINDING_KEYS[0]} ${probe}
`);
  const connected = await f.payload(1, value => value.uiNonce === uiNonce && value.bindingAck === 1);
  assert.equal(connected.cooldownProtocol, 2);
  assert.match(connected.cooldownNonce, /^[0-9a-f]{8}$/u);
  assert.equal(connected.cooldownAck, 0);

  const wire = encodeCooldownFrame({ epoch: connected.epoch, nonce: connected.cooldownNonce, uiNonce,
    seq: 1, message: 1, part: 1, count: 1, slot: 2, kind: 'context',
    payload: encodeCooldownContext({ id: 1, text: JSON.stringify([1, 'state', 1, 1, 1, 0, [true]]) }) });
  await fs.writeFile(path.join(f.characterDir, 'cooldownmanager.txt'), cooldownLayout(wire));
  // The data frame's slot moved the ring cursor as well: the acknowledgement lands in chunk 2.
  const carried = await f.payload(2, value => value.cooldownAck === 1);
  assert.equal(carried.contextAck, 1);
  assert.equal(typeof carried.cooldownChecksum, 'number');
  f.state.pair.finish(); assert.equal(await within(f.running), undefined);
});

test('bridge: a cooldown heartbeat bootstraps the ring in the background without binding, beside a silent strip', async t => {
  const f = await fixture(t, { cooldown: true, ringSize: 5 }); await f.ready();
  assert.equal(f.state.capture?.started, true, 'a configured region keeps the strip on; the carrier is a second demand signal');
  const uiNonce = 'abcdef01', layoutFile = path.join(f.characterDir, 'cooldownmanager.txt');
  const heartbeat = (changes = {}) => encodeCooldownFrame({ epoch: '00000000', nonce: '00000000', uiNonce, seq: 1,
    message: 0, part: 1, count: 1, kind: 'heartbeat', payload: Buffer.from([0]), ...changes });
  // Before the addon has a host session it heartbeats with zero ids; that alone chooses the writer slot.
  await fs.writeFile(layoutFile, cooldownLayout(heartbeat({ slot: 2 })));
  const connected = await f.payload(2, value => value.uiNonce === uiNonce && value.ready);
  assert.equal(connected.cooldownProtocol, 2); assert.equal(connected.cooldownAck, 0);
  assert.equal(connected.bindingAck, 0);
  assert.equal(JSON.parse(await fs.readFile(f.lockPath, 'utf8')).epoch, connected.epoch);
  // A heartbeat carrying the real session ids and a new slot advances the cursor again.
  await fs.writeFile(layoutFile, cooldownLayout(heartbeat({ epoch: connected.epoch, nonce: connected.cooldownNonce, slot: 3 })));
  const advanced = await f.payload(3, value => value.uiNonce === uiNonce && value.ready);
  assert.equal(advanced.cooldownAck, 0);
  // A data frame at the advertised sequence still carries context, and its own slot moves the cursor.
  const wire = encodeCooldownFrame({ epoch: connected.epoch, nonce: connected.cooldownNonce, uiNonce,
    seq: 1, message: 1, part: 1, count: 1, slot: 4, kind: 'context',
    payload: encodeCooldownContext({ id: 1, text: JSON.stringify([1, 'state', 1, 1, 1, 0, [true]]) }) });
  await fs.writeFile(layoutFile, cooldownLayout(wire));
  const carried = await f.payload(4, value => value.cooldownAck === 1 && value.uiNonce === uiNonce);
  assert.equal(carried.contextAck, 1);
  // The next heartbeat names the following data sequence and keeps the acknowledgement and its checksum.
  await fs.writeFile(layoutFile, cooldownLayout(heartbeat({ epoch: connected.epoch, nonce: connected.cooldownNonce, seq: 2, slot: 5 })));
  const idle = await f.payload(5, value => value.uiNonce === uiNonce && value.cooldownAck === 1);
  assert.equal(idle.cooldownChecksum, carried.cooldownChecksum);
  f.state.pair.finish(); assert.equal(await within(f.running), undefined);
  assert.equal(f.state.captureStopped, 1);
});

test('bridge: a binding heartbeat retries an unpublished slot beside a silent strip', async t => {
  let holdNext = false, refused = 0;
  const writeChunk = async (filename, source) => {
    if (holdNext && path.basename(path.dirname(filename)) === 'Witchcraft_Chunk_0002') {
      holdNext = false;
      refused++;
      throw Object.assign(new Error('fixture: slot is still open after atomic rename retries'), { code: 'EPERM' });
    }
    return atomicWrite(filename, source);
  };
  const f = await fixture(t, { binding: true, pixels: true, adapters: { writeChunk } }); await f.ready();
  assert.equal(f.state.capture?.started, true, 'the strip is on and never sees the game');
  const uiNonce = 'abcdef01', bindingFile = path.join(f.config.accountDir, 'bindings-cache.wtf');
  const writeAction = value => fs.writeFile(bindingFile, `bind ${BINDING_KEYS[0]} ${value}\n`);
  await writeAction(encodeBindingAction({ epoch: '00000000', nonce: '00000000', uiNonce,
    slot: 1, seq: 1, part: 1, count: 1, payload: BINDING_PROBE_BODY }));
  const connected = await f.payload(1, value => value.uiNonce === uiNonce && value.bindingAck === 1);
  assert.equal(connected.cursorLane, 'file');
  // The heartbeat replaces the probe on the key; it names slot 2 and is never acknowledged.
  holdNext = true;
  await writeAction(encodeBindingAction({ epoch: connected.epoch, nonce: connected.bindingNonce, uiNonce,
    slot: 2, seq: 0, part: 1, count: 1, payload: Buffer.from([0x48, 0]) }));
  // With no more file changes, the same persisted heartbeat must recover before the 8 s display tick.
  const advanced = await f.payload(2, value => value.uiNonce === uiNonce && value.ready);
  assert.equal(refused, 1);
  assert.equal(advanced.cursorLane, 'file'); assert.equal(advanced.bindingAck, 1);
  f.state.pair.finish(); assert.equal(await within(f.running), undefined);
  assert.equal(f.state.captureStopped, 1);
});

test('bridge: --no-pixels turns the strip off while the cooldown carrier still bootstraps the ring', async t => {
  const f = await fixture(t, { cooldown: true, ringSize: 5, noPixels: true }); await f.ready();
  assert.equal(f.state.capture, undefined, 'only --no-pixels leaves a configured region uncaptured');
  const uiNonce = 'abcdef01';
  await fs.writeFile(path.join(f.characterDir, 'cooldownmanager.txt'), cooldownLayout(encodeCooldownFrame({
    epoch: '00000000', nonce: '00000000', uiNonce, seq: 1, message: 0, part: 1, count: 1, slot: 2,
    kind: 'heartbeat', payload: Buffer.from([0]) })));
  const connected = await f.payload(2, value => value.uiNonce === uiNonce && value.ready);
  assert.equal(connected.cooldownProtocol, 2);
  f.state.pair.finish(); assert.equal(await within(f.running), undefined);
  assert.equal(f.state.capture, undefined); assert.equal(f.state.captureStopped, 0);
});

test('bridge: a cooldown frame from a new UI session rebuilds the receiver on that session', async t => {
  const f = await fixture(t, { cooldown: true, ringSize: 5 }); await f.ready();
  const layoutFile = path.join(f.characterDir, 'cooldownmanager.txt');
  const heartbeat = (uiNonce, changes = {}) => encodeCooldownFrame({ epoch: '00000000', nonce: '00000000', uiNonce,
    seq: 1, message: 0, part: 1, count: 1, kind: 'heartbeat', payload: Buffer.from([0]), ...changes });
  await fs.writeFile(layoutFile, cooldownLayout(heartbeat('abcdef01', { slot: 2 })));
  const first = await f.payload(2, value => value.uiNonce === 'abcdef01' && value.ready);
  const context = (uiNonce, slot, id) => encodeCooldownFrame({ epoch: first.epoch, nonce: first.cooldownNonce, uiNonce,
    seq: 1, message: 1, part: 1, count: 1, slot, kind: 'context',
    payload: encodeCooldownContext({ id, text: JSON.stringify([1, 'state', 1, 1, 1, 0, [true]]) }) });
  await fs.writeFile(layoutFile, cooldownLayout(context('abcdef01', 2, 1)));
  await f.payload(2, value => value.cooldownAck === 1 && value.contextAck === 1);
  // A reload: the addon starts over on a new UI session, and the acknowledgement starts over with it.
  await fs.writeFile(layoutFile, cooldownLayout(context('abcdef02', 1, 1)));
  const reloaded = await f.payload(1, value => value.uiNonce === 'abcdef02' && value.cooldownAck === 1);
  assert.equal(reloaded.contextAck, 1);
  // The retired UI session can no longer move the cursor.
  await fs.writeFile(layoutFile, cooldownLayout(heartbeat('abcdef01', { slot: 3 })));
  await sleep(600);
  assert.equal((await f.payload(3)).ready, false, 'retired UI cannot choose a new writer slot');
  assert.equal((await f.payload(1)).uiNonce, 'abcdef02');
  f.state.pair.finish(); assert.equal(await within(f.running), undefined);
});

test('bridge: the cooldown carrier stays off until it is explicitly enabled', async t => {
  const f = await fixture(t, { binding: true }); await f.ready();
  const uiNonce = 'abcdef01';
  const probe = encodeBindingAction({ epoch: '00000000', nonce: '00000000', uiNonce,
    slot: 1, seq: 1, part: 1, count: 1, payload: BINDING_PROBE_BODY });
  await fs.writeFile(path.join(f.config.accountDir, 'bindings-cache.wtf'), `bind ${BINDING_KEYS[0]} ${probe}
`);
  const connected = await f.payload(1, value => value.uiNonce === uiNonce && value.bindingAck === 1);
  assert.equal(connected.cooldownProtocol, undefined);
  assert.equal(connected.cooldownNonce, undefined);
  assert.equal(connected.cooldownAck, undefined);
  f.state.pair.finish(); assert.equal(await within(f.running), undefined);
});

test('bridge: context accepted during an in-flight cache write still reaches disk', async t => {
  // Startup writes on its own; the gate arms only once this test starts sending, and holds
  // the first write after that so a second message can land while it is in flight.
  const writes = [];
  let armed = false, held = false, release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { writeContext: async (_file, source) => {
    if (!armed) return;
    if (!held) { held = true; await gate; }
    writes.push(JSON.parse(source));
  } });
  await f.ready();
  const nonce = '12345678';
  f.state.capture.emit(image(null, encodeHeartbeat('00000000', 2, 0, nonce)));
  const ready = await f.payload(2, row => row.uiNonce === nonce);
  const heartbeat = encodeHeartbeat(ready.epoch, 2, 0, nonce);
  const send = (id, rev, name) => {
    const text = JSON.stringify([1, 'player', rev, 1, 1, 0, [name, 'Shaman', 10, 215, 'Mulgore', '', []]]);
    for (const frame of encodeContext({ kind: 'context', epoch: ready.epoch, uiNonce: nonce, id, text }))
      f.state.capture.emit(image(frame, heartbeat));
  };
  armed = true;
  send(1, 1, 'One');
  await until(() => held, 'the first cache write to be in flight');
  send(2, 2, 'Two');
  release();
  await f.payload(2, row => row.contextAck === 2);
  // Acknowledging the second message is only honest if its revision was actually written.
  await until(() => writes.length >= 2, 'a second cache write');
  assert.equal(writes.at(-1).player.data.name, 'Two');
  f.state.pair.finish(); assert.equal(await within(f.running), undefined);
});

test('bridge: a published chunk carries the session history the pair provides', async t => {
  const f = await fixture(t, { history: ['earlier |cffff0000red|r', 'later'] }); await f.ready();
  assert.equal(f.state.options.history, 200);
  const nonce = '12345678';
  f.state.capture.emit(image(null, encodeHeartbeat('00000000', 2, 0, nonce)));
  const payload = await f.payload(2, value => value.uiNonce === nonce && value.ready);
  assert.deepEqual(payload.sessions.map(session => session.history),
    [['claude earlier |cffff0000red|r', 'claude later'], ['codex earlier |cffff0000red|r', 'codex later'],
      ['copilot earlier |cffff0000red|r', 'copilot later']]);
  assert.equal(payload.sessions[0].lines.length, 10);
  f.state.pair.finish(); assert.equal(await within(f.running), undefined);
});

test('bridge: shutdown leaves a lock that another run now owns', async t => {
  const f = await fixture(t); await f.ready();
  const foreign = JSON.stringify({ pid: 1, epoch: 'feedface', startedAt: new Date().toISOString() });
  // The user removed ours and a second bridge created its own: a different file at the same path.
  await fs.unlink(f.lockPath); await fs.writeFile(f.lockPath, foreign, { flag: 'wx' });
  f.state.pair.finish(); await within(f.running);
  assert.equal(await fs.readFile(f.lockPath, 'utf8'), foreign);
  await fs.unlink(f.lockPath);
});

async function stderrDuring(t, run) {
  const original = process.stderr.write, written = [];
  process.stderr.write = (chunk, ...rest) => { written.push(String(chunk)); return original.call(process.stderr, chunk, ...rest); };
  t.after(() => { process.stderr.write = original; });
  try { await run(); } finally { process.stderr.write = original; }
  return written.join('');
}
const mismatch = async () => ({ status: 'mismatch', client: '1.60.1.71111', pinned: '1.60.1.71037' });

test('bridge: a client patch is not announced when the cooldown carrier is off', async t => {
  const said = await stderrDuring(t, async () => {
    const f = await fixture(t, { adapters: { checkClientBuild: mismatch } }); await f.ready();
    f.state.pair.finish(); await within(f.running);
  });
  assert.doesNotMatch(said, /cooldown carrier was checked on/u, 'nothing the player runs depends on the pin');
});

test('bridge: a client patch is announced when the cooldown carrier is on', async t => {
  const said = await stderrDuring(t, async () => {
    const f = await fixture(t, { cooldown: true, adapters: { checkClientBuild: mismatch,
      CooldownCarrierReceiver: class {}, CooldownCarrierReader: class { start() {} stop() {} } } });
    await f.ready();
    f.state.pair.finish(); await within(f.running);
  });
  assert.match(said, /the client is 1\.60\.1\.71111 but the optional cooldown carrier was checked on 1\.60\.1\.71037/u);
});
