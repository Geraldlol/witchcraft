import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { parseArgs } from '../bin/witchcraft.js';
import { AGENT_TABS, selectAgentCommands } from '../src/agents.js';
import { withWoWMcp } from '../src/mcp-launch.js';
import { TerminalPair, attachTerminal, resolveCopilotNpm, resolveProgram } from '../src/pty.js';
import { SessionSet } from '../src/sessions.js';
import { encodeMessage, PixelDecoder } from '../src/pixel.js';
import { Outbox } from '../src/outbox.js';
import { BindingReceiver, BINDING_PROBE_BODY, encodeBindingAction, parseBindingAction } from '../src/binding-carrier.js';
import { snapshotOverlayTerminals } from '../src/overlay-host.js';
import { validateHostMessage, validateChildMessage, OVERLAY_PROTOCOL_VERSION as v } from '../src/overlay-protocol.js';

test('Copilot selection and attach validation', () => {
  assert.equal(parseArgs(['run', '--only', 'copilot']).options.only, 'copilot');
  assert.equal(parseArgs(['run', '--with-copilot']).options.withCopilot, true);
  assert.equal(parseArgs(['run', '--tab', 'copilot', '--attach', 'copilot=pick']).options.attach.copilot, 'pick');
  for (const only of AGENT_TABS) for (const other of AGENT_TABS.filter(tab => tab !== only)) {
    assert.throws(() => parseArgs(['run', '--only', only, '--attach', `${other}=123`]), /cannot also be attached/u);
  }
  assert.throws(() => parseArgs(['run', '--only', 'unknown']), /must be/u);
});

test('session-only Copilot MCP preserves arguments, paths and ordinary permissions', () => {
  const options = { cachePath: path.resolve('cache with spaces/context.json') };
  const entry = { file: 'copilot', args: ['--resume', 'session-id', '--', 'prompt'] };
  const result = withWoWMcp('copilot', entry, options);
  assert.deepEqual(result.args.slice(0, 2), ['--resume', 'session-id']);
  const index = result.args.indexOf('--additional-mcp-config');
  const server = JSON.parse(result.args[index + 1]).mcpServers.witchcraft_wow;
  assert.equal(server.command, process.execPath);
  assert.deepEqual(server.tools, ['*']);
  assert.ok(server.args.includes(options.cachePath));
  assert.deepEqual(result.args.slice(-2), ['--', 'prompt']);
  assert.ok(!result.args.some(arg => /^--allow/u.test(arg)));
  assert.deepEqual(entry.args, ['--resume', 'session-id', '--', 'prompt']);
  assert.equal(withWoWMcp('copilot', null, options), null);
  const shell = { file: 'pwsh', args: [] };
  assert.equal(withWoWMcp('copilot', shell, options), shell);
  assert.ok(withWoWMcp('claude', { file: 'claude' }, options).args.includes('--mcp-config'));
  assert.ok(withWoWMcp('codex', { file: 'codex' }, options).args.includes('-c'));
});

test('npm Copilot resolves to Node without invoking a shell or allowing bin traversal', t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'witchcraft-copilot-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const root = path.join(folder, 'node_modules', '@github', 'copilot');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'index.js'), '');
  const manifest = bin => fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@github/copilot', bin }));
  manifest({ copilot: 'index.js' });
  assert.deepEqual(resolveCopilotNpm({ folders: [folder] }), { file: process.execPath, args: [path.join(root, 'index.js')] });
  manifest({ copilot: '../outside.js' });
  assert.equal(resolveCopilotNpm({ folders: [folder] }), undefined);
  assert.equal(resolveCopilotNpm({ folders: ['.', ''] }), undefined);
});

test('resolveProgram keeps an absolute configured path without .exe on Windows', t => {
  if (process.platform !== 'win32') { t.skip('the .exe rule applies on Windows only'); return; }
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'witchcraft-resolve-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const configured = path.join(folder, 'my-agent');
  fs.writeFileSync(configured, '');
  assert.equal(resolveProgram(configured), configured);
});

test('three PTYs route input, cycle through running tabs and clean up', async () => {
  const writes = [], exits = [];
  const pair = new TerminalPair({ commands: Object.fromEntries(AGENT_TABS.map(tab => [tab, { file: process.execPath, args: [tab] }])),
    spawn(_file, args) {
      const tab = args[0];
      return { pid: 2147483647, write: data => writes.push([tab, data]), resize() {},
        onData: () => ({ dispose() {} }), onExit: fn => { exits.push(fn); return { dispose() {} }; } };
    } });
  const stdin = Object.assign(new EventEmitter(), { resume() {}, pause() {} });
  const stdout = Object.assign(new EventEmitter(), { write() {} });
  const display = attachTerminal(pair, { stdin, stdout, initialTab: 'claude' });
  try {
    assert.deepEqual(pair.snapshot().map(session => session.title), ['Claude', 'Codex', 'Copilot']);
    stdin.emit('data', Buffer.from('a\x1db\x1dc\x1dd'));
    assert.deepEqual(writes, [['claude', 'a'], ['codex', 'b'], ['copilot', 'c'], ['claude', 'd']]);
    exits[1]({ exitCode: 0 });
    stdin.emit('data', Buffer.from('\x1de'));
    assert.deepEqual(writes.at(-1), ['copilot', 'e']);
  } finally {
    display.dispose();
    for (const exit of exits) exit({ exitCode: 0 });
    await pair.dispose();
  }
});

test('Copilot-only sessions finish when Copilot exits and mirrored Copilot stays owned by user', async () => {
  class Pair {
    constructor({ commands }) { this.sessions = new Map(AGENT_TABS.map(id => [id, { id, status: commands[id] ? 'running' : 'not started' }])); }
    snapshot() { return [...this.sessions.values()].map(session => ({ ...session, lines: [] })); }
    dispose() {}
  }
  const only = new SessionSet({ commands: { copilot: { file: 'copilot' } }, TerminalPair: Pair });
  assert.equal(only.finished(), false);
  only.sessions.get('copilot').status = 'exited (0)';
  assert.equal(only.finished(), true);
  const writes = [];
  class Mirror {
    start() {} stop() {} snapshot() { return { lines: ['Copilot console'] }; }
    write(text) { writes.push(text); return true; } key(key) { writes.push(key); return true; }
  }
  const mirrored = new SessionSet({ commands: {}, attach: { copilot: 123 }, TerminalPair: Pair, ConsoleMirror: Mirror });
  assert.equal(mirrored.snapshot()[2].title, 'Copilot');
  mirrored.write('copilot', 'hello\r', 'text');
  assert.deepEqual(writes, ['hello', 'enter']);
  assert.equal(mirrored.finished(), false);
  await mirrored.dispose();
});

test('pixel and binding carriers deliver every tab to the outbox exactly once', async () => {
  const epoch = '1234abcd', nonce = 'abcd1234', uiNonce = 'deadbeef';
  for (const [code, tab] of AGENT_TABS.entries()) {
    const writes = [], outbox = new Outbox({ epoch, write: (...args) => writes.push(args) });
    const message = { epoch, id: 1, tab, action: 'text', text: 'Hello 🌍' };
    const decoder = new PixelDecoder();
    let decoded;
    for (const frame of encodeMessage(message)) decoded = decoder.push(frame) ?? decoded;
    assert.deepEqual(decoded, message);
    assert.equal(outbox.accept(decoded).accepted, true);
    assert.equal(outbox.accept(decoded).duplicate, true);
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0], [tab, 'Hello 🌍\r', 'text']);
    const receiver = new BindingReceiver({ epoch, nonce, onMessage: input => outbox.accept(input) });
    const frame = (seq, payload, probe = false) => parseBindingAction(encodeBindingAction({
      epoch: probe ? '00000000' : epoch, nonce: probe ? '00000000' : nonce,
      uiNonce, slot: 1, seq, part: 1, count: 1, payload,
    }));
    assert.equal((await receiver.accept(frame(1, BINDING_PROBE_BODY, true))).accepted, true);
    const body = Buffer.concat([Buffer.from([73, 0, 0, 2, code, 0]), Buffer.from('binding')]);
    assert.equal((await receiver.accept(frame(2, body))).accepted, true);
    assert.deepEqual(writes[1], [tab, 'binding\r', 'text']);
  }
});

test('overlay accepts Copilot snapshots, ready, input and selection, rejecting unknown tabs', () => {
  const payload = snapshotOverlayTerminals({ sessions: new Map(), cols: 120, rows: 40 }, { activeTab: 'copilot' });
  assert.equal(validateHostMessage({ v, type: 'state', seq: 1, payload }).payload.sessions[2].title, 'Copilot');
  assert.equal(validateHostMessage({ v, type: 'ready', seq: 1, payload: {
    sessionId: 'test-session', tabs: [...AGENT_TABS], activeTab: 'copilot', lifecycle: 'syncing',
  } }).payload.activeTab, 'copilot');
  for (const type of ['select', 'input']) {
    const payload = { tab: 'copilot', ...(type === 'input' ? { data: 'hello' } : {}) };
    assert.equal(validateChildMessage({ v, type, seq: 1, payload }).payload.tab, 'copilot');
    assert.throws(() => validateChildMessage({ v, type, seq: 1, payload: { ...payload, tab: 'unknown' } }));
  }
});


test('Copilot is opt-in and --only never launches other configured agents', () => {
  assert.equal(selectAgentCommands().commands.copilot, undefined);
  assert.equal(selectAgentCommands({}, { withCopilot: true }).commands.copilot.file, 'copilot');
  const only = selectAgentCommands({}, { only: 'copilot' });
  assert.equal(only.initialTab, 'copilot');
  assert.equal(only.commands.claude, null);
  assert.equal(only.commands.codex, null);
  assert.equal(only.commands.copilot.file, 'copilot');
  const config = { commands: { copilot: { file: 'copilot', args: ['--resume', 'saved-id'] } } };
  assert.deepEqual(selectAgentCommands(config).commands.copilot.args, ['--resume', 'saved-id']);
  assert.equal(selectAgentCommands(config, { only: 'claude', withCopilot: true }).commands.copilot, null);
  assert.equal(selectAgentCommands({}, { tab: 'copilot' }).commands.copilot, undefined);
  assert.equal(selectAgentCommands({}, { tab: 'copilot' }, [process.execPath, '--help']).commands.copilot.file, process.execPath);
  assert.equal(selectAgentCommands({}, { only: 'copilot' }, [process.execPath, '--help']).commands.copilot.file, process.execPath);
  assert.throws(() => selectAgentCommands({}, { only: 'copilot', tab: 'claude' }), /must match/u);
  assert.throws(() => selectAgentCommands({ commands: { copilot: { file: 'copilot', args: [null] } } }), /array of arguments/u);
});
