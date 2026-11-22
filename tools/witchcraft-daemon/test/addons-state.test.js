import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import luaparse from 'luaparse';
import { ADDONS_STATE_BANK, ADDONS_STATE, stateCRC, encodeStateFrame, decodeStateFrame,
  frameStates, parseAddonsState, readStableAddonsState, AddonsStateReceiver, AddonsStateReader,
  inertStateBank } from '../src/addons-state.js';

const session = '0123456789abcdef';
const frame = (changes = {}) => ({ session, seq: 1, message: 1, part: 1, count: 1, payload: Buffer.from('hello'), ...changes });
const source = (value = frame(), commit = true) => Buffer.from([...frameStates(value, commit)]
  .map(([name, bit]) => `${name}: ${bit ? 'enabled' : 'disabled'}`).join('\r\n') + '\r\n');

test('state CRC vector, canonical binary envelope and full bank round trip', () => {
  assert.equal(stateCRC(Buffer.from('123456789')), 0xcbf43926);
  const encoded = encodeStateFrame(frame());
  assert.equal(encoded.toString('hex'), '465301050123456789abcdef00010001010168656c6c6f0000000000d50c543c');
  assert.deepEqual(decodeStateFrame(encoded), frame());
  assert.deepEqual(parseAddonsState(source()), frame());
  assert.equal(parseAddonsState(source(frame(), false)), null);
  assert.deepEqual(parseAddonsState(Buffer.concat([Buffer.from('SomeOtherAddon: enabled\n'), source()])), frame());
});

test('all 256 single-bit frame corruptions and valid-CRC noncanonical padding fail', () => {
  const encoded = encodeStateFrame(frame());
  for (let bit = 0; bit < 256; bit++) {
    const changed = Buffer.from(encoded); changed[bit >> 3] ^= 1 << (bit % 8);
    assert.throws(() => decodeStateFrame(changed));
  }
  const changed = Buffer.from(encoded); changed[26] = 1;
  changed.writeUInt32BE(stateCRC(changed.subarray(0, 28)), 28);
  assert.throws(() => decodeStateFrame(changed), /Noncanonical/u);
});

test('parser rejects missing, duplicate, unknown, malformed and oversized bank rows', () => {
  const text = source().toString();
  for (const bad of [text.replace(/^.*\r\n/u, ''), text + 'WitchcraftStateBit000: disabled\n',
    text + 'WitchcraftStateBit999: enabled\n', text.replace('disabled', 'some'), 'WitchcraftStateCommit: enabled\n']) {
    assert.throws(() => parseAddonsState(bad));
  }
  assert.throws(() => parseAddonsState(Buffer.alloc(ADDONS_STATE.maxFile + 1)), /budget/u);
  for (const changes of [{ seq: 0 }, { count: 65 }, { message: 0 }, { payload: Buffer.alloc(9) },
    { session: '0000000000000000' }, { count: 2, payload: Buffer.from('short') }]) {
    assert.throws(() => encodeStateFrame(frame(changes)));
  }
});

test('stable read suppresses file replacement and unpublished data', async () => {
  let reads = 0;
  assert.equal(await readStableAddonsState('unused', { read: async () => ++reads === 1 ? source() : source(frame({ seq: 2 })), delay: async () => {} }), null);
  assert.deepEqual(await readStableAddonsState('unused', { read: async () => source(), delay: async () => {} }), frame());
  assert.equal(await readStableAddonsState('unused', { read: async () => source(frame(), false), delay: async () => {} }), null);
});

test('stop-and-wait handles fragments, duplicate reads, gaps and stale sessions', async () => {
  const messages = [], receiver = new AddonsStateReceiver({ session, onMessage: async (bytes, id) => { messages.push([bytes.toString(), id]); return true; } });
  const first = frame({ count: 2, payload: Buffer.from('12345678') });
  assert.equal((await receiver.accept(first)).ack, 1);
  assert.equal((await receiver.accept(first)).duplicate, true);
  assert.equal((await receiver.accept(frame({ seq: 3 }))).reason, 'sequence');
  assert.equal((await receiver.accept(frame({ session: '1123456789abcdef' }))).reason, 'session');
  const last = frame({ seq: 2, part: 2, count: 2 });
  assert.equal((await receiver.accept(last)).ack, 2);
  assert.equal((await receiver.accept(last)).duplicate, true);
  assert.deepEqual(messages, [['12345678hello', { session, message: 1 }]]);
  await assert.rejects(receiver.accept({ ...last, payload: Buffer.from('world') }), /mutation/u);
  assert.equal((await receiver.accept(frame({ seq: 3, message: 2 }))).ack, 3);
});

test('application rejection or throw preserves fragment and sequence for retry', async () => {
  let attempts = 0;
  const receiver = new AddonsStateReceiver({ session, onMessage: async () => { attempts++; if (attempts === 1) throw Error('local failure'); return attempts > 2; } });
  await receiver.accept(frame({ count: 2, payload: Buffer.from('12345678') }));
  const last = frame({ seq: 2, part: 2, count: 2 });
  await assert.rejects(receiver.accept(last), /local failure/u);
  assert.equal((await receiver.accept(last)).accepted, false);
  assert.equal(receiver.ack, 1); assert.equal(receiver.pending.chunks.length, 1);
  assert.equal((await receiver.accept(last)).ack, 2);
  assert.equal(attempts, 3);
});

test('receiver serializes async dispatch and expires incomplete messages', async () => {
  let release;
  const receiver = new AddonsStateReceiver({ session, onMessage: () => new Promise(resolve => { release = resolve; }) });
  const pending = receiver.accept(frame());
  assert.equal((await receiver.accept(frame())).reason, 'busy');
  release(true); await pending;
  let now = 0;
  const expiring = new AddonsStateReceiver({ session, now: () => now, onMessage: async () => true });
  await expiring.accept(frame({ count: 2, payload: Buffer.from('12345678') }));
  now = ADDONS_STATE.ttlMs + 1;
  assert.match((await expiring.accept(frame({ seq: 2, part: 2, count: 2 }))).reason, /expired/u);
});

test('explicit reader polls only its selected path; inert generator emits no Lua/XML', async () => {
  const filename = new URL('file:///C:/fixture/Character/AddOns.txt').pathname;
  const receiver = new AddonsStateReceiver({ session, onMessage: async () => true });
  const readPaths = [];
  const reader = new AddonsStateReader({ filename, receiver, read: async file => { readPaths.push(file); return frame(); } });
  assert.equal((await reader.poll()).ack, 1); assert.deepEqual(readPaths, [filename]);
  assert.throws(() => new AddonsStateReader({ filename: 'AddOns.txt', receiver }));
  const bank = inertStateBank();
  assert.equal(bank.length, 257); assert.equal(new Set(bank.map(item => item.name)).size, 257);
  assert.deepEqual(bank.map(item => item.name), ADDONS_STATE_BANK);
  for (const item of bank) {
    assert.equal(item.filename, `${item.name}/${item.name}.toc`);
    assert.ok(item.source.split('\n').every(line => !line || line.startsWith('## ')));
    assert.match(item.source, /## LoadOnDemand: 1\n## DefaultState: disabled/u);
  }
});

test('addon state source parses as Lua 5.1 and has no automatic startup', async () => {
  const lua = await readFile(new URL('../../../Witchcraft/AddonsState.lua', import.meta.url), 'utf8');
  assert.doesNotThrow(() => luaparse.parse(lua, { luaVersion: '5.1' }));
  assert.doesNotMatch(lua, /CreateFrame|RegisterEvent|C_Timer|LoadAddOn|EnableAllAddOns|DisableAllAddOns/u);
});
