import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ContextCache, HEARTBEAT_TTL_MS } from '../src/context-cache.js';
import { BINDING_KEYS, BINDING_PROBE_BODY, BindingCarrier, BindingReceiver, discoverBindingFiles,
  encodeBindingAction, parseBindingAction, parseBindingFile, readStableBindingFile } from '../src/binding-carrier.js';

const session = Object.freeze({ epoch: '0123abcd', nonce: '89abcdef', uiNonce: 'abcdef01' });
const action = (overrides = {}) => encodeBindingAction({ ...session, slot: 7, seq: 2, part: 1, count: 1,
  payload: Buffer.from('payload'), ...overrides });
const parsed = overrides => parseBindingAction(action(overrides));

test('re-reading an unchanged binding retries the slot without extending player-action liveness', async () => {
  let now = 1_000;
  const cache = new ContextCache(), confirmed = [];
  const receiver = new BindingReceiver({ ...session,
    onCursor(frame) {
      cache.setSession(session.epoch, frame.uiNonce);
      cache.heartbeat(now);
      return true;
    },
    onConfirmedCursor(frame) { if (cache.confirmPlayerActionCursor(frame, now)) confirmed.push(frame.slot); },
  });
  // Previous-run bytes can advertise a slot before the binding receiver checks their host ids.
  await receiver.accept(parsed({ epoch: 'deadbeef' }));
  assert.equal(cache.raw.playerActionSeenAt, null);
  await receiver.accept(parsed({ epoch: '00000000', nonce: '00000000', seq: 1, payload: BINDING_PROBE_BODY }));
  assert.equal(cache.raw.playerActionSeenAt, null);
  const heartbeat = parsed({ seq: 0, payload: Buffer.from([0x48, 0]) });
  assert.equal((await receiver.accept(heartbeat)).accepted, true);
  assert.equal(cache.raw.playerActionSeenAt, now);
  now += HEARTBEAT_TTL_MS + 1;
  assert.equal((await receiver.accept(heartbeat)).accepted, true, 'cursor retries remain available');
  assert.equal(cache.raw.lastHeartbeatAt, now);
  assert.ok(now - cache.raw.playerActionSeenAt > HEARTBEAT_TTL_MS);
  await receiver.accept(parsed({ seq: 0, slot: 8, payload: Buffer.from([0x48, 0]) }));
  assert.deepEqual(confirmed, [7, 8]);
  assert.equal(cache.raw.playerActionSeenAt, now);
  cache.setSession(session.epoch, '11112222');
  assert.equal(cache.confirmPlayerActionCursor(heartbeat, now), false, 'late completion after a reload');
  assert.equal(cache.raw.playerActionSeenAt, null);
});

test('binding carrier parser is anchored, canonical, CRC checked and key allowlisted', () => {
  const valid = action();
  assert.deepEqual(parseBindingAction(valid).payload, Buffer.from('payload'));
  assert.equal(parseBindingFile(`bind MOUSEWHEELUP STARTAUTORUN\nbind ${BINDING_KEYS[0]} ${valid}\n`).length, 1);
  const corrupt = valid.replace(/_[0-9A-F]{8}:LeftButton$/u, '_00000000:LeftButton');
  for (const candidate of [valid.toLowerCase(), `${valid} `, corrupt,
    valid.replace('_01_01_', '_00_01_'), valid.replace('ABCDEF01', '00000000')]) {
    assert.throws(() => parseBindingAction(candidate));
  }
  assert.throws(() => parseBindingFile(`bind CTRL-F12 ${valid}\n`), /allowlist/u);
  assert.throws(() => parseBindingFile(`bind ${BINDING_KEYS[0]} ${valid}\nbind ${BINDING_KEYS[1]} ${valid}\n`), /Multiple/u);
  assert.deepEqual(parseBindingFile(`bind ${BINDING_KEYS[0]} SOMETHING_ELSE\n`), []);
  assert.throws(() => parseBindingFile(Buffer.from([0xff])), /encoded data/u);
});

test('binding receiver bootstraps once, republishes exact duplicates and quarantines same-sequence mutation', async () => {
  const acks = [], cursors = [];
  const receiver = new BindingReceiver({ ...session,
    onCursor(frame) { cursors.push([frame.uiNonce, frame.slot]); return true; },
    onAck(ack, frame, outcome) { acks.push([ack, frame.action, outcome]); },
  });
  const probeAction = encodeBindingAction({ epoch: '00000000', nonce: '00000000', uiNonce: session.uiNonce,
    slot: 6, seq: 1, part: 1, count: 1, payload: BINDING_PROBE_BODY });
  const probe = parseBindingAction(probeAction);
  assert.equal((await receiver.accept(probe)).probe, true);
  assert.equal((await receiver.accept(probe)).duplicate, true);
  assert.deepEqual(cursors, [[session.uiNonce, 6], [session.uiNonce, 6]]);
  assert.equal(acks.length, 2); assert.equal(receiver.ack, 1);
  const mutation = parseBindingAction(encodeBindingAction({ epoch: '00000000', nonce: '00000000', uiNonce: session.uiNonce,
    slot: 6, seq: 1, part: 1, count: 1, payload: Buffer.from('PFAM_BIND_PROBf') }));
  await assert.rejects(receiver.accept(mutation), /sequence mutation/u);
  assert.match(receiver.quarantined, /mutation/u);
});

test('binding heartbeat moves the cursor, is never acknowledged and leaves the stop-and-wait state alone', async () => {
  const acks = [], cursors = [], messages = [];
  const receiver = new BindingReceiver({ ...session,
    onCursor(frame) { cursors.push({ uiNonce: frame.uiNonce, slot: frame.slot }); return true; },
    onMessage(message) { messages.push(message); return { accepted: true }; },
    onAck(ack) { acks.push(ack); },
  });
  const beat = (overrides = {}) => encodeBindingAction({ ...session, slot: 2, seq: 0, part: 1, count: 1,
    payload: Buffer.from([0x48, 1]), ...overrides });
  const heartbeat = parseBindingAction(beat());
  assert.equal(heartbeat.seq, 0);
  // The heartbeat names the session the probe opens; before it there is none to match.
  assert.equal((await receiver.accept(heartbeat)).reason, 'session');
  await receiver.accept(parseBindingAction(encodeBindingAction({ epoch: '00000000', nonce: '00000000',
    uiNonce: session.uiNonce, slot: 1, seq: 1, part: 1, count: 1, payload: BINDING_PROBE_BODY })));
  cursors.length = 0; acks.length = 0;
  const first = await receiver.accept(heartbeat);
  assert.equal(first.accepted, true); assert.equal(first.heartbeat, true); assert.equal(first.cursorMoved, true);
  assert.deepEqual(cursors, [{ uiNonce: session.uiNonce, slot: 2 }]);
  assert.equal(receiver.ack, 1); assert.deepEqual(acks, []);
  assert.equal(receiver.pending, null); assert.equal(receiver.quarantined, false); assert.equal(receiver.seen.has(0), false);
  // An unchanged file is read again: the cursor is offered again and nothing else moves.
  const again = await receiver.accept(heartbeat);
  assert.equal(again.heartbeat, true); assert.equal(again.cursorMoved, false);
  assert.equal(cursors.length, 2); assert.equal(receiver.ack, 1); assert.deepEqual(acks, []);
  // Foreign ids and any other sequence-0 body are refused without touching the cursor or the ACK.
  assert.equal((await receiver.accept(parseBindingAction(beat({ nonce: '11111111' })))).reason, 'session');
  assert.throws(() => beat({ payload: Buffer.from('I\x00\x00\x01\x01\x00') }), /coordinates/u);
  // Flags above 3 are no heartbeat in either codec; the parsed action was encoded before the bound existed.
  assert.doesNotThrow(() => beat({ payload: Buffer.from([0x48, 3]) }));
  assert.throws(() => beat({ payload: Buffer.from([0x48, 4]) }), /coordinates/u);
  assert.throws(() => parseBindingAction('CLICK WitchcraftCarrier_V1_1234ABCD_89ABCDEF_ABCDEF01_0002_000000_01_01_JACA_425003FF:LeftButton'), /coordinates/u);
  const input = (await receiver.accept({ ...heartbeat, payload: Buffer.from([0x49, 0, 0, 1, 1, 0]) }));
  assert.equal(input.accepted, false); assert.equal(input.reason, 'malformed heartbeat');
  assert.equal((await receiver.accept({ ...heartbeat, payload: Buffer.from([0x48, 4]) })).accepted, false);
  assert.equal(cursors.length, 2); assert.equal(receiver.ack, 1); assert.deepEqual(messages, []);
  // The next data frame still follows stop-and-wait and is acknowledged.
  const id = Buffer.alloc(3); id.writeUIntBE(1, 0, 3);
  const data = await receiver.accept(parseBindingAction(encodeBindingAction({ ...session, slot: 3, seq: 2, part: 1, count: 1,
    payload: Buffer.concat([Buffer.from('I'), id, Buffer.from([1, 0]), Buffer.from('hi')]) })));
  assert.equal(data.accepted, true); assert.equal(receiver.ack, 2); assert.deepEqual(acks, [2]);
  assert.equal(messages.length, 1); assert.equal(messages[0].text, 'hi');
  // A heartbeat body on a data sequence is a malformed body, consumed once as rejected.
  const stray = await receiver.accept(parseBindingAction(encodeBindingAction({ ...session, slot: 3, seq: 3, part: 1, count: 1,
    payload: Buffer.from([0x48, 0]) })));
  assert.equal(stray.accepted, false); assert.match(stray.reason, /Heartbeat outside sequence 0/u);
  assert.equal(messages.length, 1);
});

test('binding receiver reassembles UTF-8 input, holds final ACK on rejection and accepts a retry once', async () => {
  let accept = false;
  const messages = [], acks = [];
  const receiver = new BindingReceiver({ ...session, onCursor: () => true,
    onMessage(message) { messages.push(message); return { accepted: accept, reason: accept ? undefined : 'closed' }; },
    onAck(ack) { acks.push(ack); },
  });
  const probe = parseBindingAction(encodeBindingAction({ epoch: '00000000', nonce: '00000000', uiNonce: session.uiNonce,
    slot: 1, seq: 1, part: 1, count: 1, payload: BINDING_PROBE_BODY }));
  await receiver.accept(probe);
  const text = 'Ask Codex: \u041f\u0440\u0438\u0432\u0456\u0442';
  const id = Buffer.alloc(3); id.writeUIntBE(17, 0, 3);
  const body = Buffer.concat([Buffer.from('I'), id, Buffer.from([1, 0]), Buffer.from(text)]);
  const pieces = [body.subarray(0, 20), body.subarray(20)];
  const first = parsed({ seq: 2, part: 1, count: 2, payload: pieces[0] });
  const final = parsed({ seq: 3, part: 2, count: 2, payload: pieces[1] });
  assert.equal((await receiver.accept(first)).partial, true); assert.equal(receiver.ack, 2);
  assert.equal((await receiver.accept(final)).accepted, false); assert.equal(receiver.ack, 2);
  accept = true;
  const result = await receiver.accept(final);
  assert.equal(result.accepted, true); assert.equal(receiver.ack, 3);
  assert.deepEqual(result.message, { epoch: session.epoch, id: 17, tab: 'codex', action: 'text', text });
  assert.equal(messages.length, 2); assert.deepEqual(acks, [1, 2, 3]);
});

test('binding discovery is recursive, ignores links, and stable read compares bytes as well as metadata', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'witchcraft-bindings-'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const character = path.join(root, 'Realm', 'Character');
  await fs.mkdir(character, { recursive: true });
  const filename = path.join(character, 'bindings-cache.wtf');
  await fs.writeFile(filename, 'bind MOUSEWHEELUP STARTAUTORUN\n');
  assert.deepEqual(await discoverBindingFiles(root), [filename]);
  assert.equal((await readStableBindingFile(filename, { delay: async () => {} })).toString(), 'bind MOUSEWHEELUP STARTAUTORUN\n');
  let calls = 0;
  const unstable = await readStableBindingFile(filename, { delay: async () => {
    if (++calls === 1) await fs.writeFile(filename, 'bind MOUSEWHEELDN STARTAUTORUN\n');
  } });
  assert.equal(unstable, null);
});

test('binding carrier scans a nested stable file and never edits it', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'witchcraft-binding-watch-'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const character = path.join(root, 'Realm', 'Character'); await fs.mkdir(character, { recursive: true });
  const probe = encodeBindingAction({ epoch: '00000000', nonce: '00000000', uiNonce: session.uiNonce,
    slot: 4, seq: 1, part: 1, count: 1, payload: BINDING_PROBE_BODY });
  const source = `bind ${BINDING_KEYS[2]} ${probe}\n`;
  const filename = path.join(character, 'bindings-cache.wtf'); await fs.writeFile(filename, source);
  const receiver = new BindingReceiver({ ...session, onCursor: () => true });
  const carrier = new BindingCarrier({ accountDir: root, receiver, watch: () => ({ close() {} }), pollMs: 10000 });
  t.after(() => carrier.stop());
  await carrier.start();
  assert.equal(receiver.ack, 1);
  assert.equal(await fs.readFile(filename, 'utf8'), source);
});

test('binding receiver keeps the lane open when delivery throws, and accepts the retransmitted final part', async () => {
  let fail = true;
  const receiver = new BindingReceiver({ ...session, onCursor: () => true,
    onMessage() { if (fail) throw new Error('tab exploded'); return { accepted: true }; } });
  await receiver.accept(parseBindingAction(encodeBindingAction({ epoch: '00000000', nonce: '00000000', uiNonce: session.uiNonce,
    slot: 1, seq: 1, part: 1, count: 1, payload: BINDING_PROBE_BODY })));
  const id = Buffer.alloc(3); id.writeUIntBE(5, 0, 3);
  const body = Buffer.concat([Buffer.from('I'), id, Buffer.from([0, 0]), Buffer.from('hello there, agent')]);
  const first = parsed({ seq: 2, part: 1, count: 2, payload: body.subarray(0, 10) });
  const final = parsed({ seq: 3, part: 2, count: 2, payload: body.subarray(10) });
  await receiver.accept(first);
  await assert.rejects(receiver.accept(final), /tab exploded/u);
  assert.equal(receiver.quarantined, false);
  fail = false;
  const retry = await receiver.accept(final);
  assert.equal(retry.accepted, true); assert.equal(receiver.ack, 3); assert.equal(receiver.quarantined, false);
});

test('binding receiver consumes a permanently malformed body once instead of retrying it every scan', async () => {
  let delivered = 0;
  const acks = [];
  const receiver = new BindingReceiver({ ...session, onCursor: () => true,
    onMessage() { delivered++; return { accepted: true }; }, onAck(ack, _frame, outcome) { acks.push([ack, outcome.reason]); } });
  await receiver.accept(parseBindingAction(encodeBindingAction({ epoch: '00000000', nonce: '00000000', uiNonce: session.uiNonce,
    slot: 1, seq: 1, part: 1, count: 1, payload: BINDING_PROBE_BODY })));
  const id = Buffer.alloc(3); id.writeUIntBE(9, 0, 3);
  const bad = parsed({ seq: 2, part: 1, count: 1, payload: Buffer.concat([Buffer.from('I'), id, Buffer.from([7, 0]), Buffer.from('x')]) });
  const first = await receiver.accept(bad);
  assert.equal(first.accepted, false); assert.match(first.reason, /malformed/u); assert.equal(receiver.ack, 2);
  assert.equal((await receiver.accept(bad)).duplicate, true);   // the rescan sees an acknowledged frame
  assert.equal(delivered, 0); assert.equal(receiver.quarantined, false);
  assert.ok(acks.some(([ack, reason]) => ack === 2 && /malformed/u.test(reason ?? '')));
});

const probeOf = (uiNonce, overrides = {}) => parseBindingAction(encodeBindingAction({ epoch: '00000000', nonce: '00000000',
  uiNonce, slot: 6, seq: 1, part: 1, count: 1, payload: BINDING_PROBE_BODY, ...overrides }));
const contextBody = text => Buffer.concat([Buffer.from([0x43, 0, 0, 1]), Buffer.from(text)]);

test('a well-formed probe from a new UI session restarts the stop-and-wait state for that session', async () => {
  const other = 'bbbbcccc', refused = new Set();
  const receiver = new BindingReceiver({ ...session, onCursor: frame => !refused.has(frame.uiNonce) });
  assert.equal((await receiver.accept(probeOf(session.uiNonce))).probe, true);
  const oldTwo = parsed({ seq: 2, payload: contextBody('a2') });
  assert.equal((await receiver.accept(oldTwo)).ack, 2);
  assert.equal((await receiver.accept(parsed({ seq: 3, payload: contextBody('a3') }))).ack, 3);
  const switched = await receiver.accept(probeOf(other));
  assert.equal(switched.probe, true); assert.equal(switched.ack, 1); assert.equal(switched.uiNonce, other);
  const newTwo = await receiver.accept(parsed({ uiNonce: other, seq: 2, payload: contextBody('b2') }));
  assert.equal(newTwo.accepted, true); assert.equal(newTwo.ack, 2); assert.equal(receiver.quarantined, false);
  // The old session's frames are another session's, never a mutation of this one's sequence.
  assert.equal((await receiver.accept(oldTwo)).reason, 'session');
  refused.add(session.uiNonce);
  assert.equal((await receiver.accept(oldTwo)).reason, 'cursor');
  assert.equal((await receiver.accept(probeOf(session.uiNonce))).reason, 'cursor');
  assert.equal(receiver.uiNonce, other); assert.equal(receiver.ack, 2); assert.equal(receiver.quarantined, false);
});

test('a foreign probe the cursor refuses resets nothing', async () => {
  let refuse = false;
  const receiver = new BindingReceiver({ ...session, onCursor: () => !refuse });
  await receiver.accept(probeOf(session.uiNonce));
  assert.equal((await receiver.accept(parsed({ seq: 2, payload: contextBody('a2') }))).ack, 2);
  refuse = true;
  assert.equal((await receiver.accept(probeOf('bbbbcccc'))).reason, 'cursor');
  assert.equal(receiver.ack, 2); assert.equal(receiver.uiNonce, session.uiNonce); assert.equal(receiver.quarantined, false);
  refuse = false;
  assert.equal((await receiver.accept(parsed({ seq: 3, payload: contextBody('a3') }))).ack, 3);
});

test('a malformed probe from a new UI session still quarantines', async () => {
  for (const overrides of [{ payload: Buffer.from('PFAM_BIND_PROBf') }, { seq: 2 }]) {
    const receiver = new BindingReceiver(session);
    await receiver.accept(probeOf(session.uiNonce));
    await assert.rejects(receiver.accept(probeOf('bbbbcccc', overrides)), /invalid bootstrap probe/u);
    assert.match(receiver.quarantined, /bootstrap/u);
  }
});
