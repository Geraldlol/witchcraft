import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import luaparse from 'luaparse';
import { initializeRing } from '../src/init.js';
import { RingWriter, assertOwnedChunk, atomicWrite } from '../src/ring.js';
import { MAX_CHUNK_BYTES } from '../src/lua.js';
import { Screen } from '../src/screen.js';

async function workspace(t) {
  const temp = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temp, 'witchcraft-ring-'));
  t.after(async () => { assert.equal(path.dirname(await fs.realpath(root)), temp); await fs.rm(root, { recursive: true, force: true }); });
  return root;
}
test('init produces marked LoD slots and preserves unrelated directories', async t => {
  const root = await workspace(t);
  await fs.mkdir(path.join(root, 'OtherAddon'));
  await fs.writeFile(path.join(root, 'OtherAddon', 'sentinel'), 'preserve');
  assert.equal((await initializeRing({ addonsDir: root, ringSize: 3 })).created, 3);
  const directory = await assertOwnedChunk(root, 1);
  assert.match(await fs.readFile(path.join(directory, 'Chunk.lua'), 'utf8'), /ready.*false/u);
  assert.equal((await initializeRing({ addonsDir: root, ringSize: 3 })).created, 0);
  await initializeRing({ addonsDir: root, ringSize: 3, clean: true });
  assert.equal(await fs.readFile(path.join(root, 'OtherAddon', 'sentinel'), 'utf8'), 'preserve');
});
test('foreign reserved paths are rejected before any generated writes or cleanup', async t => {
  const root = await workspace(t), foreign = path.join(root, 'Witchcraft_Chunk_0002');
  await fs.mkdir(foreign); await fs.writeFile(path.join(foreign, 'sentinel'), 'mine');
  await assert.rejects(initializeRing({ addonsDir: root, ringSize: 3, clean: true }));
  await assert.rejects(fs.stat(path.join(root, 'Witchcraft_Chunk_0001')));
  assert.equal(await fs.readFile(path.join(foreign, 'sentinel'), 'utf8'), 'mine');
});
test('an init interrupted before the TOC leaves no helper or temp folder, and a retry builds the full ring', async t => {
  const root = await workspace(t);
  const failing = async (file, contents) => {
    if (file.endsWith('.toc')) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    return fs.writeFile(file, contents);
  };
  await assert.rejects(initializeRing({ addonsDir: root, ringSize: 3, write: failing }), { code: 'ENOSPC' });
  assert.deepEqual((await fs.readdir(root)).filter(name => name.includes('Witchcraft_Chunk_')), []);
  assert.equal((await initializeRing({ addonsDir: root, ringSize: 3 })).created, 3);
  for (const index of [1, 2, 3]) await assertOwnedChunk(root, index, { requirePayload: true });
  assert.deepEqual((await fs.readdir(root)).filter(name => name.startsWith('.Witchcraft_Chunk_')), []);
});
test('a helper folder without its TOC is refused as incomplete and left untouched in both modes', async t => {
  const root = await workspace(t), partial = path.join(root, 'Witchcraft_Chunk_0002');
  await fs.mkdir(partial); await fs.writeFile(path.join(partial, 'Chunk.lua'), 'partial');
  for (const clean of [false, true]) {
    await assert.rejects(initializeRing({ addonsDir: root, ringSize: 3, clean }), error => error.code !== 'ENOENT'
      && /Witchcraft_Chunk_0002/u.test(error.message) && /incomplete/iu.test(error.message)
      && /remove/iu.test(error.message) && /\binit\b/u.test(error.message) && !error.message.includes(root));
    assert.deepEqual(await fs.readdir(partial), ['Chunk.lua']);
    assert.equal(await fs.readFile(path.join(partial, 'Chunk.lua'), 'utf8'), 'partial');
    await assert.rejects(fs.stat(path.join(root, 'Witchcraft_Chunk_0001')), { code: 'ENOENT' });
  }
});
test('init sweeps its own leftover temp folders and leaves other dot-folders alone', async t => {
  const root = await workspace(t);
  const leftover = path.join(root, `.Witchcraft_Chunk_0001.tmp-${randomUUID()}`);
  await fs.mkdir(leftover); await fs.writeFile(path.join(leftover, 'Chunk.lua'), 'stale');
  const foreign = ['.Witchcraft_Chunk_0001.tmp-keep', `.OtherAddon.tmp-${randomUUID()}`].map(name => path.join(root, name));
  for (const dir of foreign) { await fs.mkdir(dir); await fs.writeFile(path.join(dir, 'sentinel'), 'keep'); }
  assert.equal((await initializeRing({ addonsDir: root, ringSize: 3 })).created, 3);
  await assert.rejects(fs.stat(leftover), { code: 'ENOENT' });
  for (const dir of foreign) assert.equal(await fs.readFile(path.join(dir, 'sentinel'), 'utf8'), 'keep');
});
test('init removes only the exact temp folder names it generates', async t => {
  // A helper is `.Witchcraft_Chunk_<0001..9999>.tmp-<version-4 UUID>`; any other name is not ours.
  const root = await workspace(t);
  const generated = path.join(root, `.Witchcraft_Chunk_0001.tmp-${randomUUID()}`);
  await fs.mkdir(generated); await fs.writeFile(path.join(generated, 'Chunk.lua'), 'stale');
  const lookalikes = [`.Witchcraft_Chunk_0001.tmp-${'a'.repeat(36)}`, `.Witchcraft_Chunk_0001.tmp-${'-'.repeat(36)}`,
    `.Witchcraft_Chunk_0000.tmp-${randomUUID()}`].map(name => path.join(root, name));
  for (const dir of lookalikes) { await fs.mkdir(dir); await fs.writeFile(path.join(dir, 'sentinel'), 'keep'); }
  assert.equal((await initializeRing({ addonsDir: root, ringSize: 3 })).created, 3);
  await assert.rejects(fs.stat(generated), { code: 'ENOENT' });
  const survivors = await Promise.all(lookalikes.map(dir => fs.readFile(path.join(dir, 'sentinel'), 'utf8').catch(error => error.code)));
  assert.deepEqual(survivors, ['keep', 'keep', 'keep'], 'all-a, all-hyphen and slot 0000 names are not ours');
});
test('a slot folder that appears while init builds that slot is refused and preserved, and no temp folder is left', async t => {
  const root = await workspace(t), late = path.join(root, 'Witchcraft_Chunk_0002');
  // Another party creates the empty slot folder after the inventory, while slot 2's TOC is written.
  const write = async (file, contents) => {
    if (path.basename(file) === 'Witchcraft_Chunk_0002.toc') await fs.mkdir(late);
    return fs.writeFile(file, contents);
  };
  await assert.rejects(initializeRing({ addonsDir: root, ringSize: 3, write }),
    error => /Witchcraft_Chunk_0002/u.test(error.message) && /appeared during init/u.test(error.message));
  assert.ok((await fs.stat(late)).isDirectory());
  assert.deepEqual(await fs.readdir(late), []);
  assert.deepEqual((await fs.readdir(root)).filter(name => /^\.Witchcraft_Chunk_.*\.tmp-/u.test(name)), []);
});
test('writer follows consumer requests, rejects stale UI, echoes the current UI nonce', async t => {
  const root = await workspace(t); await initializeRing({ addonsDir: root, ringSize: 3 });
  const writer = new RingWriter({ addonsDir: root, ringSize: 3, epoch: '0123abcd' });
  assert.equal(writer.request({ epoch: '00000000', uiNonce: 'aaaabbbb', nextSeq: 2 }), true);
  await writer.publish({ changed: true, ack: 0, sessions: [] });
  const file = await fs.readFile(path.join(root, 'Witchcraft_Chunk_0002/Chunk.lua'), 'utf8');
  assert.match(file, /aaaabbbb/u);
  assert.equal(writer.request({ epoch: '0123abcd', uiNonce: 'aaaabbbb', nextSeq: 1 }), false);
  assert.equal(writer.request({ epoch: '0123abcd', uiNonce: 'ccccdddd', nextSeq: 1 }), true);
  assert.equal(writer.request({ epoch: '0123abcd', uiNonce: 'aaaabbbb', nextSeq: 3 }), false);
  await writer.stop();
});
test('writer names the lane that moved the cursor, preferring the strip while it is alive', async t => {
  const root = await workspace(t); await initializeRing({ addonsDir: root, ringSize: 3 });
  let now = 0;
  const writer = new RingWriter({ addonsDir: root, ringSize: 3, epoch: '0123abcd', now: () => now });
  const chunk = seq => fs.readFile(path.join(root, `Witchcraft_Chunk_000${seq}/Chunk.lua`), 'utf8');
  assert.equal(writer.cursorLane, null);
  // No strip seen yet: a file request names its lane at once, even at clock zero.
  assert.equal(writer.stripSeenAt, null);
  assert.equal(writer.request({ epoch: '00000000', uiNonce: 'aaaabbbb', nextSeq: 1 }, 'file'), true);
  assert.equal(writer.cursorLane, 'file');
  assert.equal(writer.request({ epoch: '00000000', uiNonce: 'aaaabbbb', nextSeq: 1 }, 'strip'), true);
  assert.equal(writer.cursorLane, 'strip');
  await writer.publish({ changed: true, ack: 0, sessions: [] });
  assert.match(await chunk(1), /\["cursorLane"\]="strip"/u);
  now = 1001;
  assert.equal(writer.request({ epoch: '00000000', uiNonce: 'aaaabbbb', nextSeq: 2 }, 'file'), true);
  assert.equal(writer.cursorLane, 'file');
  await writer.publish({ changed: true, ack: 0, sessions: [] });
  assert.match(await chunk(2), /\["cursorLane"\]="file"/u);
  // A refused request leaves the lane alone; a reset forgets it.
  assert.equal(writer.request({ epoch: '00000000', uiNonce: 'aaaabbbb', nextSeq: 1 }, 'strip'), false);
  assert.equal(writer.cursorLane, 'file');
  writer.reset(); assert.equal(writer.cursorLane, null); assert.equal(writer.stripSeenAt, null);
  const beat = (nextSeq, lane, at) => { now = at; return writer.request({ epoch: '00000000', uiNonce: 'aaaabbbb', nextSeq }, lane); };
  assert.equal(beat(1, 'strip', 2000), true); assert.equal(writer.cursorLane, 'strip');
  assert.equal(beat(2, 'file', 2500), true); assert.equal(writer.cursor, 2); assert.equal(writer.cursorLane, 'strip');
  assert.equal(beat(3, 'file', 3001), true); assert.equal(writer.cursorLane, 'file');
  assert.equal(beat(3, 'strip', 3002), true); assert.equal(writer.cursorLane, 'strip');
  await writer.stop();
});
test('reset invalidates work waiting on ownership checks', async () => {
  let release, checked;
  const waiting = new Promise(resolve => { checked = resolve; });
  const writes = [];
  const writer = new RingWriter({ addonsDir: os.tmpdir(), ringSize: 3, epoch: '0123abcd',
    check: () => { checked(); return new Promise(resolve => { release = resolve; }); },
    write: (...args) => writes.push(args) });
  const old = writer.publish({ changed: true });
  await waiting; writer.reset(); release(os.tmpdir());
  assert.equal(await old, false); assert.equal(writes.length, 0); await writer.stop();
});

test('writer publishes only a complete bounded binding acknowledgement extension', async () => {
  const writes = [];
  const writer = new RingWriter({ addonsDir: os.tmpdir(), ringSize: 3, epoch: '0123abcd',
    check: async () => os.tmpdir(), write: (file, source) => writes.push({ file, source }) });
  writer.request({ epoch: '00000000', uiNonce: 'aaaabbbb', nextSeq: 1 });
  await writer.publish({ changed: false, bindingProtocol: 1, bindingNonce: '89abcdef', bindingAck: 17 });
  assert.match(writes[0].source, /\["bindingNonce"\]="89abcdef"/u);
  assert.match(writes[0].source, /\["bindingAck"\]=17/u);
  for (const payload of [
    { bindingProtocol: 1, bindingAck: 0 },
    { bindingProtocol: 1, bindingNonce: '00000000', bindingAck: 0 },
    { bindingProtocol: 1, bindingNonce: '89abcdef', bindingAck: 16777216 },
  ]) assert.throws(() => writer.publish({ changed: false, ...payload }), /binding acknowledgement/u);
  await writer.stop();
});

test('changed stays latched until a slot is consumed, and an advanced cursor rejects queued writes', async () => {
  const writes = [];
  let release, checked;
  const writer = new RingWriter({ addonsDir: os.tmpdir(), ringSize: 3, epoch: '0123abcd',
    check: async () => os.tmpdir(), write: (file, source) => writes.push({ file, source }) });
  writer.request({ epoch: '00000000', uiNonce: 'aaaabbbb', nextSeq: 1 });
  await writer.publish({ changed: true });
  await writer.publish({ changed: false });
  assert.match(writes.at(-1).source, /\["changed"\]=true/u);
  writer.request({ epoch: '0123abcd', uiNonce: 'aaaabbbb', nextSeq: 2 });
  await writer.publish({ changed: false });
  assert.match(writes.at(-1).source, /\["changed"\]=false/u);
  const waiting = new Promise(resolve => { checked = resolve; });
  writer.check = () => { checked(); return new Promise(resolve => { release = resolve; }); };
  const abandoned = writer.publish({ changed: true });
  await waiting;
  writer.request({ epoch: '0123abcd', uiNonce: 'aaaabbbb', nextSeq: 3 });
  release(os.tmpdir());
  assert.equal(await abandoned, false);
  assert.equal(writes.length, 2, 'the second slot-1 publish was byte-identical, so only two writes happened');
  writer.check = async () => os.tmpdir();   // stop() scrubs published slots, which checks each one
  await writer.stop();
});

test('an identical publish to the same slot is not rewritten; a change or a cursor move is', async () => {
  const writes = [];
  let checks = 0;
  const writer = new RingWriter({ addonsDir: os.tmpdir(), ringSize: 3, epoch: '0123abcd',
    check: async () => { checks++; return os.tmpdir(); }, write: (_file, source) => writes.push(source) });
  writer.request({ epoch: '00000000', uiNonce: 'aaaabbbb', nextSeq: 1 });
  for (let i = 0; i < 5; i++) assert.equal(await writer.publish({ sessions: [] }), true, 'a skipped write still counts as published');
  assert.equal(writes.length, 1); assert.equal(checks, 1);
  await writer.publish({ sessions: [], contextAck: 1, contextProtocol: 4, contextWant: 0, contextWantMask: 0 });
  assert.equal(writes.length, 2, 'different bytes are written');
  writer.request({ epoch: '0123abcd', uiNonce: 'aaaabbbb', nextSeq: 2 });
  await writer.publish({ sessions: [], contextAck: 1, contextProtocol: 4, contextWant: 0, contextWantMask: 0 });
  assert.equal(writes.length, 3, 'a new slot is written');
  writer.reset();
  writer.request({ epoch: '0123abcd', uiNonce: 'aaaabbbb', nextSeq: 2 });
  await writer.publish({ sessions: [], contextAck: 1, contextProtocol: 4, contextWant: 0, contextWantMask: 0 });
  assert.equal(writes.length, 4, 'a reset forgets what was written');
  await writer.stop();
});

test('atomicWrite retries a transient Windows rename refusal, then gives up on a persistent one', async t => {
  const root = await workspace(t), target = path.join(root, 'Chunk.lua');
  let calls = 0;
  const flaky = async (from, to) => { calls++; if (calls < 3) throw Object.assign(new Error('busy'), { code: 'EPERM' }); return fs.rename(from, to); };
  assert.equal(await atomicWrite(target, 'payload', { rename: flaky, delayMs: 1 }), 3);
  assert.equal(await fs.readFile(target, 'utf8'), 'payload');
  assert.deepEqual((await fs.readdir(root)).filter(name => name.endsWith('.tmp')), []);
  const stuck = async () => { throw Object.assign(new Error('still busy'), { code: 'EPERM' }); };
  await assert.rejects(atomicWrite(target, 'next', { rename: stuck, attempts: 3, delayMs: 1 }), { code: 'EPERM' });
  assert.equal(await fs.readFile(target, 'utf8'), 'payload');
  const fatal = async () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); };
  await assert.rejects(atomicWrite(target, 'next', { rename: fatal, delayMs: 1 }), { code: 'ENOENT' });
  assert.deepEqual((await fs.readdir(root)).filter(name => name.endsWith('.tmp')), []);
});

test('context ACK extension is optional, data-only and bound to the writer UI identity', async () => {
  const writes = [];
  const writer = new RingWriter({ addonsDir: os.tmpdir(), ringSize: 3, epoch: '0123abcd',
    check: async () => os.tmpdir(), write: (_file, source) => writes.push(source) });
  writer.request({ epoch: '0123abcd', uiNonce: 'abcdef01', nextSeq: 1 });
  await writer.publish({ changed: false, ack: 7 });
  assert.doesNotMatch(writes.at(-1), /contextAck/u);
  await writer.publish({ changed: true, ack: 7, contextProtocol: 4, contextAck: 42, contextWant: 3, contextWantMask: 5,
    epoch: 'ffffffff', uiNonce: '11111111' });
  assert.match(writes.at(-1), /\["contextProtocol"\]=4/u);
  assert.match(writes.at(-1), /\["contextAck"\]=42/u);
  assert.match(writes.at(-1), /\["contextWant"\]=3/u);
  assert.match(writes.at(-1), /\["contextWantMask"\]=5/u);
  assert.match(writes.at(-1), /\["ack"\]=7/u);
  assert.match(writes.at(-1), /\["uiNonce"\]="abcdef01"/u);
  assert.match(writes.at(-1), /\["epoch"\]="0123abcd"/u);
  const complete = { contextProtocol: 4, contextAck: 0, contextWant: 0, contextWantMask: 0 };
  await writer.publish({ changed: false, ...complete, contextWantMask: 15 });
  assert.match(writes.at(-1), /\["contextWantMask"\]=15/u);
  // Protocol 2 carried no mask and protocol 3 no errors bit; on this code all four fields are required together.
  for (const fields of [{ contextProtocol: 4 }, { contextAck: 0 }, { contextWant: 0 }, { contextWantMask: 0 },
    { contextProtocol: 2, contextAck: 0, contextWant: 0 }, { contextProtocol: 4, contextAck: 0, contextWant: 0 },
    { ...complete, contextProtocol: 2 }, { ...complete, contextAck: 262144 }, { ...complete, contextAck: NaN },
    { ...complete, contextWant: -1 }, { ...complete, contextWant: 262144 },
    { ...complete, contextWantMask: -1 }, { ...complete, contextWantMask: 16 }, { ...complete, contextProtocol: 3 }, { ...complete, contextWantMask: 1.5 }])
    assert.throws(() => writer.publish({ changed: false, ...fields }), TypeError);
  assert.equal(writes.length, 3);
  await writer.stop();
});

test('session history is serialized beside lines under the addon line rules', async () => {
  const writes = [];
  const writer = new RingWriter({ addonsDir: os.tmpdir(), ringSize: 3, epoch: '0123abcd',
    check: async () => os.tmpdir(), write: (_file, source) => writes.push(source) });
  writer.request({ epoch: '0123abcd', uiNonce: 'abcdef01', nextSeq: 1 });
  const session = { id: 'claude', title: 'Claude', status: 'running', lines: ['row'] };
  await writer.publish({ changed: true, sessions: [{ ...session, history: ['old |cffff0000x|r', 'newer'] }, { ...session, id: 'codex' }] });
  assert.match(writes.at(-1), /\["history"\]=\{"old \|cffff0000x\|r","newer"\}/u);
  assert.match(writes.at(-1), /\["lines"\]=\{"row"\}/u);
  assert.equal(writes.at(-1).match(/\["history"\]/gu).length, 1);
  for (const history of ['old', {}, [1], [null], ['a\u0000b'], ['tab\tbed'], ['del\u007f'], ['x'.repeat(8193)], ['\u00e9'.repeat(4097)],
    Array.from({ length: 1001 }, () => 'line')])
    assert.throws(() => writer.publish({ changed: true, sessions: [{ ...session, history }] }), /history/u);
  await writer.publish({ changed: true, sessions: [{ ...session, history: ['\u00e9'.repeat(4096)] }] });
  await writer.publish({ changed: true, sessions: [{ ...session, history: Array.from({ length: 1000 }, () => 'line') }] });
  assert.equal(writes.length, 3);
  await writer.stop();
});

test('history is trimmed oldest first so lines plus history stay within the 300000-byte session budget', async () => {
  const writes = [];
  const writer = new RingWriter({ addonsDir: os.tmpdir(), ringSize: 3, epoch: '0123abcd',
    check: async () => os.tmpdir(), write: (_file, source) => writes.push(source) });
  writer.request({ epoch: '0123abcd', uiNonce: 'abcdef01', nextSeq: 1 });
  const lines = Array.from({ length: 30 }, (_, n) => `L${n}`.padEnd(8000, '.'));
  const history = Array.from({ length: 20 }, (_, n) => `H${n}`.padEnd(8000, '.'));
  const sessions = [{ id: 'claude', title: 'Claude', status: 'running', lines, history }];
  await writer.publish({ changed: true, sessions });
  const kept = source => [...source.matchAll(/"(H\d+)\.+"/gu)].map(match => match[1]);
  assert.deepEqual(kept(writes.at(-1)), ['H13', 'H14', 'H15', 'H16', 'H17', 'H18', 'H19']);
  assert.equal([...writes.at(-1).matchAll(/"(L\d+)\.+"/gu)].length, 30);
  assert.equal(sessions[0].history.length, 20, 'the caller snapshot is left untouched');
  const budget = Array.from({ length: 36 }, (_, n) => `H${n}`.padEnd(8000, '.'));
  await writer.publish({ changed: true, sessions: [{ ...sessions[0], lines: ['row'], history: budget }] });
  assert.equal(kept(writes.at(-1)).length, 36);
  await writer.publish({ changed: true, sessions: [{ ...sessions[0], lines: ['\u00e9'.repeat(6000)], history: budget }] });
  assert.equal(kept(writes.at(-1)).length, 36);
  await writer.publish({ changed: true, sessions: [{ ...sessions[0], lines: ['r'.repeat(12001)], history: budget }] });
  assert.equal(kept(writes.at(-1)).length, 35);
  await writer.stop();
});

test('a session scrolled counter is serialized beside lines and bounded to a non-negative 31-bit integer', async () => {
  const writes = [];
  const writer = new RingWriter({ addonsDir: os.tmpdir(), ringSize: 3, epoch: '0123abcd',
    check: async () => os.tmpdir(), write: (_file, source) => writes.push(source) });
  writer.request({ epoch: '0123abcd', uiNonce: 'abcdef01', nextSeq: 1 });
  const session = { id: 'claude', title: 'Claude', status: 'running', lines: ['row'] };
  await writer.publish({ changed: true, sessions: [{ ...session, scrolled: 42 }, { ...session, id: 'codex' }] });
  assert.match(writes.at(-1), /\["scrolled"\]=42/u);
  assert.equal(writes.at(-1).match(/\["scrolled"\]/gu).length, 1);
  await writer.publish({ changed: true, sessions: [{ ...session, scrolled: 0 }, { ...session, scrolled: 2147483647 }] });
  for (const scrolled of [-1, 1.5, '7', null, 2147483648, Number.NaN])
    assert.throws(() => writer.publish({ changed: true, sessions: [{ ...session, scrolled }] }), /scrolled/u);
  assert.equal(writes.length, 2);
  await writer.stop();
});

function publishedSessions(source) {
  const call = luaparse.parse(source, { luaVersion: '5.1', encodingMode: 'pseudo-latin1' }).body[0].expression;
  const field = (table, key) => table.fields.find(entry => entry.key?.value === key)?.value;
  const strings = array => array.fields.map(entry => Buffer.from(entry.value.value, 'latin1').toString('utf8'));
  return field(call.arguments[0], 'sessions').fields.map(entry => ({
    lines: strings(field(entry.value, 'lines')), history: strings(field(entry.value, 'history')),
    scrolled: field(entry.value, 'scrolled').value,
  }));
}

for (const history of [200, 1000]) {
  test(`dual Unicode terminal histories ${history === 1000 ? 'share the complete serialized budget' : 'remain untouched when they fit'}`, async t => {
    const screen = new Screen({ cols: 120, rows: 40, history });
    const writes = [];
    const writer = new RingWriter({ addonsDir: os.tmpdir(), ringSize: 3, epoch: '0123abcd',
      check: async () => os.tmpdir(), write: (_file, source) => writes.push(source) });
    t.after(async () => { await screen.dispose(); await writer.stop(); });
    await screen.write(Array.from({ length: 1050 }, (_, index) => `${String(index).padStart(4, '0')}:` + '\u0416'.repeat(115)).join('\r\n'));
    const snapshot = screen.snapshot();
    const sessions = ['claude', 'codex'].map(id => ({ id, title: id, status: 'running', ...snapshot }));
    assert.equal(await writer.publish({ changed: true, sessions }), true);
    assert.ok(Buffer.byteLength(writes[0], 'utf8') <= MAX_CHUNK_BYTES, 'the full chunk, including wrapper, fits');
    const published = publishedSessions(writes[0]);
    for (const session of published) {
      assert.deepEqual(session.lines, snapshot.lines, 'current screens remain complete');
      assert.equal(session.scrolled, snapshot.scrolled, 'lifetime scroll anchors are not changed by trimming');
      assert.ok(session.history.length > 0, 'both tabs retain history');
      assert.deepEqual(session.history, snapshot.history.slice(-session.history.length), 'only oldest rows are removed');
      if (history === 200) assert.deepEqual(session.history, snapshot.history, 'fitting histories are unchanged');
      else assert.ok(session.history.length < history, 'large Unicode histories are reduced before serialization');
    }
    assert.ok(Math.abs(published[0].history.length - published[1].history.length) <= 1, 'identical tabs share space fairly');
    assert.equal(snapshot.history.length, history, 'the caller history is never mutated');
  });
}

test('a current screen that exceeds the chunk budget reports a recoverable display-size error without dropping rows', async () => {
  const writer = new RingWriter({ addonsDir: os.tmpdir(), ringSize: 3, epoch: '0123abcd',
    check: async () => os.tmpdir(), write: () => assert.fail('an oversized screen must not be written') });
  const session = { id: 'claude', title: 'Claude', status: 'running', lines: Array(40).fill('\u0416'.repeat(4000)), history: [] };
  assert.throws(() => writer.publish({ sessions: [session] }), { code: 'LUA_OUTPUT_BUDGET' });
  assert.equal(session.lines.length, 40);
  await writer.stop();
});

test('writer stop scrubs every slot it published back to a not-ready placeholder', async t => {
  const root = await workspace(t); await initializeRing({ addonsDir: root, ringSize: 3 });
  const writer = new RingWriter({ addonsDir: root, ringSize: 3, epoch: '0123abcd' });
  const session = { id: 'claude', title: 'Claude', status: 'running', lines: ['secret-token-on-screen'], history: ['secret-in-history'] };
  writer.request({ epoch: '0123abcd', uiNonce: 'abcdef01', nextSeq: 1 });
  await writer.publish({ changed: true, sessions: [session, { ...session, id: 'codex' }] });
  writer.request({ epoch: '0123abcd', uiNonce: 'abcdef01', nextSeq: 2 });
  await writer.publish({ changed: true, sessions: [session, { ...session, id: 'codex' }] });
  await writer.stop();
  for (const slot of ['0001', '0002']) {
    const source = await fs.readFile(path.join(root, `Witchcraft_Chunk_${slot}`, 'Chunk.lua'), 'utf8');
    assert.doesNotMatch(source, /secret/u);
    assert.match(source, /\["ready"\]=false/u);
  }
});

test('writer stop reports slots it could not scrub instead of succeeding silently', async () => {
  let failPlaceholder = false;
  const writer = new RingWriter({ addonsDir: os.tmpdir(), ringSize: 3, epoch: '0123abcd', check: async () => os.tmpdir(),
    write: (_file, source) => { if (failPlaceholder && /\["ready"\]=false/u.test(source)) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); } });
  writer.request({ epoch: '0123abcd', uiNonce: 'abcdef01', nextSeq: 1 });
  await writer.publish({ changed: true, sessions: [] });
  failPlaceholder = true;
  await assert.rejects(writer.stop(), /slot 1/u);
});

test('scrubStale rewrites ready chunks a crashed run left behind, and leaves placeholders alone', async t => {
  const root = await workspace(t); await initializeRing({ addonsDir: root, ringSize: 3 });
  const crashed = new RingWriter({ addonsDir: root, ringSize: 3, epoch: '0123abcd' });
  crashed.request({ epoch: '0123abcd', uiNonce: 'abcdef01', nextSeq: 2 });
  await crashed.publish({ changed: true, sessions: [{ id: 'claude', title: 'Claude', status: 'running', lines: ['leftover-secret'] }] });
  // No stop(): simulate a crash, then a fresh run starts.
  const placeholder = await fs.readFile(path.join(root, 'Witchcraft_Chunk_0001', 'Chunk.lua'), 'utf8');
  const next = new RingWriter({ addonsDir: root, ringSize: 3, epoch: '4567ef01' });
  assert.deepEqual(await next.scrubStale(), { scrubbed: 1, failed: [] });
  assert.doesNotMatch(await fs.readFile(path.join(root, 'Witchcraft_Chunk_0002', 'Chunk.lua'), 'utf8'), /leftover-secret/u);
  assert.equal(await fs.readFile(path.join(root, 'Witchcraft_Chunk_0001', 'Chunk.lua'), 'utf8'), placeholder);
});

test('scrubStale reports a chunk it cannot read instead of treating it as empty', async t => {
  const root = await workspace(t); await initializeRing({ addonsDir: root, ringSize: 3 });
  const chunk = path.join(root, 'Witchcraft_Chunk_0002', 'Chunk.lua');
  await fs.rm(chunk); await fs.mkdir(chunk);   // reading it now fails with EISDIR, not ENOENT
  const writer = new RingWriter({ addonsDir: root, ringSize: 3, epoch: '0123abcd' });
  const result = await writer.scrubStale();
  assert.equal(result.scrubbed, 0);
  assert.equal(result.failed.length, 1); assert.match(result.failed[0], /^slot 2:/u);
});

test('scrubStale also clears an owned slot above a smaller ring and skips foreign folders there', async t => {
  const root = await workspace(t); await initializeRing({ addonsDir: root, ringSize: 5 });
  const crashed = new RingWriter({ addonsDir: root, ringSize: 5, epoch: '0123abcd' });
  crashed.request({ epoch: '0123abcd', uiNonce: 'abcdef01', nextSeq: 5 });
  await crashed.publish({ changed: true, sessions: [{ id: 'claude', title: 'Claude', status: 'running', lines: ['leftover-secret'] }] });
  // No stop(): the next run uses a three-slot ring.
  const foreign = path.join(root, 'Witchcraft_Chunk_0007'), foreignSource = '["ready"]=true not ours';
  await fs.mkdir(foreign); await fs.writeFile(path.join(foreign, 'Chunk.lua'), foreignSource);
  const writer = new RingWriter({ addonsDir: root, ringSize: 3, epoch: '4567ef01' });
  assert.deepEqual(await writer.scrubStale(), { scrubbed: 1, failed: [] });
  const slot5 = await fs.readFile(path.join(root, 'Witchcraft_Chunk_0005', 'Chunk.lua'), 'utf8');
  assert.doesNotMatch(slot5, /leftover-secret/u); assert.match(slot5, /\["ready"\]=false/u);
  assert.deepEqual(await fs.readdir(foreign), ['Chunk.lua']);
  assert.equal(await fs.readFile(path.join(foreign, 'Chunk.lua'), 'utf8'), foreignSource);
  // Inside the ring a missing slot is still reported.
  await fs.rm(path.join(root, 'Witchcraft_Chunk_0002'), { recursive: true });
  const again = await writer.scrubStale();
  assert.equal(again.scrubbed, 0);
  assert.equal(again.failed.length, 1); assert.match(again.failed[0], /^slot 2:/u);
});

test('scrubStale reports a failed helper folder listing and still scrubs the slots inside the ring', async t => {
  const root = await workspace(t); await initializeRing({ addonsDir: root, ringSize: 3 });
  const crashed = new RingWriter({ addonsDir: root, ringSize: 3, epoch: '0123abcd' });
  crashed.request({ epoch: '0123abcd', uiNonce: 'abcdef01', nextSeq: 2 });
  await crashed.publish({ changed: true, sessions: [{ id: 'claude', title: 'Claude', status: 'running', lines: ['leftover-secret'] }] });
  const writer = new RingWriter({ addonsDir: root, ringSize: 3, epoch: '4567ef01',
    list: async () => { throw Object.assign(new Error('listing denied'), { code: 'EACCES' }); } });
  assert.deepEqual(await writer.scrubStale(), { scrubbed: 1, failed: ['helper folder listing: listing denied'] });
  assert.doesNotMatch(await fs.readFile(path.join(root, 'Witchcraft_Chunk_0002', 'Chunk.lua'), 'utf8'), /leftover-secret/u);
});

test('writer publishes the UI session of the binding acknowledgement only with the binding fields', async () => {
  const writes = [];
  const writer = new RingWriter({ addonsDir: os.tmpdir(), ringSize: 3, epoch: '0123abcd',
    check: async () => os.tmpdir(), write: (file, source) => writes.push({ file, source }) });
  writer.request({ epoch: '00000000', uiNonce: 'aaaabbbb', nextSeq: 1 });
  const binding = { bindingProtocol: 1, bindingNonce: '89abcdef', bindingAck: 3 };
  await writer.publish({ changed: false, ...binding, bindingUi: 'aaaabbbb' });
  assert.match(writes[0].source, /\["bindingUi"\]="aaaabbbb"/u);
  for (const payload of [
    { ...binding, bindingUi: '00000000' },
    { ...binding, bindingUi: 'AAAABBBB' },
    { ...binding, bindingUi: 'zzzzzzzz' },
    { ...binding, bindingUi: 12345678 },
    { bindingUi: 'aaaabbbb' },
  ]) assert.throws(() => writer.publish({ changed: false, ...payload }), /binding acknowledgement/u);
  await writer.stop();
});

test('writer publishes the log acknowledgement extension like the binding one, and omits it when absent', async () => {
  const writes = [];
  const writer = new RingWriter({ addonsDir: os.tmpdir(), ringSize: 3, epoch: '0123abcd',
    check: async () => os.tmpdir(), write: (file, source) => writes.push({ file, source }) });
  writer.request({ epoch: '00000000', uiNonce: 'aaaabbbb', nextSeq: 1 });
  const log = { logProtocol: 1, logNonce: '89abcdef', logAck: 3 };
  await writer.publish({ changed: false, ...log, logUi: 'aaaabbbb' });
  for (const field of ['["logProtocol"]=1', '["logNonce"]="89abcdef"', '["logAck"]=3', '["logUi"]="aaaabbbb"']) {
    assert.ok(writes[0].source.includes(field), field);
  }
  await writer.publish({ changed: true, ...log });
  assert.doesNotMatch(writes[1].source, /logUi/u);
  await writer.publish({ changed: false, bindingProtocol: 1, bindingNonce: '89abcdef', bindingAck: 0 });
  assert.doesNotMatch(writes[2].source, /\["log/u);
  for (const payload of [
    { ...log, logProtocol: 2 },
    { ...log, logProtocol: undefined },
    { ...log, logNonce: '00000000' },
    { ...log, logNonce: 'ABCDEF01' },
    { ...log, logNonce: undefined },
    { ...log, logAck: -1 },
    { ...log, logAck: 16777216 },
    { ...log, logAck: 1.5 },
    { ...log, logAck: undefined },
    { ...log, logUi: '00000000' },
    { ...log, logUi: 'AAAABBBB' },
    { ...log, logUi: 'zzzzzzzz' },
    { ...log, logUi: 12345678 },
    { logUi: 'aaaabbbb' },
    { logAck: 0 },
  ]) assert.throws(() => writer.publish({ changed: false, ...payload }), /Invalid log acknowledgement extension/u);
  await writer.stop();
});
