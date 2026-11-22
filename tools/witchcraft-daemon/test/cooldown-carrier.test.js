import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import luaparse from 'luaparse';
import { cooldownLayout as layout } from './helpers/cooldown-layout.js';
import { COOLDOWN_CARRIER, CooldownCarrierReader, CooldownCarrierReceiver, cooldownCRC,
  decodeCooldownApplication, encodeCooldownContext,
  cooldownLayoutFilename, decodeCooldownFrame, decodeCooldownLayout, encodeCooldownFrame,
  readStableCooldownLayout } from '../src/cooldown-carrier.js';

const SESSION = Object.freeze({ epoch: '1234abcd', nonce: '89abcdef', uiNonce: '10293847' });
const frame = (changes = {}) => ({ ...SESSION, seq: 1, message: 1, part: 1, count: 1, slot: 7,
  kind: 'context', payload: Buffer.from('hello'), ...changes });
const heartbeat = (changes = {}) => frame({ kind: 'heartbeat', message: 0, payload: Buffer.from([0]), ...changes });
const BOOTSTRAP = Object.freeze({ epoch: '00000000', nonce: '00000000' });
// Only tests that reach the application decoder need a self-identifying context body.
const ctx = (text = 'hello', id = 1) => encodeCooldownContext({ id, text });

test('cooldown frame has a canonical cross-codec wire image and detects every single-bit corruption', () => {
  assert.equal(cooldownCRC(Buffer.from('123456789')), 0xcbf43926);
  const encoded = encodeCooldownFrame(frame());
  assert.equal(encoded.toString('hex'),
    '464302011234abcd89abcdef1029384700000100000101010007000568656c6c6f873e25be');
  assert.deepEqual(decodeCooldownFrame(encoded), frame());
  for (let bit = 0; bit < encoded.length * 8; bit++) {
    const changed = Buffer.from(encoded); changed[bit >> 3] ^= 1 << (bit % 8);
    assert.throws(() => decodeCooldownFrame(changed));
  }
  for (const changes of [{ epoch: '00000000' }, { ...BOOTSTRAP }, { seq: 0 }, { message: 0 }, { part: 2 },
    { count: 17 }, { kind: 'unknown' }, { kind: 'input' }, { payload: Buffer.alloc(513) },
    { count: 2, payload: Buffer.alloc(511) }, { slot: 0 }, { slot: 10000 }, { slot: undefined }])
    assert.throws(() => encodeCooldownFrame(frame(changes)));
  // A protocol 1 image (no slot field) is refused outright, whatever its checksum says.
  const legacy = Buffer.from('464301011234abcd89abcdef102938470000010000010101000568656c6c6fd5a3296e', 'hex');
  assert.throws(() => decodeCooldownFrame(legacy), /header|checksum/u);
  assert.equal(COOLDOWN_CARRIER.protocol, 2);
});

test('heartbeat frame is one flags byte at message 0 and may carry the zero bootstrap ids', () => {
  const encoded = encodeCooldownFrame(heartbeat());
  assert.equal(encoded.toString('hex'), '464302021234abcd89abcdef102938470000010000000101000700010025d69f98');
  assert.deepEqual(decodeCooldownFrame(encoded), heartbeat());
  const bootstrap = heartbeat({ ...BOOTSTRAP, payload: Buffer.from([3]) });
  assert.equal(encodeCooldownFrame(bootstrap).toString('hex'),
    '4643020200000000000000001029384700000100000001010007000103005895c8');
  assert.deepEqual(decodeCooldownFrame(encodeCooldownFrame(bootstrap)), bootstrap);
  for (const changes of [{ message: 1 }, { part: 2, count: 2 }, { count: 2 }, { payload: Buffer.alloc(0) },
    { payload: Buffer.alloc(2) }, { epoch: '00000000' }, { nonce: '00000000' }, { ...BOOTSTRAP, uiNonce: '00000000' },
    { seq: 0 }, { slot: 0 }]) assert.throws(() => encodeCooldownFrame(heartbeat(changes)), `${JSON.stringify(changes)}`);
});

test('layout decoder accepts native empty-table array/map shapes and zlib/raw Deflate', () => {
  const wire = encodeCooldownFrame(frame());
  for (const empty of ['array', 'map']) for (const raw of [false, true]) {
    const decoded = decodeCooldownLayout(layout(wire, { empty, raw }));
    assert.equal(decoded.empty, false); assert.equal(decoded.layoutVersion, 5);
    assert.deepEqual(decoded.frame, frame());
  }
  assert.deepEqual(decodeCooldownLayout(Buffer.alloc(0)),
    { empty: true, frame: null, layoutVersion: null, cbor: null });
});

test('layout decoder refuses unknown fields, foreign markers and inexact compression/base64', () => {
  const wire = encodeCooldownFrame(frame());
  assert.throws(() => decodeCooldownLayout(layout(wire, { unknown: true })), /Unknown/u);
  assert.throws(() => decodeCooldownLayout(layout(wire, { trailing: true })), /Deflate/u);
  const noncanonical = layout(wire).toString() + '=';
  assert.throws(() => decodeCooldownLayout(Buffer.from(noncanonical)), /Base64/u);
  const liveCanary = Buffer.from('1|WypRH6Hk5uir6+zv7+PiH+6n6+MY6R8aomtmaWlorGvubOJqaehkxNTA3MDIytIAAA==');
  assert.throws(() => decodeCooldownLayout(liveCanary), /header|checksum/u,
    'the fixed runtime canary is valid layout data but not a production carrier frame');
});

test('stable reader distinguishes absence, replacement races and one exact fixed character path', async () => {
  const source = layout(encodeCooldownFrame(frame()));
  assert.deepEqual((await readStableCooldownLayout('unused', { read: async () => source,
    delay: async () => {} })).frame, frame());
  let reads = 0;
  assert.equal(await readStableCooldownLayout('unused', { read: async () => ++reads === 1 ? source : Buffer.alloc(0),
    delay: async () => {} }), undefined);
  assert.equal(await readStableCooldownLayout('unused', { read: async () => null, delay: async () => {} }), null);
  const characterDir = path.resolve('C:/fixture/WTF/Account/account/70/Character-Realm');
  assert.equal(cooldownLayoutFilename(characterDir), path.join(characterDir, 'cooldownmanager.txt'));
  assert.throws(() => cooldownLayoutFilename('relative'));
  assert.throws(() => cooldownLayoutFilename(path.join(characterDir, 'cooldownmanager.txt')));
});

test('receiver is session-bound stop-and-wait with correlated checksum ACKs', async () => {
  const messages = [];
  const receiver = new CooldownCarrierReceiver({ ...SESSION,
    onMessage: async (payload, metadata) => { messages.push([payload, metadata]); return true; } });
  const whole = ctx('A'.repeat(512));
  const first = frame({ count: 2, payload: whole.subarray(0, 512) });
  const accepted = await receiver.accept(first);
  assert.equal(accepted.ack, 1); assert.equal(typeof accepted.checksum, 'number');
  assert.equal((await receiver.accept(first)).duplicate, true);
  // A different frame under an acknowledged number is refused, not thrown: the reader keeps polling
  // and the addon resyncs from the published ack.
  const mutated = await receiver.accept({ ...first, payload: Buffer.alloc(512, 66) });
  assert.equal(mutated.accepted, false); assert.equal(mutated.reason, 'mutation'); assert.equal(mutated.ack, 1);
  assert.equal(receiver.ack, 1); assert.equal(receiver.lastChecksum, accepted.checksum);
  assert.equal((await receiver.accept(frame({ ...SESSION, epoch: '2234abcd', seq: 2, part: 2, count: 2 }))).reason, 'session');
  const last = frame({ seq: 2, part: 2, count: 2, payload: whole.subarray(512) });
  const completed = await receiver.accept(last);
  assert.equal(completed.ack, 2); assert.equal(messages.length, 1);
  assert.equal(messages[0][0].text.length, 512); assert.equal(messages[0][0].id, 1);
  assert.equal(messages[0][1].kind, 'context');
});

test('receiver retains a fragment on application failure and expires incomplete messages', async () => {
  let attempts = 0;
  const receiver = new CooldownCarrierReceiver({ ...SESSION,
    onMessage: async () => ++attempts > 1 });
  assert.equal((await receiver.accept(frame({ payload: ctx() }))).reason, 'application');
  assert.equal(receiver.ack, 0); assert.equal((await receiver.accept(frame({ payload: ctx() }))).ack, 1);
  let now = 0;
  const expiring = new CooldownCarrierReceiver({ ...SESSION, now: () => now, onMessage: async () => true });
  await expiring.accept(frame({ count: 2, payload: Buffer.alloc(512) }));
  now = COOLDOWN_CARRIER.ttlMs + 1;
  assert.equal((await expiring.accept(frame({ seq: 2, part: 2, count: 2 }))).reason, 'expired');
});

test('receiver lets a restarted sender begin a message again at the next sequence number', async () => {
  // In game on 2026-09-22 the addon quarantined mid-message (ring stalled past its ACK timeout),
  // restarted, and every later frame was refused, so the carrier acknowledged one frame per session.
  const messages = [];
  const receiver = new CooldownCarrierReceiver({ ...SESSION, onMessage: async payload => { messages.push(payload); return true; } });
  const whole = ctx('B'.repeat(512));
  assert.equal((await receiver.accept(frame({ count: 2, payload: whole.subarray(0, 512) }))).ack, 1);
  // The sender dropped that message and offers a fresh one under the same number, from part one.
  const retried = await receiver.accept(frame({ seq: 2, message: 1, part: 1, count: 1, payload: ctx('short', 2) }));
  assert.equal(retried.ack, 2); assert.equal(messages.length, 1); assert.equal(messages[0].id, 2);
  // A sender that never saw the completion ACK may reuse the completed number; it is accepted and delivered.
  assert.equal((await receiver.accept(frame({ seq: 3, message: 1, part: 1, count: 1, payload: ctx('again', 3) }))).ack, 3);
  assert.equal((await receiver.accept(frame({ seq: 4, message: 2, part: 1, count: 1, payload: ctx('next', 4) }))).ack, 4);
  assert.equal(messages.length, 3);
  // Sequence continuity is still required, and a message number from the past is not.
  assert.equal((await receiver.accept(frame({ seq: 1, message: 3, part: 1, count: 1, payload: ctx('old', 5) }))).reason, 'sequence');
  assert.equal((await receiver.accept(frame({ seq: 5, message: 1, part: 1, count: 1, payload: ctx('old', 5) }))).reason, 'fragment order');
});

test('reader polls only cooldownmanager.txt and does not redispatch an unchanged frame', async () => {
  const receiver = new CooldownCarrierReceiver({ ...SESSION, onMessage: async () => true });
  const calls = [];
  const characterDir = path.resolve('C:/fixture/WTF/Account/account/70/Character-Realm');
  const reader = new CooldownCarrierReader({ characterDir, receiver,
    read: async filename => { calls.push(filename); return { frame: frame({ payload: ctx() }) }; } });
  assert.equal((await reader.poll()).ack, 1);
  assert.equal((await reader.poll()).duplicatePoll, true);
  assert.deepEqual(calls, [path.join(characterDir, COOLDOWN_CARRIER.filename),
    path.join(characterDir, COOLDOWN_CARRIER.filename)]);
});

test('addon carrier is Lua 5.1 data-only source with no automatic startup or file API', async () => {
  const lua = await readFile(new URL('../../../Witchcraft/CooldownCarrier.lua', import.meta.url), 'utf8');
  assert.doesNotThrow(() => luaparse.parse(lua, { luaVersion: '5.1' }));
  assert.doesNotMatch(lua, /CreateFrame|RegisterEvent|C_Timer|io\.|os\.|SendChatMessage|RunMacro|TargetUnit/u);
  assert.match(lua, /data\[127\] = wire/u); assert.match(lua, /data\[127\] = nil/u);
});

const settle = async predicate => {
  for (let tick = 0; tick < 200 && !predicate(); tick++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(predicate(), 'reader never reached the expected state');
};

test('reader start polls on an interval and stops cleanly', async () => {
  const receiver = new CooldownCarrierReceiver({ ...SESSION, onMessage: async () => true });
  let reads = 0;
  const reader = new CooldownCarrierReader({ characterDir: path.resolve('C:/fixture/char'), receiver, pollMs: 5,
    read: async () => { reads++; return null; } });
  await reader.start();
  await settle(() => reads >= 3);
  await reader.stop();
  const settled = reads;
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(reads, settled);
});

test('reader reports a failing read without abandoning the interval', async () => {
  const receiver = new CooldownCarrierReceiver({ ...SESSION, onMessage: async () => true });
  const errors = [];
  let reads = 0;
  const reader = new CooldownCarrierReader({ characterDir: path.resolve('C:/fixture/char'), receiver, pollMs: 5,
    onError: error => errors.push(error),
    read: async () => { if (++reads === 2) throw new Error('layout unreadable'); return null; } });
  await reader.start();
  await settle(() => errors.length >= 1 && reads >= 4);
  await reader.stop();
  assert.match(errors[0].message, /layout unreadable/u);
});

test('reader reports each poll result and stays quiet when there is no frame', async () => {
  const receiver = new CooldownCarrierReceiver({ ...SESSION, onMessage: async () => true });
  const results = [];
  let layout = null;
  const reader = new CooldownCarrierReader({ characterDir: path.resolve('C:/fixture/char'), receiver,
    onResult: result => results.push(result), read: async () => layout });
  await reader.poll();
  assert.deepEqual(results, [], 'an absent layout is not a poll result');
  layout = { frame: frame({ payload: ctx() }) };
  await reader.poll();
  await reader.poll();
  assert.equal(results.length, 2);
  assert.equal(results[0].ack, 1); assert.equal(results[0].duplicatePoll, undefined);
  assert.equal(results[1].duplicatePoll, true);
});

test('a context message carries its own id so the host acknowledges the right one', () => {
  const body = encodeCooldownContext({ id: 7, text: 'hello' });
  assert.deepEqual(decodeCooldownApplication(body, 'context'), { kind: 'context', id: 7, text: 'hello' });
  assert.equal(body.toString('ascii', 0, 1), 'C');

  // The id is what the addon numbered the message, not the carrier's own frame counter.
  assert.deepEqual(decodeCooldownApplication(encodeCooldownContext({ id: 262143, text: 'x' }), 'context'),
    { kind: 'context', id: 262143, text: 'x' });

  for (const invalid of [{ id: 0, text: 'x' }, { id: 262144, text: 'x' }, { id: 1, text: '' }])
    assert.throws(() => encodeCooldownContext(invalid));
  for (const invalid of [Buffer.alloc(0), Buffer.from('C'), Buffer.from('X\u0000\u0000\u0001hi', 'latin1')])
    assert.throws(() => decodeCooldownApplication(invalid, 'context'));
});

test('receiver offers every frame as a cursor first and refuses only heartbeats the host cannot follow', async () => {
  const cursors = [], messages = [];
  let follow = true;
  const receiver = new CooldownCarrierReceiver({ ...SESSION, onCursor: cursor => { cursors.push(cursor); return follow; },
    onMessage: async payload => { messages.push(payload); return true; } });
  assert.equal((await receiver.accept(heartbeat({ slot: 3, payload: Buffer.from([1]) }))).heartbeat, true);
  assert.deepEqual(cursors, [{ uiNonce: SESSION.uiNonce, nextSeq: 3, combat: true, reload: false }]);
  follow = false;
  assert.equal((await receiver.accept(heartbeat({ slot: 4 }))).reason, 'cursor');
  assert.deepEqual(cursors.at(-1), { uiNonce: SESSION.uiNonce, nextSeq: 4, combat: false, reload: false });
  follow = true;
  assert.equal((await receiver.accept(frame({ slot: 4, payload: ctx() }))).ack, 1);
  assert.equal(cursors.length, 3); assert.equal(messages.length, 1);
  // The heartbeat's reload bit reaches the cursor as well.
  await receiver.accept(heartbeat({ seq: 2, slot: 5, payload: Buffer.from([2]) }));
  assert.deepEqual(cursors.at(-1), { uiNonce: SESSION.uiNonce, nextSeq: 5, combat: false, reload: true });
});

test('receiver acknowledges a data frame whose slot the host cannot follow', async () => {
  // In game the addon may name a slot behind the writer cursor on a data frame (it moved on through
  // another lane). The cursor is best effort there: the context still lands and the ack still moves,
  // so the addon resyncs from the published acknowledgement instead of stalling.
  const cursors = [], messages = [];
  const receiver = new CooldownCarrierReceiver({ ...SESSION, onCursor: cursor => { cursors.push(cursor.nextSeq); return cursor.nextSeq >= 4; },
    onMessage: async payload => { messages.push(payload); return true; } });
  assert.equal((await receiver.accept(heartbeat({ slot: 4 }))).heartbeat, true);
  const behind = await receiver.accept(frame({ slot: 2, payload: ctx() }));
  assert.equal(behind.accepted, true); assert.equal(behind.ack, 1); assert.equal(messages.length, 1);
  assert.deepEqual(cursors, [4, 2]);
  assert.equal((await receiver.accept(frame({ slot: 2, payload: ctx() }))).duplicate, true);
  assert.equal((await receiver.accept(heartbeat({ seq: 2, slot: 3 }))).reason, 'cursor');
  assert.equal((await receiver.accept(frame({ seq: 2, slot: 3, payload: ctx('two', 2) }))).ack, 2);
  assert.equal(messages.length, 2);
});

test('receiver accepts heartbeats as cursor signals only, at the current or next sequence, with real or zero ids', async () => {
  const receiver = new CooldownCarrierReceiver({ ...SESSION, onMessage: async () => true });
  const bootstrap = heartbeat({ ...BOOTSTRAP });
  assert.deepEqual(await receiver.accept(bootstrap), { accepted: true, heartbeat: true, ack: 0, checksum: null });
  assert.equal(receiver.ack, 0); assert.equal(receiver.last, null); assert.equal(receiver.lastChecksum, null);
  assert.equal((await receiver.accept(heartbeat({ seq: 2 }))).reason, 'sequence');
  assert.equal((await receiver.accept(heartbeat({ ...BOOTSTRAP, seq: 2 }))).reason, 'sequence');
  const data = await receiver.accept(frame({ payload: ctx() }));
  assert.equal(data.ack, 1);
  // ack (the addon has not yet seen the acknowledgement) and ack + 1 (it has) are both current.
  for (const seq of [1, 2]) {
    const result = await receiver.accept(heartbeat({ seq }));
    assert.deepEqual(result, { accepted: true, heartbeat: true, ack: 1, checksum: data.checksum });
  }
  assert.equal((await receiver.accept(heartbeat({ ...BOOTSTRAP, seq: 2 }))).accepted, true);
  assert.equal((await receiver.accept(heartbeat({ seq: 3 }))).reason, 'sequence');
  // A heartbeat never replaces the last data frame, so repeating that frame is still a duplicate.
  assert.equal((await receiver.accept(frame({ payload: ctx() }))).duplicate, true);
  // Zero ids are a heartbeat privilege; a data frame with them is not even a valid frame.
  await assert.rejects(receiver.accept(frame({ ...BOOTSTRAP, seq: 2, payload: ctx() })), /Invalid/u);
  assert.equal((await receiver.accept(heartbeat({ epoch: 'ffffffff' }))).reason, 'session');
});

test('receiver adopts the first accepted frame\'s UI session and then rejects any other', async () => {
  const cursors = [];
  const receiver = new CooldownCarrierReceiver({ epoch: SESSION.epoch, nonce: SESSION.nonce, uiNonce: null,
    onCursor: cursor => { cursors.push(cursor.uiNonce); return cursor.uiNonce !== 'deadbeef'; },
    onMessage: async () => true });
  assert.equal(receiver.uiNonce, null);
  // A frame whose cursor the host refuses (a retired UI, say) adopts nothing.
  assert.equal((await receiver.accept(heartbeat({ ...BOOTSTRAP, uiNonce: 'deadbeef' }))).reason, 'cursor');
  assert.equal(receiver.uiNonce, null);
  assert.equal((await receiver.accept(heartbeat({ ...BOOTSTRAP }))).accepted, true);
  assert.equal(receiver.uiNonce, SESSION.uiNonce);
  assert.equal((await receiver.accept(frame({ payload: ctx() }))).ack, 1);
  // Another UI session still reaches the cursor (that is how the host learns of a reload) but is not this receiver's.
  const other = await receiver.accept(frame({ uiNonce: '0badf00d', seq: 2, payload: ctx('x', 2) }));
  assert.equal(other.reason, 'session'); assert.equal(receiver.ack, 1); assert.equal(receiver.uiNonce, SESSION.uiNonce);
  assert.deepEqual(cursors, ['deadbeef', SESSION.uiNonce, SESSION.uiNonce, '0badf00d']);
  // A receiver rebuilt after a reload must not adopt the retired UI's stale data frame either:
  // adoption always needs a cursor the host follows, whatever the frame kind.
  const rebuilt = new CooldownCarrierReceiver({ epoch: SESSION.epoch, nonce: SESSION.nonce, uiNonce: null,
    onCursor: cursor => cursor.uiNonce !== 'deadbeef', onMessage: async () => true });
  assert.equal((await rebuilt.accept(frame({ uiNonce: 'deadbeef', payload: ctx() }))).reason, 'cursor');
  assert.equal(rebuilt.uiNonce, null); assert.equal(rebuilt.ack, 0);
  assert.equal((await rebuilt.accept(frame({ payload: ctx() }))).ack, 1);
  assert.equal(rebuilt.uiNonce, SESSION.uiNonce);
  assert.throws(() => new CooldownCarrierReceiver({ ...SESSION, uiNonce: 'nope', onMessage: async () => true }));
  assert.throws(() => new CooldownCarrierReceiver({ ...SESSION, onCursor: 'nope', onMessage: async () => true }));
});

test('reader dispatches a heartbeat whose slot moved and ignores an unchanged one', async () => {
  const cursors = [];
  const receiver = new CooldownCarrierReceiver({ ...SESSION, onCursor: cursor => { cursors.push(cursor.nextSeq); return true; },
    onMessage: async () => true });
  let current = heartbeat({ slot: 2 });
  const reader = new CooldownCarrierReader({ characterDir: path.resolve('C:/fixture/char'), receiver,
    read: async () => ({ frame: current }) });
  assert.equal((await reader.poll()).heartbeat, true);
  assert.equal((await reader.poll()).duplicatePoll, true);
  current = heartbeat({ slot: 3 });
  assert.equal((await reader.poll()).heartbeat, true);
  assert.deepEqual(cursors, [2, 3]);
});

test('a re-advertised frame moves the host cursor even when its sequence is already acknowledged', async () => {
  // The addon rewrites a waiting frame with the slot it now wants. The host may have accepted the
  // first version already; the rewrite is then refused as a mutation, but the cursor it names is
  // still followed, which is what lets the acknowledgement reach the addon.
  const cursors = [];
  const receiver = new CooldownCarrierReceiver({ epoch: '1234abcd', nonce: '89abcdef', uiNonce: '10293847',
    onCursor: cursor => { cursors.push(cursor.nextSeq); return true; }, onMessage: async () => true });
  const frame = slot => ({ epoch: '1234abcd', nonce: '89abcdef', uiNonce: '10293847', seq: 1, message: 1, part: 1,
    count: 1, slot, kind: 'context', payload: encodeCooldownContext({ id: 1, text: 'hello' }) });
  const first = await receiver.accept(frame(54));
  assert.equal(first.accepted, true); assert.equal(first.ack, 1);
  const rewritten = await receiver.accept(frame(55));
  assert.equal(rewritten.accepted, false); assert.equal(rewritten.reason, 'mutation');
  assert.deepEqual(cursors, [54, 55], 'the rewritten slot still reaches the ring writer');
  assert.equal(rewritten.checksum, first.checksum, 'the published checksum stays the first version, which the addon accepts');
});
