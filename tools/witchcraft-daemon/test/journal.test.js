import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ContextCache } from '../src/context-cache.js';
import { JOURNAL_KINDS, JournalStore, clearMarkerPath, journalPath, observe, presentJournal } from '../src/journal.js';
import { atomicWrite } from '../src/ring.js';

// Raw documents come from a real ContextCache fed the same wire tuples the MCP tests use.
let messageId = 0;
function cache(epoch = '0123abcd') {
  const value = new ContextCache();
  value.setSession(epoch, 'abcd0123');
  return value;
}
function send(value, domain, revision, data, { part = 1, total = 1, now = 1000 } = {}) {
  const result = value.accept({ kind: 'context', epoch: value.raw.session.epoch, uiNonce: value.raw.session.uiNonce, id: ++messageId,
    text: JSON.stringify([1, domain, revision, part, total, 0, data]) }, now);
  assert.equal(result.accepted, true, JSON.stringify(result));
}
const player = (level, zone = 'Mulgore', subzone = '', mapId = 1412) => ['Thrall', 'Shaman', level, mapId, zone, subzone, []];
const quest = (id, { complete = false, have = 1, need = 4 } = {}) => [id, `Quest ${id}`, complete, [['Claws', have, need, false]], false];
function sendQuests(value, revision, rows, { count = rows.length, truncated = false } = {}) {
  if (!rows.length) return send(value, 'quests', revision, [true, '', 0, false, []]);
  rows.forEach((row, index) => send(value, 'quests', revision, [true, '', count, truncated, [row]], { part: index + 1, total: rows.length }));
}
const progress = ({ money = 100, inInstance = false, instanceName = false, dead = false, ghost = false, groupSize = 0 } = {}) =>
  [money, 400, 900, 50, inInstance, inInstance ? 'party' : 'none', instanceName, inInstance ? 'Normal' : false, groupSize, false, dead, ghost, false, []];
/** The events one accepted change produces, diffed from a copy taken before it. */
function step(value, change, now = 5000) {
  const before = structuredClone(value.raw);
  change();
  return observe(before, value.raw, now);
}
const kinds = events => events.map(event => event.kind);
async function scratch(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'witchcraft-journal-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return journalPath(path.join(dir, 'context.json'));
}
const money = (at, amount = at) => ({ at, domain: 'progress', revision: 1, kind: 'money-change', delta: 1, money: amount });
/** The clear marker beside a scratch journal. */
const markerFor = file => clearMarkerPath(path.join(path.dirname(file), 'context.json'));
/**
 * A rename the test holds. Once armed, the next call reports holding, waits for release() and then
 * refuses as Windows does while another process has the file open, so atomicWrite backs off and
 * checks its fence again before the retry. Every other call renames.
 */
function heldRename() {
  let armed = false, held, release;
  const holding = new Promise(resolve => { held = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const rename = async (from, to) => {
    if (!armed) return fs.rename(from, to);
    armed = false;
    held();
    await gate;
    throw Object.assign(new Error('busy'), { code: 'EPERM' });
  };
  return { rename, holding, release, arm: () => { armed = true; } };
}

/** A store's default writer, which the test seams wrap: it creates a marker file exclusively. */
const defaultWrite = new JournalStore({ file: 'unused.journal.json' }).write;
/** The value a numbered clear marker path of a scratch journal carries, or null when target is not one. */
function markerValue(file, target) {
  const base = `${markerFor(file)}.`, digits = target.startsWith(base) ? target.slice(base.length) : '';
  return /^\d+$/u.test(digits) ? Number(digits) : null;
}
const isMarker = (file, target) => markerValue(file, target) !== null;
/** The numbered clear markers beside a scratch journal, lowest first. */
const numberedMarkers = file => readdirSync(path.dirname(file))
  .map(name => markerValue(file, path.join(path.dirname(file), name))).filter(value => value !== null).sort((a, b) => a - b);
/**
 * The newest clear on record beside a scratch journal: the highest numbered marker or the legacy
 * file's value, 0 when there is none. Synchronous, so a value read as a promise settles is the one on disk then.
 */
function newestMarker(file) {
  let legacy = 0;
  try { legacy = JSON.parse(readFileSync(markerFor(file), 'utf8')).clearedAt; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return Math.max(legacy, ...numberedMarkers(file));
}
/**
 * A marker creation the test holds. Once armed, the next marker write reports holding and waits for
 * release() before it goes through the store's own writer, ownership check included. Every other
 * write goes straight through.
 */
function heldCreate(file) {
  let armed = false, held, release;
  const holding = new Promise(resolve => { held = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const write = async (target, text, options) => {
    if (armed && isMarker(file, target)) { armed = false; held(); await gate; }
    return defaultWrite(target, text, options);
  };
  return { write, holding, release, arm: () => { armed = true; } };
}
/** A writer whose marker creations, once the store's ownership check passed, await passed() and then land. */
const createAfterCheck = (file, passed) => (target, text, options) => defaultWrite(target, text, !isMarker(file, target) ? options : {
  ...options,
  proceed: async () => {
    const proceeding = await options.proceed();
    if (proceeding) await passed();
    return proceeding;
  },
});
test('the journal file sits beside the cache, like the passport and the wishlist', () => {
  assert.equal(journalPath(path.join('C:', 'local', 'wow-context.json')), path.join('C:', 'local', 'wow-context.journal.json'));
  assert.equal(clearMarkerPath(path.join('C:', 'local', 'wow-context.json')), path.join('C:', 'local', 'wow-context.journal.cleared'));
  assert.equal(Object.isFrozen(JOURNAL_KINDS), true);
  assert.equal(JOURNAL_KINDS.length, 13);
});

test('player: a level-up and a zone change, each carrying only its listed fields', () => {
  const value = cache();
  send(value, 'player', 1, player(10));
  assert.deepEqual(step(value, () => send(value, 'player', 2, player(11))),
    [{ at: 5000, domain: 'player', revision: 2, kind: 'level-up', from: 10, to: 11 }]);
  assert.deepEqual(step(value, () => send(value, 'player', 3, player(11, 'The Barrens', 'The Crossroads', 1413)), 6000),
    [{ at: 6000, domain: 'player', revision: 3, kind: 'zone-change', mapId: 1413, zone: 'The Barrens', subzone: 'The Crossroads' }]);
  assert.deepEqual(kinds(step(value, () => send(value, 'player', 4, player(11, 'The Barrens', 'Camp Taurajo', 1413)))), ['zone-change']);
  assert.deepEqual(step(value, () => send(value, 'player', 5, player(11, 'The Barrens', 'Camp Taurajo', 1413))), []);
});

test('a location field that goes unknown and back is no zone change; a known field that changes is one', () => {
  const value = cache();
  send(value, 'player', 1, player(10, 'A', false, 1));
  assert.deepEqual(step(value, () => send(value, 'player', 2, player(10, 'A', 'B', 1))), []);
  assert.deepEqual(step(value, () => send(value, 'player', 3, player(10, 'A', false, 1))), []);
  assert.deepEqual(step(value, () => send(value, 'player', 4, player(10, 'C', false, 1))),
    [{ at: 5000, domain: 'player', revision: 4, kind: 'zone-change', mapId: 1, zone: 'C', subzone: null }]);
});

test('quests: tracked, objective progress, completed and untracked by quest id', () => {
  const value = cache();
  const first = step(value, () => sendQuests(value, 1, [quest(101)]));
  assert.deepEqual(first, [{ at: 5000, domain: 'quests', revision: 1, kind: 'quest-tracked', questId: 101, title: 'Quest 101' }]);
  const second = step(value, () => sendQuests(value, 2, [quest(101, { have: 2 }), quest(102)]));
  assert.deepEqual(second, [
    { at: 5000, domain: 'quests', revision: 2, kind: 'objective-progress', questId: 101, title: 'Quest 101', objective: 'Claws', have: 2, need: 4 },
    { at: 5000, domain: 'quests', revision: 2, kind: 'quest-tracked', questId: 102, title: 'Quest 102' },
  ]);
  assert.deepEqual(kinds(step(value, () => sendQuests(value, 3, [quest(101, { complete: true, have: 4 })]))),
    ['quest-completed', 'objective-progress', 'quest-untracked']);
  assert.deepEqual(step(value, () => sendQuests(value, 4, [quest(101, { complete: true, have: 4 })])), []);
});

test('quests: truncated snapshots record no tracked or untracked events; completion and progress on listed rows still count', () => {
  // Quest ids from..to; the changed snapshot completes 5 and progresses 6.
  const rows = (from, to, changed = false) => Array.from({ length: to - from + 1 }, (_, index) => from + index)
    .map(id => quest(id, changed ? { complete: id === 5, have: id === 6 ? 2 : 1 } : {}));
  const completed = { at: 5000, domain: 'quests', revision: 2, kind: 'quest-completed', questId: 5, title: 'Quest 5' };
  const progressed = { at: 5000, domain: 'quests', revision: 2, kind: 'objective-progress', questId: 6, title: 'Quest 6', objective: 'Claws', have: 2, need: 4 };
  const partial = cache();
  sendQuests(partial, 1, rows(1, 10), { count: 11, truncated: true });
  assert.equal(partial.raw.quests.data.truncated, true);
  assert.deepEqual(step(partial, () => sendQuests(partial, 2, rows(2, 11, true), { count: 11, truncated: true })), [completed, progressed]);
  const whole = cache();
  sendQuests(whole, 1, rows(1, 10));
  assert.equal(whole.raw.quests.data.truncated, false);
  assert.deepEqual(step(whole, () => sendQuests(whole, 2, rows(2, 11, true))), [completed, progressed,
    { at: 5000, domain: 'quests', revision: 2, kind: 'quest-tracked', questId: 11, title: 'Quest 11' },
    { at: 5000, domain: 'quests', revision: 2, kind: 'quest-untracked', questId: 1, title: 'Quest 1' }]);
});

test('progress: money, instance, death and group size', () => {
  const value = cache();
  send(value, 'progress', 1, progress());
  assert.deepEqual(step(value, () => send(value, 'progress', 2, progress({ money: 150, groupSize: 2 }))), [
    { at: 5000, domain: 'progress', revision: 2, kind: 'money-change', delta: 50, money: 150 },
    { at: 5000, domain: 'progress', revision: 2, kind: 'group-size', from: 0, to: 2 },
  ]);
  assert.deepEqual(step(value, () => send(value, 'progress', 3, progress({ money: 120, groupSize: 2, inInstance: true, instanceName: 'Wailing Caverns' }))), [
    { at: 5000, domain: 'progress', revision: 3, kind: 'money-change', delta: -30, money: 120 },
    { at: 5000, domain: 'progress', revision: 3, kind: 'instance-enter', instanceName: 'Wailing Caverns', instanceType: 'party', difficulty: 'Normal' },
  ]);
  assert.deepEqual(kinds(step(value, () => send(value, 'progress', 4, progress({ money: 120, groupSize: 2 })))), ['instance-leave']);
  assert.deepEqual(kinds(step(value, () => send(value, 'progress', 5, progress({ money: 120, groupSize: 2, dead: true })))), ['died']);
  assert.deepEqual(kinds(step(value, () => send(value, 'progress', 6, progress({ money: 120, groupSize: 2, ghost: true })))), ['ghost', 'revived']);
  assert.deepEqual(step(value, () => send(value, 'progress', 7, progress({ money: 120, groupSize: 2, ghost: true }))), []);
});

test('unavailable, disabled and errors records produce nothing; a quest batch replacing no record reports its quests', () => {
  const value = cache();
  send(value, 'player', 1, player(10));
  send(value, 'progress', 1, progress());
  assert.deepEqual(step(value, () => send(value, 'player', 2, [false, false, false, false, false, false, ['player:restricted']])), []);
  assert.deepEqual(step(value, () => send(value, 'player', 3, player(12, 'Durotar'))), [], 'an unavailable side is never compared');
  assert.deepEqual(step(value, () => send(value, 'errors', 1, [true, '', 1, false, [['error', 'boom', [], 1, 0, 0, 0]]])), []);
  sendQuests(value, 1, [quest(101)]);
  assert.deepEqual(step(value, () => send(value, 'state', 1, [false])), [], 'disabling sharing is not every domain ending');
  send(value, 'state', 2, [true]);
  assert.deepEqual(step(value, () => send(value, 'player', 4, player(13, 'Orgrimmar'))), []);
  assert.deepEqual(step(value, () => send(value, 'progress', 2, progress({ money: 999, dead: true }))), []);
  assert.deepEqual(kinds(step(value, () => sendQuests(value, 2, [quest(101)]))), ['quest-tracked']);
  assert.deepEqual(kinds(observe(null, value.raw, 1)), ['quest-tracked']);
  const unavailableQuests = cache();
  send(unavailableQuests, 'quests', 1, [false, 'quests:restricted', 0, false, []]);
  assert.deepEqual(step(unavailableQuests, () => sendQuests(unavailableQuests, 2, [quest(101)])), [], 'an unavailable batch is a record, not null');
});

test('a segment keeps the newest 500 events', async t => {
  const store = new JournalStore({ file: await scratch(t), now: () => 1000 });
  assert.equal(await store.append(Array.from({ length: 300 }, (_, index) => money(index + 1)), { epoch: '0123abcd' }), true);
  await store.append(Array.from({ length: 300 }, (_, index) => money(index + 301)), { epoch: '0123abcd' });
  const { segments } = await store.read();
  assert.equal(segments.length, 1);
  assert.equal(segments[0].events.length, JournalStore.caps.events);
  assert.equal(segments[0].events[0].at, 101);
  assert.equal(segments[0].events.at(-1).at, 600);
});

test('a new epoch closes the open segment; 24 hours closes it within the same epoch', async t => {
  let now = 1000;
  const store = new JournalStore({ file: await scratch(t), now: () => now });
  await store.append([money(1)], { epoch: '0123abcd', character: null });
  now = 2000;
  await store.append([money(2)], { epoch: '0123abcd', character: { name: 'Thrall', class: 'Shaman' } });
  now = 3000;
  await store.append([money(3)], { epoch: '89abcdef', character: { name: 'Jaina', class: 'Mage' } });
  let { segments } = await store.read();
  assert.deepEqual(segments.map(({ epoch, startedAt, endedAt, character, events }) => [epoch, startedAt, endedAt, character?.name, events.length]),
    [['0123abcd', 1000, 3000, 'Thrall', 2], ['89abcdef', 3000, null, 'Jaina', 1]]);
  now = 3000 + JournalStore.caps.segmentMs;
  await store.append([money(4)], { epoch: '89abcdef' });
  assert.equal((await store.read()).segments.length, 2, 'exactly 24 hours is not older than 24 hours');
  now += 1;
  await store.append([money(5)], { epoch: '89abcdef' });
  ({ segments } = await store.read());
  assert.deepEqual(segments.map(({ epoch, endedAt, events }) => [epoch, endedAt, events.length]),
    [['0123abcd', 3000, 2], ['89abcdef', now, 2], ['89abcdef', null, 1]]);
});

test('a new UI session in the same epoch closes the open segment', async t => {
  let now = 1000;
  const store = new JournalStore({ file: await scratch(t), now: () => now });
  await store.append([money(1)], { epoch: '0123abcd', uiNonce: 'abcd0123', character: { name: 'Thrall', class: 'Shaman' } });
  now = 2000;
  await store.append([money(2)], { epoch: '0123abcd', uiNonce: 'abcd0123' });
  now = 3000;
  await store.append([money(3)], { epoch: '0123abcd', uiNonce: '89abcdef', character: { name: 'Jaina', class: 'Mage' } });
  const document = await store.read();
  assert.deepEqual(document.segments.map(({ epoch, uiNonce, endedAt, character, events }) => [epoch, uiNonce, endedAt, character?.name, events.length]),
    [['0123abcd', 'abcd0123', 3000, 'Thrall', 2], ['0123abcd', '89abcdef', null, 'Jaina', 1]]);
  assert.deepEqual(presentJournal(document, { includeHistory: true }, 4000).segments.map(segment => segment.uiNonce), ['abcd0123', '89abcdef']);
});

test('at most 8 segments are kept, the oldest dropped first, and the file stays under 256 KiB', async t => {
  let now = 0;
  const file = await scratch(t), store = new JournalStore({ file, now: () => now });
  for (let index = 0; index < 10; index++) {
    now = (index + 1) * 1000;
    await store.append([money(now)], { epoch: `0000000${index}` });
  }
  assert.deepEqual((await store.read()).segments.map(segment => segment.epoch), ['00000002', '00000003', '00000004', '00000005', '00000006', '00000007', '00000008', '00000009']);
  const wide = at => ({ at, domain: 'quests', revision: 1, kind: 'objective-progress', questId: 101, title: 'T'.repeat(64), objective: 'O'.repeat(64), have: 1, need: 4 });
  for (const epoch of ['aaaaaaaa', 'bbbbbbbb', 'cccccccc']) {
    now += 1000;
    await store.append(Array.from({ length: 500 }, (_, index) => wide(now + index)), { epoch });
  }
  assert.ok((await fs.stat(file)).size <= JournalStore.caps.bytes);
  const { segments } = await store.read();
  assert.deepEqual(segments.map(segment => segment.epoch), ['bbbbbbbb', 'cccccccc']);
  assert.equal(segments.at(-1).events.length, 500);
});

test('clear deletes the file at once and a later append starts afresh', async t => {
  const file = await scratch(t), store = new JournalStore({ file, now: () => 1000 });
  assert.equal(await store.read(), null);
  await store.append([money(1)], { epoch: '0123abcd' });
  assert.equal(await store.clear(), true);
  assert.equal(await fs.access(file).then(() => true, () => false), false);
  assert.equal(await store.read(), null);
  assert.equal(await store.clear(), false, 'no journal to delete; the marker alone is not one');
  await store.append([money(2)], { epoch: '0123abcd' });
  assert.deepEqual((await store.read()).segments[0].events.map(event => event.at), [2]);
});

test('a clear that lands while an append is building discards the pre-clear batch so cleared events never return', async t => {
  const file = await scratch(t), other = new JournalStore({ file, now: () => 1000 });
  let loads = 0;
  const store = new JournalStore({ file, now: () => 2000, onLoaded: async () => {
    if (loads++ === 0) assert.equal(await other.clear(), true);
  } });
  await other.append([money(1)], { epoch: '0123abcd' });
  assert.equal(await store.append([money(2)], { epoch: '0123abcd' }), false, 'the pre-clear batch is discarded after clear');
  assert.equal(loads, 1);
  assert.equal(await store.read(), null);
  assert.equal(await store.append([money(3)], { epoch: '0123abcd' }), true, 'a post-clear append starts clean');
  assert.deepEqual((await store.read()).segments.map(segment => segment.events.map(event => event.at)), [[3]]);
});

test('a clear that lands while a delayed writer renames its file discards the older batch instead of bringing pre-clear events back', async t => {
  const file = await scratch(t), other = new JournalStore({ file, now: () => 1000 });
  let held, release, writes = 0;
  const holding = new Promise(resolve => { held = resolve; }), gate = new Promise(resolve => { release = resolve; });
  // Held on the journal write itself, after its stamp check: the order Codex reproduced.
  const store = new JournalStore({ file, now: () => 2000, write: async (target, contents) => {
    if (target === file && ++writes === 1) { held(); await gate; }
    await atomicWrite(target, contents);
  } });
  await other.append([money(1)], { epoch: '0123abcd' });
  const appending = store.append([money(2)], { epoch: '0123abcd' });
  await holding;
  assert.equal(await other.clear(), true);
  assert.equal(await other.read(), null);
  release();
  assert.equal(await appending, false, 'the delayed pre-clear batch is discarded when it resumes');
  assert.equal(writes, 1);
  assert.deepEqual((await store.read())?.segments ?? [], [], 'no pre-clear events reappear');
  assert.equal(await store.append([money(3)], { epoch: '0123abcd' }), true);
  const events = ((await store.read())?.segments ?? []).flatMap(segment => segment.events.map(event => event.at));
  assert.deepEqual(events, [3]);
});

test('an append made while a local clear is still running follows that clear\'s marker and persists', async t => {
  const file = await scratch(t), reported = [];
  let held, release;
  const holding = new Promise(resolve => { held = resolve; }), gate = new Promise(resolve => { release = resolve; });
  // The clear is held on its marker write, so the append below is made before the marker exists.
  const store = new JournalStore({ file, now: () => 1000, onError: error => reported.push(error.message),
    write: async (target, text, options) => {
      if (isMarker(file, target)) { held(); await gate; }
      return defaultWrite(target, text, options);
    } });
  assert.equal(await store.append([money(1)], { epoch: '0123abcd' }), true);
  const before = store.append([money(2)], { epoch: '0123abcd' });
  const clearing = store.clear();
  await holding;
  const after = store.append([money(3)], { epoch: '0123abcd' });
  // Long enough for a fence read made at once to finish before the clear writes its marker.
  await new Promise(resolve => setTimeout(resolve, 50));
  release();
  assert.equal(await before, false, 'a batch queued before the clear is dropped');
  assert.equal(await clearing, true);
  assert.equal(await after, true, 'the batch made during the clear is written');
  assert.deepEqual((await store.read()).segments.flatMap(segment => segment.events.map(event => event.at)), [3]);
  assert.deepEqual(reported, []);
});

test('an append queued behind a local clear whose lock another process reclaimed and cleared under is dropped', async t => {
  const file = await scratch(t), lock = `${markerFor(file)}.lock`, reported = [];
  let held, release;
  const holding = new Promise(resolve => { held = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const store = new JournalStore({ file, now: () => 1000, onError: error => reported.push(error.message),
    write: async (target, text, options) => {
      if (isMarker(file, target)) { held(); await gate; }
      return defaultWrite(target, text, options);
    } });
  const other = new JournalStore({ file, now: () => 6000 });
  assert.equal(await store.append([money(1)], { epoch: '0123abcd' }), true);
  const clearing = store.clear();
  await holding;
  const appending = store.append([money(2)], { epoch: '0123abcd' });
  // Long enough for the call-time fence read to finish before the other process clears.
  await new Promise(resolve => setTimeout(resolve, 50));
  // The held clear's lock has outlived its lease: the other store reclaims it and clears.
  const past = new Date(Date.now() - 60_000);
  await fs.utimes(lock, past, past);
  assert.equal(await other.clear(), true);
  release();
  assert.equal(await clearing, false, 'the local clear lost its lock');
  assert.equal(await appending, false, 'a batch recorded before the foreign clear is dropped');
  assert.deepEqual((await store.read())?.segments ?? [], [], 'the journal holds no event');
  assert.equal(newestMarker(file), 6000);
  assert.deepEqual(reported, ['Session journal clear lock lost']);
});

test('a local clear whose marker creation lands after another process reclaimed its lock and cleared lands below it and records no link, so an append queued behind it is dropped', async t => {
  const file = await scratch(t), lock = `${markerFor(file)}.lock`, reported = [];
  let held, release;
  const holding = new Promise(resolve => { held = resolve; }), gate = new Promise(resolve => { release = resolve; });
  // The marker creation is held after the write's ownership check passed, then lands as it was asked to.
  const store = new JournalStore({ file, now: () => 1000, onError: error => reported.push(error.message),
    write: createAfterCheck(file, async () => { held(); await gate; }) });
  const other = new JournalStore({ file, now: () => 5000 });
  assert.equal(await store.append([money(1)], { epoch: '0123abcd' }), true);
  const clearing = store.clear();
  await holding;
  const appending = store.append([money(2)], { epoch: '0123abcd' });
  // Long enough for the call-time fence read (marker 0) to finish before the other process clears.
  await new Promise(resolve => setTimeout(resolve, 50));
  const past = new Date(Date.now() - 60_000);
  await fs.utimes(lock, past, past);
  assert.equal(await other.clear(), true);
  release();
  assert.equal(await clearing, false, 'the local clear lost its lock');
  assert.deepEqual(numberedMarkers(file), [1000, 5000], 'the held creation landed as a superseded lower marker');
  assert.equal(newestMarker(file), 5000, 'the newest marker is the other process\'s');
  assert.deepEqual(store.ownClears, [], 'no link was recorded');
  assert.equal(await appending, false, 'a batch recorded before the foreign clear is dropped');
  assert.deepEqual((await store.read())?.segments ?? [], [], 'the journal holds no event of that batch');
  assert.deepEqual(reported, ['Session journal clear lock lost']);
});

test('a foreign marker lower than the newest, landing between an append\'s proceed check and its rename, changes nothing a read or the append sees', async t => {
  const file = await scratch(t), lock = `${markerFor(file)}.lock`, reported = [], foreignReported = [];
  let foreignHeld, foreignRelease, renameHeld, renameRelease, armed = false;
  const foreignHolding = new Promise(resolve => { foreignHeld = resolve; }), foreignGate = new Promise(resolve => { foreignRelease = resolve; });
  const renameHolding = new Promise(resolve => { renameHeld = resolve; }), renameGate = new Promise(resolve => { renameRelease = resolve; });
  // The foreign marker creation (1000) is held after its ownership check passed, then lands as it was asked to.
  const other = new JournalStore({ file, now: () => 1000, onError: error => foreignReported.push(error.message),
    write: createAfterCheck(file, async () => { foreignHeld(); await foreignGate; }) });
  // Once armed, the local journal rename is held after the append's proceed check passed, then lands.
  const rename = async (from, to) => {
    if (armed && to === file) { armed = false; renameHeld(); await renameGate; }
    return fs.rename(from, to);
  };
  const store = new JournalStore({ file, now: () => 6000, onError: error => reported.push(error.message),
    write: (target, text, options) => defaultWrite(target, text, { ...options, rename }) });
  assert.equal(await store.append([money(1)], { epoch: '0123abcd' }), true);
  const foreignClearing = other.clear();
  await foreignHolding;
  // The foreign clear's lock has outlived its lease: the local clear reclaims it and clears.
  const past = new Date(Date.now() - 60_000);
  await fs.utimes(lock, past, past);
  assert.equal(await store.clear(), true, 'the local clear kept its lock and deleted the journal');
  armed = true;
  const appending = store.append([money(2)], { epoch: '0123abcd' });
  await renameHolding;
  const seen = await store.read();
  foreignRelease();
  assert.equal(await foreignClearing, false, 'the foreign clear lost its lock');
  assert.deepEqual(numberedMarkers(file), [1000, 6000], 'the held foreign marker landed below the local one');
  assert.equal(newestMarker(file), 6000);
  assert.deepEqual(await store.read(), seen, 'a read sees what it saw before the foreign marker landed');
  renameRelease();
  assert.equal(await appending, true, 'a marker lower than the newest is a superseded clear, so the batch is kept');
  const document = await store.read();
  assert.equal(document.clearedAt, 6000);
  assert.deepEqual(document.segments.flatMap(segment => segment.events.map(event => event.at)), [2], 'the batch is readable');
  assert.deepEqual(reported, []);
  assert.deepEqual(foreignReported, ['Session journal clear lock lost']);
});

test('a foreign marker created while a local clear holds its own creation is not skipped by an append queued behind that clear', async t => {
  const file = await scratch(t), reported = [];
  let held, release;
  const holding = new Promise(resolve => { held = resolve; }), gate = new Promise(resolve => { release = resolve; });
  // The local clear has read marker 0 and is held at its marker creation.
  const store = new JournalStore({ file, now: () => 6000, onError: error => reported.push(error.message),
    write: async (target, text, options) => {
      if (isMarker(file, target)) { held(); await gate; }
      return defaultWrite(target, text, options);
    } });
  assert.equal(await store.append([money(1)], { epoch: '0123abcd' }), true);
  const clearing = store.clear();
  await holding;
  const appending = store.append([money(2)], { epoch: '0123abcd' });
  // Long enough for the call-time fence read (marker 0) to finish before the foreign marker lands.
  await new Promise(resolve => setTimeout(resolve, 50));
  // A stalled clear from another process lands its marker now.
  await fs.writeFile(`${markerFor(file)}.1000`, '', { flag: 'wx' });
  release();
  assert.equal(await clearing, true);
  assert.deepEqual(store.ownClears, [{ previous: 1000, value: 6000 }], 'the link starts at the foreign marker, not at the read before the write');
  assert.equal(await appending, false, 'another process cleared between the fence read and the local marker, so the batch is dropped');
  assert.deepEqual((await store.read())?.segments ?? [], [], 'the batch is not readable');
  assert.equal(newestMarker(file), 6000);
  assert.deepEqual(reported, []);
});

test('a foreign marker lower than a local clear\'s, created after that clear listed the markers, leaves an append queued behind the clear kept', async t => {
  const file = await scratch(t), reported = [];
  let held, release, late = false;
  const holding = new Promise(resolve => { held = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const store = new JournalStore({ file, now: () => 6000, onError: error => reported.push(error.message),
    write: async (target, text, options) => {
      if (isMarker(file, target)) { held(); await gate; }
      return defaultWrite(target, text, options);
    },
    // The queued append loads the file only after the clear finished, listing and pruning included.
    onLoaded: async () => {
      if (late) { late = false; await fs.writeFile(`${markerFor(file)}.1000`, '', { flag: 'wx' }); }
    } });
  assert.equal(await store.append([money(1)], { epoch: '0123abcd' }), true);
  const clearing = store.clear();
  await holding;
  const appending = store.append([money(2)], { epoch: '0123abcd' });
  await new Promise(resolve => setTimeout(resolve, 50));
  late = true;
  release();
  assert.equal(await clearing, true);
  assert.equal(await appending, true, 'a lower marker landing late is a superseded clear, so the batch is kept');
  assert.equal(late, false, 'the late marker was created');
  assert.deepEqual(numberedMarkers(file), [1000, 6000]);
  assert.deepEqual((await store.read()).segments.flatMap(segment => segment.events.map(event => event.at)), [2]);
  assert.deepEqual(reported, []);
});

test('an append made after two queued local clears follows both markers and persists', async t => {
  const file = await scratch(t), reported = [];
  let held, release, markerWrites = 0;
  const holding = new Promise(resolve => { held = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const store = new JournalStore({ file, now: () => 1000, onError: error => reported.push(error.message),
    write: async (target, text, options) => {
      if (isMarker(file, target) && ++markerWrites === 1) { held(); await gate; }
      return defaultWrite(target, text, options);
    } });
  assert.equal(await store.append([money(1)], { epoch: '0123abcd' }), true);
  const first = store.clear(), second = store.clear();
  await holding;
  const appending = store.append([money(3)], { epoch: '0123abcd' });
  await new Promise(resolve => setTimeout(resolve, 50));
  release();
  assert.equal(await first, true);
  assert.equal(await second, false, 'the second clear found no journal to delete');
  assert.equal(await appending, true, 'only this store moved the marker, so the batch is written');
  assert.equal(newestMarker(file), 1001);
  assert.deepEqual((await store.read()).segments.flatMap(segment => segment.events.map(event => event.at)), [3]);
  assert.deepEqual(reported, []);
});

test('a foreign clear landing before a queued local clear reads its marker drops an append made in between', async t => {
  const file = await scratch(t), reported = [];
  let held, release, loads = 0;
  const holding = new Promise(resolve => { held = resolve; }), gate = new Promise(resolve => { release = resolve; });
  // The first append is held right after it loads the file, so the clear queued behind it has not read the marker yet.
  const store = new JournalStore({ file, now: () => 1000, onError: error => reported.push(error.message), onLoaded: async () => {
    if (loads++ === 0) { held(); await gate; }
  } });
  const other = new JournalStore({ file, now: () => 5000 });
  const first = store.append([money(1)], { epoch: '0123abcd' });
  await holding;
  const clearing = store.clear();
  const appending = store.append([money(3)], { epoch: '0123abcd' });
  // Long enough for the call-time fence read to finish before the other process clears.
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(await other.clear(), false, 'there was no journal file yet');
  release();
  assert.equal(await first, false, 'the held batch meets the foreign marker');
  assert.equal(await clearing, false);
  assert.equal(newestMarker(file), 5001, 'the local clear wrote on top of the foreign one');
  assert.equal(await appending, false, 'a batch recorded before the foreign clear is dropped');
  assert.deepEqual((await store.read())?.segments ?? [], [], 'the journal holds no event');
  assert.deepEqual(reported, []);
});

test('a clear delayed past its lock lease neither replaces the marker nor deletes a newer writer\'s journal', async t => {
  const file = await scratch(t), lock = `${markerFor(file)}.lock`, reported = [];
  let held, release;
  const holding = new Promise(resolve => { held = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const slowClear = new JournalStore({ file, now: () => 1000, onError: error => reported.push(error.message),
    write: async (target, text, options) => {
      if (isMarker(file, target)) {
        held();
        await gate;
      }
      return defaultWrite(target, text, options);
    } });
  const writer = new JournalStore({ file, now: () => 6000 });
  await writer.append([money(1)], { epoch: '0123abcd' });
  const clearing = slowClear.clear();
  await holding;
  // Simulate the 5.2s delay where the lock became stale and another clear/writer moved on.
  await fs.rm(lock, { force: true });
  await fs.writeFile(markerFor(file), JSON.stringify({ clearedAt: 5000 }));
  await writer.append([money(9)], { epoch: '89abcdef' });
  release();
  assert.equal(await clearing, false, 'the delayed clear lost lock ownership');
  assert.deepEqual(reported, ['Session journal clear lock lost']);
  assert.equal(newestMarker(file), 5000, 'newer marker stands');
  assert.deepEqual((await writer.read()).segments.flatMap(segment => segment.events.map(event => event.at)), [9], 'newer writer\'s journal stands');
});

test('a marker newer than the document reads as empty, the next append starts afresh from it, and an unreadable marker fails closed', async t => {
  const file = await scratch(t), reported = [];
  const store = new JournalStore({ file, now: () => 1000, onError: error => reported.push(error.message) });
  await store.append([money(1)], { epoch: '0123abcd' });
  await fs.writeFile(markerFor(file), JSON.stringify({ clearedAt: 5000 }));
  assert.deepEqual(await store.read(), { schemaVersion: 1, clearedAt: 5000, segments: [] });
  assert.ok(await fs.stat(file), 'the stale file still sits there, fenced off');
  await store.append([money(2)], { epoch: '0123abcd' });
  const document = await store.read();
  assert.equal(document.clearedAt, 5000);
  assert.deepEqual(document.segments.map(segment => segment.events.map(event => event.at)), [[2]]);
  await fs.writeFile(markerFor(file), 'not json');
  assert.deepEqual(await store.read(), { schemaVersion: 1, clearedAt: 0, segments: [] }, 'an unreadable marker shows no history');
  assert.equal(await store.append([money(3)], { epoch: '0123abcd' }), false, 'an append is refused, not fenced by nothing');
  await store.read();
  assert.equal(reported.length, 1);
  assert.match(reported[0], /clear marker unreadable/u);
});

test('an unreadable marker beside a journal reads empty and refuses an append, reported once', async t => {
  const file = await scratch(t), reported = [];
  const store = new JournalStore({ file, now: () => 1000, onError: error => reported.push(error.message) });
  await store.append([money(1)], { epoch: '0123abcd' });
  const before = await fs.readFile(file, 'utf8');
  await fs.writeFile(markerFor(file), 'not json');
  assert.deepEqual(await store.read(), { schemaVersion: 1, clearedAt: 0, segments: [] });
  assert.equal(await store.append([money(2)], { epoch: '0123abcd' }), false);
  assert.equal(await fs.readFile(file, 'utf8'), before, 'the journal file is unchanged');
  assert.equal(reported.length, 1);
  assert.match(reported[0], /clear marker unreadable/u);
});

test('the legacy marker file still counts: a higher numbered marker wins over it, a lower one does not, and an unreadable one fails closed', async t => {
  const file = await scratch(t), reported = [];
  const store = new JournalStore({ file, now: () => 1000, onError: error => reported.push(error.message) });
  assert.equal(await store.append([money(1)], { epoch: '0123abcd' }), true);
  await fs.writeFile(markerFor(file), JSON.stringify({ clearedAt: 5000 }));
  await fs.writeFile(`${markerFor(file)}.3000`, '');
  assert.deepEqual(await store.read(), { schemaVersion: 1, clearedAt: 5000, segments: [] }, 'the legacy value is above the numbered one');
  await fs.writeFile(`${markerFor(file)}.7000`, '');
  assert.deepEqual(await store.read(), { schemaVersion: 1, clearedAt: 7000, segments: [] }, 'a higher numbered marker wins');
  assert.equal(await store.append([money(2)], { epoch: '0123abcd' }), true);
  assert.equal((await store.read()).clearedAt, 7000);
  const before = await fs.readFile(file, 'utf8');
  await fs.writeFile(markerFor(file), 'not json');
  assert.deepEqual(await store.read(), { schemaVersion: 1, clearedAt: 0, segments: [] }, 'an unreadable legacy file shows no history beside a numbered marker');
  assert.equal(await store.append([money(3)], { epoch: '0123abcd' }), false, 'an append is refused');
  assert.equal(await store.clear(), false, 'a clear is refused');
  assert.equal(await fs.readFile(file, 'utf8'), before, 'the journal file is unchanged');
  assert.deepEqual(numberedMarkers(file), [3000, 7000], 'no marker was written');
  assert.equal(reported.length, 1);
  assert.match(reported[0], /clear marker unreadable/u);
  await fs.writeFile(markerFor(file), JSON.stringify({ clearedAt: 5000 }));
  assert.equal(await store.clear(), true);
  assert.deepEqual(store.ownClears, [{ previous: 7000, value: 7001 }]);
  assert.deepEqual(JSON.parse(await fs.readFile(markerFor(file), 'utf8')), { clearedAt: 5000 }, 'the legacy file is never written');
  assert.equal(newestMarker(file), 7001);
});

test('a clear whose marker value another process created first retries from a fresh read, and three such losses fail it as a lost lock', async t => {
  const file = await scratch(t), reported = [], attempted = [];
  let collisions = 1;
  // Another process creates the very value this clear is about to create, just before it does.
  const store = new JournalStore({ file, now: () => 1000, onError: error => reported.push(error.message),
    write: async (target, text, options) => {
      if (isMarker(file, target)) {
        attempted.push(markerValue(file, target));
        if (collisions-- > 0) await fs.writeFile(target, '', { flag: 'wx' });
      }
      return defaultWrite(target, text, options);
    } });
  assert.equal(await store.append([money(1)], { epoch: '0123abcd' }), true);
  assert.equal(await store.clear(), true, 'the retry succeeded and deleted the journal');
  assert.deepEqual(attempted, [1000, 1001]);
  assert.equal(newestMarker(file), 1001);
  assert.deepEqual(store.ownClears, [{ previous: 1000, value: 1001 }]);
  assert.deepEqual(reported, []);
  assert.equal(await store.append([money(2)], { epoch: '0123abcd' }), true);
  collisions = 3;
  attempted.length = 0;
  assert.equal(await store.clear(), false);
  assert.deepEqual(attempted, [1002, 1003, 1004]);
  assert.deepEqual(reported, ['Session journal clear lock lost']);
  assert.equal(newestMarker(file), 1004, 'the other process\'s markers stand');
  assert.equal(await fs.access(file).then(() => true, () => false), true, 'the journal stands');
});

test('a clear never removes a marker: lower numbered ones, the legacy file and other names all stay', async t => {
  const file = await scratch(t), store = new JournalStore({ file, now: () => 1000 });
  for (const value of [100, 200]) await fs.writeFile(`${markerFor(file)}.${value}`, '');
  await fs.writeFile(markerFor(file), JSON.stringify({ clearedAt: 300 }));
  // Not a marker name: ignored by the read (it would be the highest) and left in place.
  await fs.writeFile(`${markerFor(file)}.99999x`, '');
  assert.equal(await store.clear(), false, 'no journal to delete');
  assert.equal(await store.clear(), false);
  assert.deepEqual(store.ownClears, [{ previous: 300, value: 1000 }, { previous: 1000, value: 1001 }]);
  // A removal could hide the newest clear from a listing in progress, so every marker stays.
  assert.deepEqual(numberedMarkers(file), [100, 200, 1000, 1001]);
  assert.deepEqual(JSON.parse(await fs.readFile(markerFor(file), 'utf8')), { clearedAt: 300 });
  assert.equal(await fs.access(`${markerFor(file)}.99999x`).then(() => true, () => false), true);
});

test('a clear that finds a higher marker created since its read creates again above it, and three such losses fail it as a lost lock', async t => {
  const file = await scratch(t), reported = [], attempted = [];
  let ahead = 1, held, release;
  const holding = new Promise(resolve => { held = resolve; }), gate = new Promise(resolve => { release = resolve; });
  // This store's clock (5000) is behind another process's: that process's stalled clear lands a
  // higher marker right after this clear created its own.
  const store = new JournalStore({ file, now: () => 5000, onError: error => reported.push(error.message),
    write: async (target, text, options) => {
      // The first creation waits until the append queued behind the clear has read its fence (marker 0).
      if (isMarker(file, target)) { held(); await gate; }
      const written = await defaultWrite(target, text, options);
      if (isMarker(file, target)) {
        attempted.push(markerValue(file, target));
        if (ahead-- > 0) await fs.writeFile(`${markerFor(file)}.${markerValue(file, target) + 5000}`, '', { flag: 'wx' });
      }
      return written;
    } });
  assert.equal(await store.append([money(1)], { epoch: '0123abcd' }), true);
  const clearing = store.clear();
  await holding;
  const appending = store.append([money(2)], { epoch: '0123abcd' });
  await new Promise(resolve => setTimeout(resolve, 50));
  release();
  assert.equal(await clearing, true, 'the second creation is the newest and the journal was deleted');
  assert.deepEqual(attempted, [5000, 10001]);
  assert.equal(newestMarker(file), 10001);
  assert.deepEqual(store.ownClears, [{ previous: 10000, value: 10001 }], 'no link was recorded for the superseded marker');
  assert.equal(await appending, false, 'another process cleared in between, so the batch queued behind the clear is dropped');
  assert.deepEqual(reported, []);
  assert.equal(await store.append([money(3)], { epoch: '0123abcd' }), true);
  ahead = 3;
  attempted.length = 0;
  assert.equal(await store.clear(), false);
  assert.equal(attempted.length, 3);
  assert.deepEqual(reported, ['Session journal clear lock lost']);
  assert.equal(newestMarker(file), attempted[2] + 5000, 'the other process\'s marker stands');
  assert.equal(await fs.access(file).then(() => true, () => false), true, 'the journal stands');
});

test('a clear that cannot list the markers after creating its own keeps the journal and reports no success', async t => {
  const file = await scratch(t), reported = [];
  // The legacy marker turns unreadable right after this clear created its marker, so the listing that
  // would show whether a higher marker superseded it fails.
  const store = new JournalStore({ file, now: () => 5000, onError: error => reported.push(error.message),
    write: async (target, text, options) => {
      const written = await defaultWrite(target, text, options);
      if (isMarker(file, target)) {
        await fs.writeFile(`${markerFor(file)}.10000`, '', { flag: 'wx' });
        await fs.writeFile(markerFor(file), 'not json');
      }
      return written;
    } });
  assert.equal(await store.append([money(1)], { epoch: '0123abcd' }), true);
  assert.equal(await store.clear(), false);
  assert.deepEqual(store.ownClears, []);
  assert.equal(await fs.access(file).then(() => true, () => false), true, 'the journal stands');
  assert.equal(reported.length, 1);
  assert.match(reported[0], /clear marker unreadable/u);
});

test('a clear started while another holds its marker creation waits on the lock, then moves the marker on from it', async t => {
  const file = await scratch(t), hold = heldCreate(file);
  t.after(() => hold.release());
  const s = new JournalStore({ file, now: () => 1000, write: hold.write });
  const f = new JournalStore({ file, now: () => 5000 });
  await f.append([money(1)], { epoch: '0123abcd' });
  hold.arm();
  const clearing = s.clear();
  await hold.holding;
  const overtaking = f.clear();
  // Several of the lock's 50 ms waits, well inside its 3 s bound: f stays outside while s holds it.
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(newestMarker(file), 0, 'no marker yet: f waits on the lock');
  hold.release();
  assert.equal(await clearing, true, 's went first and deleted the journal');
  assert.equal(await overtaking, false, 'f ran after s: the journal was already gone');
  assert.equal(newestMarker(file), 5000, 'f moved the marker on from 1000');
  assert.equal(await fs.access(file).then(() => true, () => false), false);
  assert.equal(await fs.access(`${markerFor(file)}.lock`).then(() => true, () => false), false, 'the lock was released');
});

test('a clear with no journal file still writes the marker, and each clear moves it forward', async t => {
  const file = await scratch(t), store = new JournalStore({ file, now: () => 1000 });
  assert.equal(await store.clear(), false, 'neither a journal nor a marker existed');
  assert.equal(newestMarker(file), 1000);
  assert.equal(await store.clear(), false, 'no journal file; the marker alone is not one');
  assert.equal(newestMarker(file), 1001, 'a clock that has not moved still moves the marker');
  assert.equal(await fs.access(file).then(() => true, () => false), false);
});

test('two stores clearing in a tight loop take turns on the lock, and the marker never moves back', async t => {
  const file = await scratch(t), marker = markerFor(file), reported = [];
  const onError = error => reported.push(error.message);
  const a = new JournalStore({ file, now: () => 1000, onError }), b = new JournalStore({ file, now: () => 5000, onError });
  const observed = [];
  // Read synchronously as each clear resolves, so the values are in the order the file held them.
  await Promise.all(Array.from({ length: 40 }, (_, index) => (index % 2 ? b : a).clear()
    .then(() => { observed.push(newestMarker(file)); })));
  assert.equal(observed.length, 40);
  assert.ok(observed.every((value, index) => index === 0 || value >= observed[index - 1]), `non-decreasing: ${observed.join(' ')}`);
  assert.ok(newestMarker(file) >= 5000);
  assert.equal(await fs.access(`${marker}.lock`).then(() => true, () => false), false, 'the lock was released');
  assert.deepEqual(reported, []);
});

test('a stale clear lock left by a clear that died does not stop a clear', async t => {
  const file = await scratch(t), lock = `${markerFor(file)}.lock`, store = new JournalStore({ file, now: () => 1000 });
  await store.append([money(1)], { epoch: '0123abcd' });
  await fs.writeFile(lock, JSON.stringify({ pid: 0, at: 0 }), { flag: 'wx' });
  const past = new Date(Date.now() - 10_000);
  await fs.utimes(lock, past, past);
  const started = Date.now();
  assert.equal(await store.clear(), true);
  assert.ok(Date.now() - started < 1000, 'the stale lock was removed and retried at once');
  assert.equal(newestMarker(file), 1000);
  assert.equal(await fs.access(lock).then(() => true, () => false), false);
});

test('a clear lock held past its bound fails the clear, reported once, and the lock is left to its holder', async t => {
  const file = await scratch(t), lock = `${markerFor(file)}.lock`, reported = [];
  const store = new JournalStore({ file, onError: error => reported.push(error.message), lockTries: 3, lockWaitMs: 10 });
  await store.append([money(1)], { epoch: '0123abcd' });
  await fs.writeFile(lock, JSON.stringify({ pid: 0, at: 0 }), { flag: 'wx' });
  assert.equal(await store.clear(), false);
  assert.deepEqual(reported, ['Session journal clear lock busy']);
  assert.equal(newestMarker(file), 0, 'no marker was written');
  assert.equal(await fs.access(file).then(() => true, () => false), true, 'the journal stands');
  assert.equal(await fs.access(lock).then(() => true, () => false), true, 'a lock it never took is not removed');
});

test('an append whose file changes under every attempt drops its batch and reports it once', async t => {
  const file = await scratch(t), other = new JournalStore({ file, now: () => 1000 }), reported = [];
  let loads = 0;
  const store = new JournalStore({ file, now: () => 2000, onError: error => reported.push(error.message),
    onLoaded: () => other.append([money(100 + ++loads)], { epoch: '0123abcd' }) });
  assert.equal(await store.append([money(1)], { epoch: '0123abcd' }), false);
  assert.equal(loads, 4, 'one read and three retries');
  assert.equal(reported.length, 1);
  assert.match(reported[0], /dropped/u);
  assert.deepEqual((await store.read()).segments[0].events.map(event => event.at), [101, 102, 103, 104]);
});

test('a corrupt, oversized or unlisted-field file reads empty and is reported once; a failed write is reported, not thrown', async t => {
  const file = await scratch(t), reported = [];
  const store = new JournalStore({ file, now: () => 1000, onError: error => reported.push(error.message) });
  await fs.writeFile(file, 'not json');
  assert.deepEqual(await store.read(), { schemaVersion: 1, clearedAt: 0, segments: [] });
  await fs.writeFile(file, 'x'.repeat(JournalStore.caps.bytes + 1));
  assert.deepEqual(await store.read(), { schemaVersion: 1, clearedAt: 0, segments: [] });
  await fs.writeFile(file, JSON.stringify({ schemaVersion: 1, segments: [{ epoch: null, startedAt: 1, endedAt: null, character: null,
    events: [{ ...money(1), message: 'terminal text' }] }] }));
  assert.deepEqual(await store.read(), { schemaVersion: 1, clearedAt: 0, segments: [] });
  assert.equal(reported.length, 1);
  assert.match(reported[0], /unreadable/u);
  await store.append([money(2)], { epoch: '0123abcd' });
  assert.equal((await store.read()).segments[0].events.length, 1, 'an append replaces an unreadable file');
  const failing = new JournalStore({ file: path.join(path.dirname(file), 'missing', 'journal.json'), onError: error => reported.push(error.code) });
  assert.equal(await failing.append([money(3)], { epoch: '0123abcd' }), false);
  assert.equal(reported.at(-1), 'ENOENT');
  assert.equal(await failing.append([], { epoch: '0123abcd' }), false, 'an empty batch writes nothing');
});

test('close bounds its wait on a held write, refuses a later append and drops a batch that had not started', async t => {
  const file = await scratch(t), reported = [];
  let held, release, writes = 0;
  const holding = new Promise(resolve => { held = resolve; }), gate = new Promise(resolve => { release = resolve; });
  // The gate holds no handle and close() unrefs its timer, so this keeps the event loop alive.
  const alive = setTimeout(() => {}, 10_000);
  t.after(() => { clearTimeout(alive); release(); });
  const store = new JournalStore({ file, now: () => 1000, onError: error => reported.push(error.message), write: async (target, contents) => {
    if (++writes === 1) { held(); await gate; }
    await atomicWrite(target, contents);
  } });
  const first = store.append([money(1)], { epoch: '0123abcd' }), queued = store.append([money(2)], { epoch: '0123abcd' });
  await holding;
  const started = Date.now();
  assert.equal(await store.close({ timeoutMs: 50 }), false);
  assert.ok(Date.now() - started < 1000, 'close returned at its bound');
  assert.equal(await store.append([money(3)], { epoch: '0123abcd' }), false, 'an append after close is refused');
  release();
  assert.equal(await first, true, 'the write already under way lands');
  assert.equal(await queued, false, 'a batch that had not started its write is dropped');
  assert.equal(writes, 1);
  assert.deepEqual((await store.read()).segments.map(segment => segment.events.map(event => event.at)), [[1]]);
  assert.deepEqual(reported, [], 'a fenced batch is dropped silently');
});

test('a write still inside atomicWrite when close gives up does not land over the journal a successor wrote', async t => {
  const file = await scratch(t), reported = [], hold = heldRename();
  // The held rename holds no handle and close() unrefs its timer, so this keeps the event loop alive.
  const alive = setTimeout(() => {}, 10_000);
  t.after(() => { clearTimeout(alive); hold.release(); });
  const a = new JournalStore({ file, now: () => 1000, onError: error => reported.push(error.message),
    write: (target, text, options) => atomicWrite(target, text, { ...options, rename: hold.rename }) });
  assert.equal(await a.append([money(1)], { epoch: '0123abcd' }), true);
  hold.arm();
  const appending = a.append([money(2)], { epoch: '0123abcd' });
  await hold.holding;
  assert.equal(await a.close({ timeoutMs: 50 }), false);
  const b = new JournalStore({ file, now: () => 1000 });
  assert.equal(await b.append([money(3)], { epoch: '0123abcd' }), true);
  const events = async () => (await b.read()).segments.flatMap(segment => segment.events.map(event => event.at));
  assert.deepEqual(await events(), [1, 3]);
  hold.release();
  assert.equal(await appending, false, 'the write fenced by close is a dropped batch');
  assert.deepEqual(await events(), [1, 3], 'the successor journal stands');
  assert.deepEqual((await fs.readdir(path.dirname(file))).filter(name => name.endsWith('.tmp')), []);
  assert.deepEqual(reported, [], 'a fenced write is dropped silently');
});

test('close with an idle chain returns at once; a batch closed under it before its write is dropped silently', async t => {
  const file = await scratch(t), reported = [];
  const store = new JournalStore({ file, onError: error => reported.push(error.message) });
  const started = Date.now();
  assert.equal(await store.close(), true);
  assert.ok(Date.now() - started < 1000, 'an idle chain does not wait for the bound');
  assert.equal(await store.append([money(1)], { epoch: '0123abcd' }), false);
  assert.equal(await store.clear(), false, 'a clear after close is dropped too');
  let closing;
  const racing = new JournalStore({ file, onError: error => reported.push(error.message), onLoaded: async () => { closing = racing.close(); } });
  assert.equal(await racing.append([money(2)], { epoch: '0123abcd' }), false, 'closed between its read and its write');
  assert.equal(await closing, true);
  assert.equal(await fs.access(file).then(() => true, () => false), false, 'nothing was written');
  assert.equal(newestMarker(file), 0, 'nor a marker');
  assert.deepEqual(reported, []);
});

test('presentation defaults to the current session/character, labels event origin, and supports explicit history and paused notes', () => {
  assert.deepEqual(presentJournal(null), { status: 'missing', segments: [], events: [] });
  assert.equal(presentJournal({ schemaVersion: 1, segments: [] }, { session: { epoch: '89abcdef' } }).status, 'empty');
  const document = { schemaVersion: 1, segments: [
    { epoch: '0123abcd', uiNonce: 'abcd0123', startedAt: 1000, endedAt: 3000, character: { name: 'Jaina', class: 'Mage' },
      events: [money(1000), { at: 2000, domain: 'progress', revision: 2, kind: 'died' }] },
    { epoch: '89abcdef', uiNonce: 'ef012345', startedAt: 3000, endedAt: null, character: { name: 'Thrall', class: 'Shaman' },
      events: [money(4000)] },
  ] };
  const current = presentJournal(document, { session: { epoch: '89abcdef', uiNonce: 'ef012345' } }, 10_000);
  assert.equal(current.status, 'ready');
  assert.equal(current.scope, 'current');
  assert.equal(current.segments.length, 1, 'current-session summary only includes the active segment');
  assert.deepEqual(current.segments[0].character, { name: 'Thrall', class: 'Shaman' });
  assert.equal(current.segments[0].eventCount, 1);
  assert.ok(!JSON.stringify(current).includes('Jaina'), 'current-session response never names another character');
  assert.equal(current.events.length, 1, 'defaults to the current session so an alt\'s activity is not mixed in');
  assert.deepEqual(current.events[0].character, { name: 'Thrall', class: 'Shaman' });
  assert.equal(current.events[0].epoch, '89abcdef');
  assert.equal(current.events[0].uiNonce, 'ef012345');

  const all = presentJournal(document, { includeHistory: true }, 10_000);
  assert.equal(all.status, 'ready');
  assert.equal(all.scope, 'all');
  assert.deepEqual(all.segments[0], { epoch: '0123abcd', uiNonce: 'abcd0123', startedAt: new Date(1000).toISOString(), endedAt: new Date(3000).toISOString(), character: { name: 'Jaina', class: 'Mage' }, eventCount: 2 });
  assert.equal(all.segments[1].endedAt, null);
  assert.deepEqual(all.events.map(event => [event.at, event.ageSeconds, event.character?.name]), [
    [new Date(1000).toISOString(), 9, 'Jaina'],
    [new Date(2000).toISOString(), 8, 'Jaina'],
    [new Date(4000).toISOString(), 6, 'Thrall'],
  ]);
  assert.deepEqual(presentJournal(document, { includeHistory: true, character: 'jaina' }, 10_000).events.map(event => event.kind), ['money-change', 'died']);
  assert.deepEqual(presentJournal(document, { includeHistory: true, since: 2000 }, 10_000).events.map(event => event.kind), ['died', 'money-change']);
  assert.deepEqual(presentJournal(document, { includeHistory: true, kinds: ['money-change'] }, 10_000).events.map(event => event.money), [1000, 4000]);
  assert.deepEqual(presentJournal(document, { includeHistory: true, limit: 2 }, 10_000).events.map(event => event.kind), ['died', 'money-change']);
  const paused = presentJournal(document, { sharing: false }, 10_000);
  assert.equal(paused.sharing, 'paused');
  assert.match(paused.note, /WoW context sharing is paused/u);
});

test('without a known current session nothing stored is served as current; history still reads as before', () => {
  // The newest stored segment can be another character's: the daemon cache is still waiting for this session.
  const document = { schemaVersion: 1, segments: [
    { epoch: '89abcdef', uiNonce: 'ef012345', startedAt: 3000, endedAt: null, character: { name: 'Jaina', class: 'Mage' },
      events: [money(4000)] },
  ] };
  assert.deepEqual(presentJournal(document, {}, 10_000), { status: 'waiting', scope: 'current', segments: [], events: [] });
  assert.deepEqual(presentJournal(document, { session: { uiNonce: 'ef012345' } }, 10_000).events, [], 'a nonce without an epoch is no session');
  const history = presentJournal(document, { includeHistory: true }, 10_000);
  assert.equal(history.status, 'ready');
  assert.equal(history.scope, 'all');
  assert.deepEqual(history.events.map(event => [event.character?.name, event.money]), [['Jaina', 4000]]);
  assert.deepEqual(presentJournal(document, { includeHistory: true }, 10_000),
    presentJournal(document, { includeHistory: true, session: { epoch: '89abcdef' } }, 10_000), 'history does not depend on the session');
});

test('a clear still inside its marker write when close gives up does not delete the journal a successor keeps', async t => {
  const file = await scratch(t), hold = heldCreate(file);
  const alive = setTimeout(() => {}, 10_000);
  t.after(() => { clearTimeout(alive); hold.release(); });
  const a = new JournalStore({ file, now: () => 1000,
    write: hold.write });
  assert.equal(await a.append([money(1)], { epoch: '0123abcd' }), true);
  hold.arm();
  const clearing = a.clear();
  await hold.holding;
  assert.equal(await a.close({ timeoutMs: 50 }), false);
  const b = new JournalStore({ file, now: () => 1000 });
  assert.equal(await b.append([money(3)], { epoch: '0123abcd' }), true);
  hold.release();
  assert.equal(await clearing, false, 'the clear fenced by close did nothing');
  assert.deepEqual((await b.read()).segments.flatMap(segment => segment.events.map(event => event.at)), [1, 3], 'the successor journal stands');
  assert.equal(newestMarker(file), 0, 'no marker was left either');
  assert.equal(await fs.access(`${markerFor(file)}.lock`).then(() => true, () => false), false, 'the clear lock was released');
});

test('a close that lands after a clear creates its marker stops the clear before its unlink', async t => {
  const file = await scratch(t);
  let closing;
  const a = new JournalStore({ file, now: () => 1000, write: async (target, text, options) => {
    const written = await defaultWrite(target, text, options);
    if (isMarker(file, target)) closing = a.close();
    return written;
  } });
  assert.equal(await a.append([money(1)], { epoch: '0123abcd' }), true);
  assert.equal(await a.clear(), false, 'the clear fenced by close did not unlink');
  assert.equal(await closing, true);
  assert.equal(await fs.access(file).then(() => true, () => false), true, 'the journal file was left in place');
  assert.equal(newestMarker(file), 1000, 'the marker it wrote still fences it');
  assert.equal(await fs.access(`${markerFor(file)}.lock`).then(() => true, () => false), false, 'the clear lock was released');
});

test('two clears that both find one stale lock reclaim it by ownership and never delete each other\'s fresh lock', async t => {
  const file = await scratch(t), lock = `${markerFor(file)}.lock`, reported = [];
  const leftovers = async () => (await fs.readdir(path.dirname(file))).filter(name => name.includes('.lock'));
  for (let round = 0; round < 10; round++) {
    const slow = new JournalStore({ file, now: () => 1000, lockWaitMs: 1, onError: error => reported.push(error.message) });
    const fast = new JournalStore({ file, now: () => 5000, lockWaitMs: 1, onError: error => reported.push(error.message) });
    await slow.append([money(1)], { epoch: '0123abcd' });
    await fs.writeFile(lock, JSON.stringify({ pid: 0, at: 0 }));
    const old = new Date(Date.now() - 10_000);
    await fs.utimes(lock, old, old);
    await Promise.all([slow.clear(), fast.clear()]);
    const marker = newestMarker(file);
    assert.ok(marker >= 5000, `round ${round}: the marker never falls below the later clear (${marker})`);
    assert.equal(await fs.access(file).then(() => true, () => false), false, `round ${round}: the journal is gone`);
    assert.deepEqual(await leftovers(), [], `round ${round}: no lock or moved-aside file remains`);
  }
  assert.deepEqual(reported, []);
});

test('a lock reclaimed as stale and taken by another clear is not released or overwritten by the holder that lost it', async t => {
  const file = await scratch(t), lock = `${markerFor(file)}.lock`, reported = [];
  const store = new JournalStore({ file, now: () => 1000 });
  await store.append([money(1)], { epoch: '0123abcd' });
  // The holder's own lock is swapped for someone else's while its clear runs, as a reclaimer would after 5 s.
  let swappedOnce = false;
  const holder = new JournalStore({ file, now: () => 1000, onError: error => reported.push(error.message), write: async (target, text, options) => {
    if (!swappedOnce) { swappedOnce = true; await fs.rm(lock, { force: true }); await fs.writeFile(lock, JSON.stringify({ pid: 0, at: 0, token: 'theirs' })); }
    return defaultWrite(target, text, options);
  } });
  assert.equal(await holder.clear(), false);
  assert.deepEqual(reported, ['Session journal clear lock lost']);
  assert.equal(JSON.parse(await fs.readFile(lock, 'utf8')).token, 'theirs', 'the other holder\'s lock is left in place');
  assert.equal(await fs.access(file).then(() => true, () => false), true, 'the journal file is not unlinked after losing the lock');
});

test('CLI journal --clear exits nonzero and does not claim there was no journal when clear is refused', async t => {
  const { main } = await import('../bin/witchcraft.js');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'witchcraft-cli-clear-'));
  t.after(async () => { assert.equal(path.dirname(dir), os.tmpdir()); await fs.rm(dir, { recursive: true, force: true }); });
  const cacheFile = path.join(dir, 'wow-context.json');
  const journalFile = journalPath(cacheFile);
  const store = new JournalStore({ file: journalFile, now: () => 1000 });
  await store.append([money(1)], { epoch: '0123abcd' });
  // An unreadable clear marker causes clear() to fail closed and report an error immediately.
  await fs.writeFile(clearMarkerPath(cacheFile), '{');
  const origLog = console.log, origErr = console.error, origCode = process.exitCode;
  const stdout = [], stderr = [];
  console.log = (...args) => stdout.push(args.join(' '));
  console.error = (...args) => stderr.push(args.join(' '));
  process.exitCode = 0;
  let exitCode;
  try {
    await main(['journal', '--clear'], { localDir: dir });
    exitCode = process.exitCode;
  } finally {
    console.log = origLog;
    console.error = origErr;
    process.exitCode = origCode;
  }
  assert.equal(exitCode, 1, `stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`);
  assert.doesNotMatch(stdout.join('\n'), /There was no session journal to clear/u);
  assert.match(stderr.join('\n'), /Session journal clear marker unreadable/u);
});

test('a marker name with leading zeros is not a marker: each value has one name', async t => {
  const file = await scratch(t), reported = [];
  const store = new JournalStore({ file, now: () => 1000, onError: error => reported.push(error.message) });
  assert.equal(await store.append([money(1)], { epoch: '0123abcd' }), true);
  await fs.writeFile(`${markerFor(file)}.09000`, '');
  assert.deepEqual((await store.read()).segments.flatMap(segment => segment.events.map(event => event.at)), [1], 'nothing was fenced');
  assert.equal(await store.clear(), true);
  assert.deepEqual((await fs.readdir(path.dirname(file))).filter(name => name.includes('.cleared')).sort(),
    [`${path.basename(markerFor(file))}.09000`, `${path.basename(markerFor(file))}.1000`], 'the clear took 1000 and left the other name alone');
  assert.deepEqual(reported, []);
});
