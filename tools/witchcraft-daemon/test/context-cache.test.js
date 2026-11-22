import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ContextCache, CONTEXT_TTL_MS, HEARTBEAT_REFRESH_MS, MAX_CONTEXT_FILE_BYTES, contextWriteKey, presentContext, readContextFile, scopeContext, shouldPersistContext } from '../src/context-cache.js';

const epoch = '0123abcd', uiNonce = 'abcd0123', now = 1_000_000;
const player = ['Thrall', 'Shaman', 10, 1412, 'Mulgore', 'Bloodhoof Village', []];
const quest = (id, title = 'A quest') => [id, title, false, [['Claws collected', 1, 4, false]], false];
const progress = [123456, 4200, 8800, 1200, true, 'party', 'Ragefire Chasm', 'Normal', 5, 'HEALER', false, false, true, []];
function packet(domain, data, { id = 1, rev = 1, part = 1, total = 1, age = 0, ...rest } = {}) {
  return { kind: 'context', epoch, uiNonce, id, text: JSON.stringify([1, domain, rev, part, total, age, data]), ...rest };
}
function cache() { const value = new ContextCache({ epoch }); value.setSession(epoch, uiNonce); value.heartbeat(now); return value; }
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'witchcraft-context-'));
  t.after(async () => { assert.equal(path.dirname(dir), os.tmpdir()); await fs.rm(dir, { force: true, recursive: true }); });
  return path.join(dir, 'context.json');
}

test('session reset invalidates character, quests, pending batches, and independent acknowledgement', () => {
  const value = cache();
  assert.equal(value.accept(packet('player', player), now).accepted, true);
  value.accept(packet('quests', [true, '', 2, false, [quest(1)]], { id: 2, total: 2 }), now);
  assert.equal(value.setSession(epoch, uiNonce), false);
  assert.equal(value.setSession(epoch, 'aabbccdd'), true);
  assert.equal(value.ack, 0);
  assert.equal(value.snapshot(now).player, null);
  assert.equal(value.accept(packet('player', player, { id: 3 }), now).accepted, false);
});

test('wire unavailable scalars become null and sample age includes pixel transport', () => {
  const value = cache();
  value.accept(packet('player', ['Thrall', false, 10, false, 'Mulgore', false, ['class', 'mapId', 'subzone']],
    { age: 25, transportAgeSeconds: 3.2 }), now);
  const result = value.snapshot(now);
  assert.equal(result.player.data.class, null);
  assert.equal(result.player.data.location.mapId, null);
  assert.equal(result.player.sampledAt, now - 28200);
  assert.equal(result.player.ageSeconds, 28);
});

test('duplicate and older revisions acknowledge without refreshing observations', () => {
  const value = cache();
  value.accept(packet('player', player, { rev: 2, id: 2 }), now);
  const observed = value.snapshot(now).player;
  value.accept(packet('player', player, { rev: 2, id: 3 }), now + 50_000);
  value.accept(packet('player', ['Old', ...player.slice(1)], { rev: 1, id: 4 }), now + 60_000);
  const latest = value.snapshot(now + 60_000).player;
  assert.equal(value.ack, 4);
  assert.equal(latest.sampledAt, observed.sampledAt);
  assert.equal(latest.receivedAt, observed.receivedAt);
  assert.equal(latest.data.name, 'Thrall');
});

test('quest batches replace atomically and retain the oldest sample timestamp', () => {
  const value = cache();
  value.accept(packet('quests', [true, '', 1, false, [quest(9)]], { id: 1 }), now);
  value.accept(packet('quests', [true, '', 2, false, [quest(2)]], { id: 2, rev: 2, part: 2, total: 2, age: 20 }), now + 10_000);
  assert.deepEqual(value.snapshot(now).quests.data.quests.map(row => row.id), [9]);
  value.accept(packet('quests', [true, '', 2, false, [quest(1)]], { id: 3, rev: 2, total: 2 }), now + 15_000);
  const result = value.snapshot(now + 15_000).quests;
  assert.deepEqual(result.data.quests.map(row => row.id), [1, 2]);
  assert.equal(result.sampledAt, now - 10_000);
  assert.equal(result.data.quests[0].objectives[0].required, 4);
});

test('conflicting parts and duplicate quest IDs cannot publish a mixed batch', () => {
  const value = cache();
  value.accept(packet('quests', [true, '', 2, false, [quest(1)]], { id: 1, total: 2 }), now);
  assert.equal(value.accept(packet('quests', [true, '', 2, false, [quest(3)]], { id: 2, total: 2 }), now).accepted, false);
  assert.equal(value.accept(packet('quests', [true, '', 2, true, [quest(2)]], { id: 3, part: 2, total: 2 }), now).accepted, false);
  assert.equal(value.accept(packet('quests', [true, '', 2, false, [quest(1)]], { id: 4, part: 2, total: 2 }), now).accepted, false);
  assert.equal(value.snapshot(now).quests, null);
});

test('unavailable quests and no tracked quests have distinct states', () => {
  const value = cache();
  value.accept(packet('quests', [false, 'api-unavailable', 0, false, []]), now);
  assert.equal(value.snapshot(now).quests.status, 'unavailable');
  value.accept(packet('quests', [true, '', 0, false, []], { rev: 2, id: 2 }), now);
  assert.equal(value.snapshot(now).quests.status, 'available');
  assert.deepEqual(value.snapshot(now).quests.data.quests, []);
});

test('fresh heartbeats never refresh stale game data and disconnect is immediate', () => {
  const value = cache();
  value.accept(packet('player', player), now);
  value.heartbeat(now + CONTEXT_TTL_MS + 1);
  const result = value.snapshot(now + CONTEXT_TTL_MS + 1);
  assert.equal(result.player.status, 'stale');
  assert.equal(result.status, 'stale');
  assert.equal(result.connection.status, 'connected');
  value.disconnect();
  assert.equal(value.snapshot(now).connection.status, 'disconnected');
});

test('disabling immediately clears data and rejects delayed context until reenabled', () => {
  const value = cache();
  value.accept(packet('player', player), now);
  value.accept(packet('state', [false], { id: 2 }), now);
  assert.equal(value.snapshot(now).status, 'disabled');
  assert.equal(value.snapshot(now).player, null);
  assert.equal(value.accept(packet('player', player, { rev: 2, id: 3 }), now).accepted, false);
  value.accept(packet('state', [true], { rev: 2, id: 4 }), now);
  assert.equal(value.accept(packet('player', player, { rev: 3, id: 5 }), now).accepted, true);
});

test('malformed, oversized, foreign, and unsupported packets never advance acknowledgement', () => {
  const value = cache();
  for (const message of [
    packet('player', player, { kind: 'input' }), packet('player', player, { uiNonce: '11223344' }),
    packet('player', player, { id: 0 }), packet('player', player, { text: '{' }),
    packet('player', player, { text: 'a'.repeat(581) }), packet('player', player, { part: 2, total: 2 }),
    packet('other', []), packet('player', ['x']), packet('player', player, { transportAgeSeconds: 61 }),
    packet('quests', [true, '', 1, false, [quest(1), quest(2)]]),
  ]) assert.equal(value.accept(message, now).accepted, false);
  assert.equal(value.ack, 0);
});

test('bounded cache reader distinguishes missing, malformed, and oversized files', async t => {
  const file = await fixture(t);
  assert.equal((await readContextFile(file, { now })).reason, 'cache-missing');
  await fs.writeFile(file, '{');
  assert.equal((await readContextFile(file, { now })).reason, 'invalid-cache');
  await fs.writeFile(file, Buffer.alloc(MAX_CONTEXT_FILE_BYTES + 1, 32));
  assert.equal((await readContextFile(file, { now })).reason, 'invalid-cache');
});

test('disk round trip recomputes stale labels, strips extra data, and rejects future timestamps', async t => {
  const file = await fixture(t), value = cache();
  value.accept(packet('player', player), now);
  const raw = value.snapshot(now);
  raw.status = 'ready'; raw.player.status = 'available'; raw.player.data.extra = 'discard'; raw.extra = 'discard';
  await fs.writeFile(file, JSON.stringify(raw));
  const result = await readContextFile(file, { now: now + CONTEXT_TTL_MS + 1 });
  assert.equal(result.player.status, 'stale');
  assert.equal(result.status, 'disconnected');
  assert.equal(result.player.data.extra, undefined);
  assert.equal(result.extra, undefined);
  assert.equal(presentContext(raw, now - 10_000).reason, 'invalid-cache');
});

test('initial empty snapshot can be persisted before the first UI heartbeat', async t => {
  const file = await fixture(t);
  await fs.writeFile(file, JSON.stringify(new ContextCache({ epoch }).snapshot(now)));
  const result = await readContextFile(file, { now });
  assert.equal(result.status, 'waiting');
  assert.equal(result.player.status, 'missing');
});

test('numeric and UTF-8 limits accept the full Lua adapter contract through disk round trip', async t => {
  const file = await fixture(t), value = cache();
  const maximum = 2_147_483_647;
  const name = '\u{1f315}'.repeat(10), title = '\u{1f315}'.repeat(16);
  assert.equal(value.accept(packet('player', [name, 'Shaman', 1000, maximum, 'Mulgore', '', []]), now).accepted, true);
  assert.equal(value.accept(packet('quests', [true, '', 1000, true,
    [[maximum, title, false, [[title, maximum, maximum, false]], false]]], { id: 2 }), now).accepted, true);
  await fs.writeFile(file, JSON.stringify(value.snapshot(now)));
  const result = await readContextFile(file, { now });
  assert.equal(result.player.data.name, name);
  assert.equal(result.player.data.level, 1000);
  assert.equal(result.player.data.location.mapId, maximum);
  assert.equal(result.quests.data.trackedCount, 1000);
  assert.equal(result.quests.data.quests[0].id, maximum);
  assert.equal(result.quests.data.quests[0].objectives[0].required, maximum);
});

test('exact field limits reject overflow, invalid UTF-8 scalars, and excessive objectives without acknowledgement', () => {
  const value = cache();
  const questPayload = row => [true, '', 1, false, [row]];
  for (const data of [
    ['\u{1f315}'.repeat(10) + 'a', ...player.slice(1)],
    ['\ud800', ...player.slice(1)], ['line\nname', ...player.slice(1)],
    [player[0], player[1], 1001, ...player.slice(3)],
    [player[0], player[1], 0, ...player.slice(3)],
    [...player.slice(0, 3), 2_147_483_648, ...player.slice(4)],
    [...player.slice(0, 6), ['r'.repeat(65)]],
  ]) assert.equal(value.accept(packet('player', data), now).accepted, false);
  for (const data of [
    questPayload(quest(2_147_483_648)), questPayload(quest(1, '\u{1f315}'.repeat(16) + 'a')),
    [true, '', 1001, false, [quest(1)]], [false, 'r'.repeat(65), 0, false, []],
    questPayload([1, 'Quest', false, [['x'.repeat(65), 0, 1, false]], false]),
    questPayload([1, 'Quest', false, [['Progress', 0, 2_147_483_648, false]], false]),
    questPayload([1, 'Quest', false, Array(5).fill(['Progress', 0, 1, false]), false]),
  ]) assert.equal(value.accept(packet('quests', data), now).accepted, false);
  assert.equal(value.ack, 0);
});

test('all-unavailable player context preserves a bounded native diagnostic reason', async t => {
  const file = await fixture(t), value = cache();
  const fields = ['name:restricted', 'class:guard-missing', 'level:unavailable', 'mapId:missing'];
  assert.equal(value.accept(packet('player', [false, false, false, false, false, false, fields]), now).accepted, true);
  await fs.writeFile(file, JSON.stringify(value.snapshot(now)));
  const result = await readContextFile(file, { now });
  assert.equal(result.player.status, 'unavailable');
  assert.equal(result.player.data, null);
  assert.equal(result.player.reason, fields.join(', '));
  const longFields = Array(6).fill('\u{1f315}'.repeat(10));
  assert.equal(value.accept(packet('player', [false, false, false, false, false, false, longFields], { id: 2, rev: 2 }), now).accepted, true);
  const bounded = value.snapshot(now).player.reason;
  assert.ok(Buffer.byteLength(bounded, 'utf8') <= 160);
  assert.doesNotMatch(bounded, /[\ud800-\udfff]/u);
});

test('an unchanged document is not rewritten, and a drifting heartbeat only forces a write once it matters', () => {
  const cache = new ContextCache({ epoch });
  cache.setSession(epoch, uiNonce);
  cache.heartbeat(now);
  assert.equal(cache.accept(packet('player', player), now).accepted, true);

  // Nothing has changed since the first write, so the document on disk still speaks for the cache.
  const written = { key: contextWriteKey(cache.raw), lastHeartbeatAt: cache.raw.lastHeartbeatAt };
  assert.equal(shouldPersistContext(null, cache.raw), true, 'a document never written must be written');
  assert.equal(shouldPersistContext(written, cache.raw), false);

  // A heartbeat that has barely moved is not worth a rewrite; one that has aged is.
  cache.heartbeat(now + HEARTBEAT_REFRESH_MS - 1);
  assert.equal(shouldPersistContext(written, cache.raw), false);
  cache.heartbeat(now + HEARTBEAT_REFRESH_MS);
  assert.equal(shouldPersistContext(written, cache.raw), true);

  // Real content always forces a write, however recently the last one happened.
  const current = { key: contextWriteKey(cache.raw), lastHeartbeatAt: cache.raw.lastHeartbeatAt };
  assert.equal(cache.accept(packet('player', player, { id: 2, rev: 2 }), now).accepted, true);
  assert.equal(shouldPersistContext(current, cache.raw), true);
});

test('progress is accepted as one part; unavailable scalars become null but a boolean keeps false unless reported unavailable', async t => {
  const file = await fixture(t), value = cache();
  assert.equal(value.accept(packet('progress', progress, { age: 5, transportAgeSeconds: 2 }), now).accepted, true);
  const view = value.snapshot(now).progress;
  assert.equal(view.status, 'available');
  assert.equal(view.sampledAt, now - 7000);
  assert.deepEqual(view.data, { money: 123456, xp: 4200, xpMax: 8800, rested: 1200,
    situation: { inInstance: true, instanceType: 'party', instanceName: 'Ragefire Chasm', difficulty: 'Normal', groupSize: 5, role: 'HEALER',
      dead: false, ghost: false, combat: true }, unavailableFields: [] });
  // Level cap: xp and xpMax are false with a reason, never zero; solo and out of an instance every situation scalar is false.
  const capped = [0, false, false, false, false, 'none', false, false, 0, false, false, false, false, ['xp:cap', 'xpMax:cap', 'rested:cap']];
  assert.equal(value.accept(packet('progress', capped, { id: 2, rev: 2 }), now).accepted, true);
  await fs.writeFile(file, JSON.stringify(value.snapshot(now)));
  const result = await readContextFile(file, { now });
  assert.equal(result.progress.status, 'available');
  assert.deepEqual(result.progress.data, { money: 0, xp: null, xpMax: null, rested: null,
    situation: { inInstance: false, instanceType: 'none', instanceName: null, difficulty: null, groupSize: 0, role: null, dead: false, ghost: false, combat: false },
    unavailableFields: ['xp:cap', 'xpMax:cap', 'rested:cap'] });
  // A boolean the addon could not read is null, and a record of nothing but unreadable fields is unavailable.
  const blind = [false, false, false, false, false, false, false, false, false, false, false, false, false,
    ['money:missing', 'inInstance:restricted', 'dead:missing', 'ghost:missing', 'combat:unavailable']];
  const separate = cache();
  assert.equal(separate.accept(packet('progress', blind), now).accepted, true);
  const blindView = separate.snapshot(now).progress;
  assert.equal(blindView.available, false); assert.equal(blindView.data, null);
  const partly = [false, false, false, false, false, false, false, false, false, false, false, false, false, ['dead:missing']];
  const other = cache();
  assert.equal(other.accept(packet('progress', partly), now).accepted, true);
  assert.deepEqual(other.snapshot(now).progress.data.situation, { inInstance: false, instanceType: null, instanceName: null, difficulty: null,
    groupSize: null, role: null, dead: null, ghost: false, combat: false });
  assert.equal(result.status, 'partial', 'the whole document owns all three domains');
  // A multipart progress message and a second-part revision conflict never land.
  assert.equal(value.accept(packet('progress', progress, { id: 3, rev: 3, total: 2 }), now).accepted, false);
  assert.equal(value.accept(packet('progress', progress, { id: 3, rev: 3, part: 2, total: 2 }), now).accepted, false);
  assert.equal(value.ack, 2);
});

test('all-unavailable progress keeps a bounded reason and bad shapes never acknowledge', () => {
  const value = cache();
  // Every scalar is false and every boolean is reported unreadable, so nothing in the record was observed.
  const fields = ['money:restricted', 'xp:missing', 'inInstance:missing', 'dead:missing', 'ghost:missing', 'combat:missing'];
  assert.equal(value.accept(packet('progress', [...Array(13).fill(false), fields]), now).accepted, true);
  const view = value.snapshot(now).progress;
  assert.equal(view.status, 'unavailable');
  assert.equal(view.data, null);
  assert.equal(view.reason, fields.join(', '));
  const at = (index, item) => progress.map((entry, position) => position === index ? item : entry);
  for (const data of [
    progress.slice(0, 13), [...progress, []], at(0, -1), at(0, 2_147_483_648), at(1, 1.5), at(2, '8800'), at(3, true),
    at(4, 'yes'), at(5, 'x'.repeat(17)), at(6, '\u{1f315}'.repeat(10) + 'a'), at(7, 'x'.repeat(25)), at(8, 1001), at(8, -1),
    at(9, 'x'.repeat(9)), at(10, 1), at(11, 'ghost'), at(12, null), at(13, ['r'.repeat(65)]), at(13, Array(15).fill('x')),
    at(6, 'line\nname'), at(13, [1]),
  ]) assert.equal(value.accept(packet('progress', data, { id: 2, rev: 2 }), now).accepted, false, JSON.stringify(data));
  assert.equal(value.ack, 1);
});

test('disabling clears progress with the other domains and the disk key is additive', async t => {
  const file = await fixture(t), value = cache();
  value.accept(packet('player', player), now);
  value.accept(packet('progress', progress, { id: 2 }), now);
  value.accept(packet('state', [false], { id: 3 }), now);
  assert.equal(value.snapshot(now).progress, null);
  assert.equal(value.accept(packet('progress', progress, { id: 4, rev: 2 }), now).accepted, false);
  value.accept(packet('state', [true], { id: 5, rev: 2 }), now);
  assert.equal(value.accept(packet('progress', progress, { id: 6, rev: 2 }), now).accepted, true);
  value.accept(packet('player', player, { id: 7, rev: 2 }), now);
  const raw = value.snapshot(now);
  assert.equal(raw.schemaVersion, 1);
  raw.enabled = false;
  assert.equal(presentContext(raw, now).progress.status, 'disabled');
  // A document written before this domain existed still reads; progress is simply missing.
  const { progress: _absent, ...legacy } = value.snapshot(now);
  await fs.writeFile(file, JSON.stringify(legacy));
  const result = await readContextFile(file, { now });
  assert.equal(result.progress.status, 'missing');
  assert.equal(result.status, 'partial');
});

test('status over a domain subset ignores domains the caller does not own', () => {
  const value = cache(), present = at => presentContext(value.snapshot(at), at);
  value.accept(packet('player', player), now);
  const full = present(now);
  assert.equal(full.status, 'partial');
  const character = scopeContext(full, ['player']);
  assert.equal(character.status, 'ready');
  assert.equal(character.player.status, 'available');
  assert.equal(character.quests, undefined); assert.equal(character.progress, undefined);
  assert.equal(scopeContext(full, ['progress']).status, 'waiting');
  assert.equal(scopeContext(full, ['player', 'quests']).status, 'partial');
  value.heartbeat(now + CONTEXT_TTL_MS + 1);
  const stale = present(now + CONTEXT_TTL_MS + 1);
  assert.equal(scopeContext(stale, ['player']).status, 'stale');
  assert.equal(scopeContext(stale, ['quests']).status, 'waiting');
  value.heartbeat(now);
  value.accept(packet('quests', [false, 'api-unavailable', 0, false, []], { id: 2 }), now);
  assert.equal(scopeContext(present(now), ['quests']).status, 'unavailable');
  // Session-wide states are not domain-scored, and neither is an unreadable cache.
  value.accept(packet('state', [false], { id: 3 }), now);
  assert.equal(scopeContext(present(now), ['player']).status, 'disabled');
  value.accept(packet('state', [true], { id: 4, rev: 2 }), now);
  value.disconnect();
  assert.equal(scopeContext(present(now), ['player']).status, 'disconnected');
  const missing = scopeContext(presentContext('{', now), ['player']);
  assert.equal(missing.status, 'unavailable'); assert.equal(missing.reason, 'invalid-cache');
  assert.equal(scopeContext(presentContext(new ContextCache({ epoch }).snapshot(now), now), ['player']).status, 'waiting');
});

const errorRow = (message, last = 0) => ['error', message, ['Hello/Hello.lua:3: in main chunk'], 2, last + 30, last, 1];
test('errors assemble newest first from one entry per part and keep absolute times', () => {
  const value = cache();
  assert.equal(value.accept(packet('errors', [true, '', 3, false, [errorRow('older', 20)]], { id: 1, part: 2, total: 2, age: 5 }), now).accepted, true);
  assert.equal(value.snapshot(now).errors, null, 'a partial batch publishes nothing');
  assert.equal(value.accept(packet('errors', [true, '', 3, false, [errorRow('newer')]], { id: 2, part: 1, total: 2, age: 5 }), now).accepted, true);
  const errors = value.snapshot(now).errors;
  assert.equal(errors.status, 'available');
  assert.deepEqual(errors.data.entries.map(entry => entry.message), ['newer', 'older']);
  assert.equal(errors.data.storedCount, 3);
  assert.equal(errors.data.truncated, true, 'three stored but two sent is truncation');
  assert.equal(errors.data.entries[1].lastSeenAt, now - 25_000);
  assert.equal(errors.data.entries[1].firstSeenAt, now - 55_000);
  assert.equal(errors.data.entries[1].lastSeenSecondsAgo, 25);
  assert.equal(errors.data.entries[0].reloadsAgo, 1);
  assert.equal(value.snapshot(now).status, 'waiting', 'errors alone never make the game document ready or partial');
});

test('an empty error store is available with no entries, and bad error shapes never acknowledge', () => {
  const value = cache();
  assert.equal(value.accept(packet('errors', [true, '', 0, false, []]), now).accepted, true);
  assert.deepEqual(value.snapshot(now).errors.data, { storedCount: 0, truncated: false, entries: [] });
  for (const data of [[true, '', 1, false, [['panic', 'x', [], 1, 0, 0, 0]]], [true, '', 1, false, [['error', 'x'.repeat(241), [], 1, 0, 0, 0]]],
    [true, '', 1, false, [['error', 'x', ['a', 'b', 'c', 'd'], 1, 0, 0, 0]]], [true, '', 1, false, [['error', 'x', ['y'.repeat(150), 'z'.repeat(60)], 1, 0, 0, 0]]],
    [true, '', 1, false, [['error', 'x', [], 0, 0, 0, 0]]], [true, '', 21, false, []], [true, '', 1, false, [errorRow('a'), errorRow('b')]]])
    assert.equal(value.accept(packet('errors', data, { id: 9 }), now).accepted, false, JSON.stringify(data).slice(0, 80));
  assert.equal(value.ack, 1);
});

test('disabling clears errors with the other domains', () => {
  const value = cache();
  value.accept(packet('errors', [true, '', 1, false, [errorRow('x')]]), now);
  value.accept(packet('state', [false], { id: 2 }), now);
  assert.equal(value.snapshot(now).errors, null);
  assert.equal(presentContext(value.snapshot(now), now).errors.status, 'disabled');
});
