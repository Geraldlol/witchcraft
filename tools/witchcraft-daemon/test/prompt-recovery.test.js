import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fengari from 'fengari';
import { Outbox } from '../src/outbox.js';
import { PassThrough } from 'node:stream';
import { ConsoleMirror } from '../src/console-mirror.js';
import { SessionSet } from '../src/sessions.js';

const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari;
const addon = new URL('../../../Witchcraft/', import.meta.url);

function controller(t) {
  const state = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(state);
  t.after(() => lua.lua_close(state));
  function run(source) {
    const result = lauxlib.luaL_dostring(state, to_luastring(source));
    if (result !== lua.LUA_OK) throw new Error(to_jsstring(lua.lua_tostring(state, -1)));
  }
  function get(expression) {
    run('return tostring(' + expression + ')');
    const value = to_jsstring(lua.lua_tostring(state, -1));
    lua.lua_pop(state, 1);
    return value;
  }
  run('ns = {}; unpack = table.unpack');
  for (const name of ['Ring', 'Pixel', 'Prompts', 'Core']) {
    run('(function(...)\n' + fs.readFileSync(new URL(name + '.lua', addon), 'utf8') + '\nend)("Witchcraft", ns)');
  }
  run(`
    c = ns.Core.New({}, { UINonce = function() return "abcdef12" end })
    c:Start()
    function chunk(epoch, ack, results, protocol)
      c.loading = { generation = c.generation }
      local ok = c:ReceiveChunk({ protocol=1, ready=true, ringSize=3000, seq=c.ring.nextSeq, uiNonce=c.uiNonce,
        cols=120, rows=40, epoch=epoch, ack=ack, changed=true, promptProtocol=protocol, promptResults=results,
        sessions={{id="claude",title="Claude",status="running",lines={"ready"}},
                  {id="codex",title="Codex",status="running",lines={"ready"}}} })
      c.loading = nil
      assert(ok, c.ring.status)
    end
  `);
  function update(host, version = 1) {
    run('chunk("' + host.epoch + '",' + host.ack + ',{' + host.promptResults.join(',') + '},' + version + ')');
  }
  function next() {
    if (get('c:PendingInput() == nil') === 'true') return null;
    const field = name => get('c:PendingInput().' + name);
    return { epoch: field('epoch'), id: Number(field('id')), tab: field('tab'), action: field('action'), text: field('text') };
  }
  return { run, get, update, next };
}

for (const loseFinalReceipt of [false, true]) {
  test('restart retains the entire prompt ' + (loseFinalReceipt ? 'after an unobserved final receipt' : 'after its prefix ACK'), t => {
    const game = controller(t), oldWrites = [], newWrites = [];
    const previous = new Outbox({ epoch: '1234abcd', write: (_tab, text) => oldWrites.push(text) });
    const current = new Outbox({ epoch: 'abcdef12', write: (_tab, text) => newWrites.push(text) });
    game.update(previous);
    game.run('draft = string.rep("x", 580) .. "second~n line\\nlast | line"; assert(c:SendLong("claude", draft))');
    const queued = Number(game.get('#c.global.outbox'));
    assert.equal(queued, 2);
    assert.equal(previous.accept(game.next()).buffered, true);
    game.update(previous);
    assert.equal(Number(game.get('#c.global.outbox')), queued);
    assert.equal(game.next().id, 2);
    if (loseFinalReceipt) assert.equal(previous.accept(game.next()).accepted, true);
    game.update(current);
    assert.equal(game.next(), null);
    game.run('assert(ns.Persistence.Validate({global=c.global})); assert(ns.Prompts.Group(c.global.outbox, c.global.outbox[1]) == draft)');
    game.run('assert(not c:Resend()); assert(c:InspectPending(1))');
    assert.equal(game.next(), null);
    game.run('assert(c:Resend(1))');
    while (game.next()) {
      assert.equal(current.accept(game.next()).accepted, true);
      game.update(current);
    }
    assert.deepEqual(newWrites, ['\x1b[200~' + 'x'.repeat(580) + 'second~n line\rlast | line\x1b[201~\r']);
    assert.equal(oldWrites.length, loseFinalReceipt ? 1 : 0);
    assert.equal(Number(game.get('#c.global.outbox')), 0);
  });
}

for (const answer of ['written', 'partial', 'exit']) {
  test('mirrored prompt waits for the matching native result: ' + answer, async t => {
    const game = controller(t);
    const child = new PassThrough();
    child.stdout = new PassThrough(); child.stdin = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => {};
    const commands = [];
    child.stdin.on('data', bytes => commands.push(JSON.parse(bytes)));
    class TestMirror extends ConsoleMirror {
      constructor(options) { super({ ...options, spawn: () => child }); }
    }
    class EmptyPair {
      constructor() { this.sessions = new Map(); }
      dispose() {}
    }
    const pair = new SessionSet({ commands: {}, attach: { claude: 123 }, ConsoleMirror: TestMirror, TerminalPair: EmptyPair });
    t.after(() => pair.dispose());
    const reply = value => child.stdout.write(JSON.stringify(value) + '\n');
    reply({ type: 'ready' });
    const host = new Outbox({ epoch: '1234abcd', writePrompt: (...args) => pair.writePrompt(...args) });
    game.update(host);
    game.run('assert(c:SendLong("claude", "hello\\\\nworld"))');
    const frame = game.next();
    assert.equal(host.accept(frame).buffered, true);
    assert.equal(host.accept(frame).buffered, true);
    assert.equal(commands.length, 1);
    const request = commands[0];
    assert.equal(request.type, 'prompt');
    assert.equal(request.text, '\x1b[200~hello\rworld\x1b[201~');
    reply({ type: 'prompt-result', id: request.id + 10, ok: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(host.ack, 0);
    assert.deepEqual(host.promptResults, []);
    if (answer === 'exit') child.emit('exit', 1);
    else reply({ type: 'prompt-result', id: request.id, ok: answer === 'written' });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(host.promptResults, [answer === 'written' ? 1 : -1]);
    game.update(host);
    assert.equal(game.next(), null);
    assert.equal(game.get('#c.global.outbox'), answer === 'written' ? '0' : '1');
    assert.equal(host.accept(frame).duplicate, true);
    assert.equal(commands.length, 1);
  });
}

test('a terminal-write failure must be reviewed; duplicate packets cannot repeat a partial write', t => {
  const game = controller(t);
  let attempts = 0;
  const host = new Outbox({ epoch: '1234abcd', write() { attempts++; throw new Error('unconfirmed terminal write'); } });
  game.update(host);
  game.run('assert(c:SendLong("codex", "one\\ntwo"))');
  const final = game.next();
  assert.equal(host.accept(final).dropped, true);
  assert.equal(host.accept(final).duplicate, true);
  assert.equal(attempts, 1);
  game.update(host);
  assert.equal(game.next(), null);
  assert.equal(game.get('c.global.outbox[1].review'), 'unconfirmed');
  game.run('assert(c:DiscardPending(1)); assert(#c.global.outbox == 0)');
});

test('a final frame alone never types, and a refusal leaves the entire queue untouched', t => {
  const game = controller(t), writes = [];
  const host = new Outbox({ epoch: '1234abcd', write: (...args) => writes.push(args) });
  game.update(host);
  game.run('assert(not c:SendLong("claude", string.rep("a", 580) .. string.char(194, 133) .. string.rep("b", 50))); assert(#c.global.outbox == 0 and c.global.nextId == 1)');
  game.run('c.global.nextId = 262143; assert(not c:SendLong("claude", string.rep("x", 601))); assert(#c.global.outbox == 0 and c.global.nextId == 262143)');
  game.run('c.sessions[1].state = "waiting"; c.sessions[1].choices={ selected=1, options={"one","two"} }; assert(not c:Choose("claude", 2)); assert(#c.global.outbox == 0)');
  game.run('c.global.nextId = 1; assert(c:SendLong("claude", string.rep("z", 601)))');
  const final = { ...game.next(), id: 2, text: game.get('c.global.outbox[2].text') };
  assert.equal(host.accept(final).accepted, false);
  assert.deepEqual(writes, []);
  game.update(host, 'nil');
  assert.equal(game.next(), null);
  game.run('assert(not c:SendLong("codex", string.rep("z", 601)))');
});

test('saved text from an older addon can be inspected and discarded without guessing its missing prefix', t => {
  const game = controller(t), host = new Outbox({ epoch: '1234abcd', write() { assert.fail('must not deliver'); } });
  game.run('c = ns.Core.New({ outbox={{epoch="1234abcd",id=1,tab="claude",action="text",text="old tail"}} }, {UINonce=function() return "abcdef12" end}); c:Start()');
  game.update(host);
  assert.equal(game.next(), null);
  game.run('assert(c:InspectPending(1)); assert(not c:Resend(1)); assert(c:DiscardPending(1))');
});
