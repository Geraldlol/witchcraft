import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { readLootGoals, setLootGoal, lootGoalsPath } from '../src/loot-goals.js';

async function workspace(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'witchcraft-loot-goals-'));
  t.after(async () => { assert.equal(path.dirname(dir), os.tmpdir()); await fs.rm(dir, { recursive: true, force: true }); });
  return lootGoalsPath(path.join(dir, 'context.json'));
}
test('goal lifecycle persists, is idempotent, and isolates explicitly selected profiles', async t => {
  const file = await workspace(t);
  assert.deepEqual((await readLootGoals(file)).goals, []);
  await assert.rejects(fs.access(file), { code: 'ENOENT' }, 'reading does not create storage');
  await setLootGoal(file, { itemId: 5191, status: 'active' }, { now: () => 100 });
  const initial = await fs.readFile(file, 'utf8');
  await setLootGoal(file, { itemId: 5191, status: 'active' }, { now: () => 200 });
  assert.equal(await fs.readFile(file, 'utf8'), initial);
  await setLootGoal(file, { profile: 'alt', itemId: 5191, status: 'active' }, { now: () => 300 });
  await setLootGoal(file, { itemId: 5191, status: 'acquired' }, { now: () => 400 });
  assert.equal((await readLootGoals(file)).goals[0].status, 'acquired');
  assert.equal((await readLootGoals(file, 'alt')).goals[0].status, 'active');
  await setLootGoal(file, { itemId: 5191, status: 'active' }, { now: () => 500 });
  assert.equal((await readLootGoals(file)).goals[0].addedAt, 100);
  await setLootGoal(file, { itemId: 5191, status: 'remove' });
  assert.deepEqual((await readLootGoals(file)).goals, []);
  assert.equal((await readLootGoals(file, 'alt')).goals.length, 1);
});

test('simultaneous writers merge without dropping either assistants goals', async t => {
  const file = await workspace(t);
  await Promise.all(Array.from({ length: 12 }, (_, index) => setLootGoal(file, { itemId: index + 1, status: 'active' })));
  assert.equal((await readLootGoals(file)).goals.length, 12);
  assert.equal(new Set((await readLootGoals(file)).goals.map(row => row.itemId)).size, 12);
  assert.deepEqual((await fs.readdir(path.dirname(file))).sort(), [path.basename(file)]);
});

test('invalid and newer saved documents survive attempted writes byte for byte', async t => {
  const file = await workspace(t);
  for (const text of ['{', '{"schemaVersion":2,"profiles":[]}', '{"schemaVersion":1,"profiles":[{"id":"personal","goals":[],"future":true}]}']) {
    await fs.writeFile(file, text);
    await assert.rejects(setLootGoal(file, { itemId: 5191, status: 'active' }), { code: 'invalid-goal-store' });
    assert.equal(await fs.readFile(file, 'utf8'), text);
    await assert.rejects(fs.access(`${file}.lock`), { code: 'ENOENT' });
  }
});

test('busy writer is never unlocked by another process and invalid profile cannot choose paths', async t => {
  const file = await workspace(t);
  await fs.mkdir(`${file}.lock`);
  await assert.rejects(setLootGoal(file, { itemId: 5191, status: 'active' }), { code: 'goal-store-busy' });
  assert.ok((await fs.stat(`${file}.lock`)).isDirectory());
  await assert.rejects(setLootGoal(file, { profile: '../other', itemId: 1, status: 'active' }));
  await assert.rejects(fs.access(file), { code: 'ENOENT' });
});

test('full goal profile refuses addition while still permitting acquired and removal', async t => {
  const file = await workspace(t);
  const goals = Array.from({ length: 100 }, (_, index) => ({ itemId: index + 1, status: 'active', addedAt: 1, updatedAt: 1 }));
  await fs.writeFile(file, JSON.stringify({ schemaVersion: 1, profiles: [{ id: 'personal', goals }] }));
  const before = await fs.readFile(file, 'utf8');
  await assert.rejects(setLootGoal(file, { itemId: 101, status: 'active' }), { code: 'goal-limit' });
  assert.equal(await fs.readFile(file, 'utf8'), before);
  await setLootGoal(file, { itemId: 1, status: 'acquired' });
  await setLootGoal(file, { itemId: 2, status: 'remove' });
  assert.equal((await readLootGoals(file)).goals.length, 99);
});

test('removing the final goal reclaims the profile slot without affecting other profiles', async t => {
  const file = await workspace(t);
  const goal = { itemId: 1, status: 'active', addedAt: 1, updatedAt: 1 };
  await fs.writeFile(file, JSON.stringify({ schemaVersion: 1,
    profiles: Array.from({ length: 20 }, (_, index) => ({ id: `p${index}`, goals: [goal] })) }));
  await setLootGoal(file, { profile: 'p0', itemId: 1, status: 'remove' });
  await setLootGoal(file, { profile: 'new-profile', itemId: 2, status: 'active' });
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).profiles.length, 20);
  assert.equal((await readLootGoals(file, 'p1')).goals[0].itemId, 1);
  assert.deepEqual((await readLootGoals(file, 'p0')).goals, []);
  assert.equal((await readLootGoals(file, 'new-profile')).goals[0].itemId, 2);
});
