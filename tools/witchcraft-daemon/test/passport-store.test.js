import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { passportPath, readPassport, stampPassport, setPassportCampaign } from '../src/passport-store.js';

async function workspace(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'witchcraft-passport-'));
  t.after(async () => { assert.equal(path.dirname(dir), os.tmpdir()); await fs.rm(dir, { recursive: true, force: true }); });
  return passportPath(path.join(dir, 'context.json'));
}
const stamp = { kind: 'dungeon', referenceId: 'deadmines', title: 'The Deadmines', status: 'complete' };
test('passport lifecycle is persistent and idempotent, edits notes without moving completion time', async t => {
  const file = await workspace(t);
  assert.deepEqual((await readPassport(file)).entries, []);
  await assert.rejects(fs.access(file), { code: 'ENOENT' });
  await stampPassport(file, { ...stamp, note: 'First outing' }, { now: () => 100 });
  const before = await fs.readFile(file, 'utf8');
  await stampPassport(file, stamp, { now: () => 200 });
  assert.equal(await fs.readFile(file, 'utf8'), before);
  await stampPassport(file, { ...stamp, note: 'A good run' }, { now: () => 300 });
  let row = (await readPassport(file)).entries[0];
  assert.equal(row.completedAt, 100); assert.equal(row.updatedAt, 300);
  assert.equal(row.note, 'A good run'); assert.equal(row.evidence, 'user-confirmed');
  await stampPassport(file, { ...stamp, note: '' }, { now: () => 200 });
  row = (await readPassport(file)).entries[0];
  assert.equal(row.updatedAt, 300, 'backward clock does not reverse record ordering');
  assert.equal(row.note, '');
  await stampPassport(file, { ...stamp, profile: 'alt' });
  await setPassportCampaign(file, { campaignId: 'early-dungeons', status: 'active' });
  await setPassportCampaign(file, { campaignId: 'early-dungeons', status: 'remove' });
  assert.equal((await readPassport(file)).entries.length, 1, 'leaving a campaign preserves stamps');
  await stampPassport(file, { ...stamp, status: 'remove' });
  assert.deepEqual((await readPassport(file)).entries, []);
  assert.equal((await readPassport(file, 'alt')).entries.length, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')).profiles.map(row => row.id), ['alt']);
});

test('simultaneous campaign and stamp writers retain both kinds of updates', async t => {
  const file = await workspace(t);
  await Promise.all(Array.from({ length: 8 }, (_, index) => index % 2
    ? stampPassport(file, { ...stamp, referenceId: `dungeon-${index}` })
    : setPassportCampaign(file, { campaignId: `campaign-${index}`, status: 'active' })));
  const saved = await readPassport(file);
  assert.equal(saved.entries.length, 4); assert.equal(saved.campaignIds.length, 4);
  assert.deepEqual(await fs.readdir(path.dirname(file)), [path.basename(file)]);
});

test('invalid, duplicate and future documents are preserved and never reset on a write', async t => {
  const file = await workspace(t);
  for (const value of ['{', '{"schemaVersion":2,"profiles":[]}', JSON.stringify({ schemaVersion: 1,
    profiles: [{ id: 'personal', entries: [], campaignIds: ['same', 'same'] }] })]) {
    await fs.writeFile(file, value);
    await assert.rejects(stampPassport(file, stamp), { code: 'invalid-passport-store' });
    assert.equal(await fs.readFile(file, 'utf8'), value);
    await assert.rejects(fs.access(`${file}.lock`), { code: 'ENOENT' });
  }
  await fs.writeFile(file, Buffer.alloc(1024 * 1024 + 1));
  await assert.rejects(readPassport(file), { code: 'invalid-passport-store' });
  await assert.rejects(setPassportCampaign(file, { campaignId: 'early-dungeons', status: 'active' }), { code: 'invalid-passport-store' });
  assert.equal((await fs.stat(file)).size, 1024 * 1024 + 1);
});

test('stamp limit protects notes, removal reclaims capacity, and busy locks are not stolen', async t => {
  const file = await workspace(t);
  const entries = Array.from({ length: 100 }, (_, index) => ({ kind: 'quest', referenceId: String(index + 1), title: 'Quest', note: '',
    completedAt: 100, updatedAt: 100, evidence: 'user-confirmed' }));
  await fs.writeFile(file, JSON.stringify({ schemaVersion: 1, profiles: [{ id: 'personal', entries, campaignIds: [] }] }));
  const before = await fs.readFile(file, 'utf8');
  await assert.rejects(stampPassport(file, stamp), { code: 'passport-stamp-limit' });
  assert.equal(await fs.readFile(file, 'utf8'), before);
  await stampPassport(file, { kind: 'quest', referenceId: '1', status: 'remove' });
  await stampPassport(file, stamp);
  assert.equal((await readPassport(file)).entries.length, 100);
  await fs.mkdir(`${file}.lock`);
  await assert.rejects(stampPassport(file, stamp), { code: 'passport-store-busy' });
  assert.ok((await fs.stat(`${file}.lock`)).isDirectory());
});

test('full profiles can be freed and identities cannot become paths or noncanonical quest IDs', async t => {
  const file = await workspace(t);
  await fs.writeFile(file, JSON.stringify({ schemaVersion: 1, profiles: Array.from({ length: 20 }, (_, i) =>
    ({ id: `p${i}`, campaignIds: ['early-dungeons'], entries: [] })) }));
  await assert.rejects(setPassportCampaign(file, { profile: 'new', campaignId: 'early-dungeons', status: 'active' }), { code: 'passport-profile-limit' });
  await setPassportCampaign(file, { profile: 'p0', campaignId: 'early-dungeons', status: 'remove' });
  await setPassportCampaign(file, { profile: 'new', campaignId: 'early-dungeons', status: 'active' });
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).profiles.length, 20);
  await assert.rejects(stampPassport(file, { ...stamp, profile: '../other' }));
  await assert.rejects(stampPassport(file, { ...stamp, kind: 'quest', referenceId: '0166' }));
  await assert.rejects(stampPassport(file, { ...stamp, note: 'control\ntext' }));
});
