import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runBridge } from '../bin/witchcraft.js';
import { acquireLock, releaseOwnedLock } from '../src/bridge-lock.js';

async function lockDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'witchcraft-lock-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
// Creates a lock the way a bridge does and returns its identity.
async function create(lockPath, text) {
  const handle = await fs.open(lockPath, 'wx');
  await handle.writeFile(text); const identity = await handle.stat({ bigint: true }); await handle.close();
  return identity;
}
const others = async dir => (await fs.readdir(dir)).filter(name => name !== 'bridge.lock');

test('bridge: a startup failure right after taking the lock releases it', async t => {
  const root = await lockDir(t);
  const localDir = path.join(root, 'local');
  // An invalid ring size makes the ring writer throw after the lock exists but before the guarded block.
  const config = { repoRoot: root, addonsDir: path.join(root, 'AddOns'), ringSize: 2, commands: {} };
  await assert.rejects(runBridge(config, { noMcp: true, noCurrent: true }, [], { localDir }), /Invalid ring configuration/u);
  await assert.rejects(fs.stat(path.join(localDir, 'bridge.lock')), { code: 'ENOENT' });
});

test('releaseOwnedLock removes our lock and leaves no private names behind', async t => {
  const dir = await lockDir(t), lockPath = path.join(dir, 'bridge.lock');
  const identity = await create(lockPath, 'ours');
  assert.deepEqual(await releaseOwnedLock({ lockPath, identity, tag: 'aaaa' }), { released: true });
  assert.deepEqual(await fs.readdir(dir), []);
});

test('releaseOwnedLock never vacates or removes a foreign lock', async t => {
  const dir = await lockDir(t), lockPath = path.join(dir, 'bridge.lock');
  const ours = await create(lockPath, 'ours');
  await fs.unlink(lockPath); await create(lockPath, 'foreign');
  let vacated = false;
  const watching = { ...fs, rename: async (...args) => { vacated = true; return fs.rename(...args); } };
  assert.deepEqual(await releaseOwnedLock({ lockPath, identity: ours, tag: 'aaaa', fs: watching }), { released: false });
  assert.equal(vacated, false, 'a foreign lock is detected without moving it');
  assert.equal(await fs.readFile(lockPath, 'utf8'), 'foreign');
  assert.deepEqual(await others(dir), []);
});

test('releaseOwnedLock restores a lock that a racer swapped in after the ownership check', async t => {
  const dir = await lockDir(t), lockPath = path.join(dir, 'bridge.lock');
  const ours = await create(lockPath, 'ours');
  // Between the check and the claim, a racer removes ours and acquires its own.
  const racing = { ...fs, rename: async (from, to) => {
    await fs.unlink(lockPath); await create(lockPath, 'racer'); return fs.rename(from, to);
  } };
  assert.deepEqual(await releaseOwnedLock({ lockPath, identity: ours, tag: 'aaaa', fs: racing }), { released: false });
  assert.equal(await fs.readFile(lockPath, 'utf8'), 'racer');
  assert.deepEqual(await others(dir), []);
});

test('releaseOwnedLock keeps a claimed foreign lock and reports it when it cannot be put back', async t => {
  const dir = await lockDir(t), lockPath = path.join(dir, 'bridge.lock');
  const ours = await create(lockPath, 'ours');
  let links = 0;
  const failing = { ...fs,
    rename: async (from, to) => { await fs.unlink(lockPath); await create(lockPath, 'racer'); return fs.rename(from, to); },
    // The first link is the ownership probe; the second is the restore, which a third acquirer blocks.
    link: async (from, to) => { if (++links === 2) { await create(lockPath, 'third'); } return fs.link(from, to); },
  };
  await assert.rejects(releaseOwnedLock({ lockPath, identity: ours, tag: 'aaaa', fs: failing }), /kept at .*bridge\.lock\.aaaa\.claimed/u);
  assert.equal(await fs.readFile(lockPath, 'utf8'), 'third');
  const kept = (await others(dir)).filter(name => name.endsWith('.claimed'));
  assert.equal(kept.length, 1);
  assert.equal(await fs.readFile(path.join(dir, kept[0]), 'utf8'), 'racer');
});

// A lock left by an earlier run: its text, and when it was last written.
async function leftover(lockPath, text, mtimeMs) {
  await fs.writeFile(lockPath, text, { flag: 'wx' });
  await fs.utimes(lockPath, new Date(mtimeMs), new Date(mtimeMs));
}
const record = { pid: process.pid, epoch: 'cafe0001', startedAt: '2026-10-02T08:00:00.000Z' };
const staleNames = async dir => (await fs.readdir(dir)).filter(name => /^bridge\.lock\.stale-.*\.json$/u.test(name));

test('acquireLock takes a free path, holding only the lock and its record', async t => {
  const dir = await lockDir(t), lockPath = path.join(dir, 'bridge.lock');
  const lock = await acquireLock({ lockPath, record, tag: 'cafe0001' });
  t.after(() => lock.handle.close());
  assert.deepEqual(JSON.parse(await fs.readFile(lockPath, 'utf8')), record);
  assert.deepEqual(await fs.readdir(dir), ['bridge.lock']);
  const onDisk = await fs.stat(lockPath, { bigint: true });
  assert.equal(onDisk.ino, lock.identity.ino);
  assert.deepEqual(lock.reclaimed, []);
});

test('acquireLock reclaims an empty lock older than a minute and keeps it aside', async t => {
  const dir = await lockDir(t), lockPath = path.join(dir, 'bridge.lock'), now = Date.now();
  await leftover(lockPath, '', now - 120_000);
  const lock = await acquireLock({ lockPath, record, tag: 'cafe0001', now, bootTime: now - 3_600_000 });
  t.after(() => lock.handle.close());
  assert.deepEqual(JSON.parse(await fs.readFile(lockPath, 'utf8')), record);
  const kept = await staleNames(dir);
  assert.equal(kept.length, 1);
  assert.equal(await fs.readFile(path.join(dir, kept[0]), 'utf8'), '');
  assert.equal(lock.reclaimed.length, 1);
  assert.match(lock.reclaimed[0].reason, /empty or unreadable/u);
});

test('acquireLock refuses an empty lock younger than a minute and leaves no files of its own', async t => {
  const dir = await lockDir(t), lockPath = path.join(dir, 'bridge.lock'), now = Date.now();
  await leftover(lockPath, '', now - 5_000);
  await assert.rejects(acquireLock({ lockPath, record, tag: 'cafe0001', now, bootTime: now - 3_600_000 }),
    /A Witchcraft bridge owns .*being written/u);
  assert.equal(await fs.readFile(lockPath, 'utf8'), '');
  assert.deepEqual(await fs.readdir(dir), ['bridge.lock']);
});

test('acquireLock reclaims a lock whose process has exited', async t => {
  const dir = await lockDir(t), lockPath = path.join(dir, 'bridge.lock'), now = Date.now();
  const old = JSON.stringify({ pid: 4242, epoch: 'dead0001', startedAt: '2026-09-29T10:05:18.000Z' });
  await leftover(lockPath, old, now - 5_000);
  const asked = [];
  const lock = await acquireLock({ lockPath, record, tag: 'cafe0001', now, bootTime: now - 3_600_000,
    isAlive: pid => { asked.push(pid); return false; } });
  t.after(() => lock.handle.close());
  assert.deepEqual(asked, [4242]);
  assert.deepEqual(JSON.parse(await fs.readFile(lockPath, 'utf8')), record);
  const kept = await staleNames(dir);
  assert.equal(kept.length, 1);
  assert.equal(await fs.readFile(path.join(dir, kept[0]), 'utf8'), old);
  assert.match(lock.reclaimed[0].reason, /4242 has exited/u);
});

test('acquireLock refuses a live owner and names its pid and start time', async t => {
  const dir = await lockDir(t), lockPath = path.join(dir, 'bridge.lock'), now = Date.now();
  const live = JSON.stringify({ pid: process.pid, epoch: 'beef0001', startedAt: '2026-10-02T07:59:00.000Z' });
  await leftover(lockPath, live, now - 5_000);
  await assert.rejects(acquireLock({ lockPath, record, tag: 'cafe0001', now, bootTime: now - 3_600_000 }),
    new RegExp(`A Witchcraft bridge owns .*pid ${process.pid}.*2026-10-02T07:59:00\\.000Z`, 'u'));
  assert.equal(await fs.readFile(lockPath, 'utf8'), live);
  assert.deepEqual(await fs.readdir(dir), ['bridge.lock']);
});

test('acquireLock refuses a live pid even when its lock looks older than the boot', async t => {
  // A wall-clock step after the lock was written (dual-boot RTC skew, a late time sync) makes a
  // live lock look older than the boot; that must never set a running bridge's lock aside.
  const dir = await lockDir(t), lockPath = path.join(dir, 'bridge.lock'), now = Date.now();
  const live = JSON.stringify({ pid: process.pid, epoch: 'beef0002', startedAt: '2026-10-02T07:59:00.000Z' });
  await leftover(lockPath, live, now - 20_000);
  await assert.rejects(acquireLock({ lockPath, record, tag: 'cafe0001', now, bootTime: now - 10_000 }), /A Witchcraft bridge owns/u);
  assert.equal(await fs.readFile(lockPath, 'utf8'), live);
});

test('acquireLock reclaims an empty lock written before the last boot without waiting a minute', async t => {
  const dir = await lockDir(t), lockPath = path.join(dir, 'bridge.lock'), now = Date.now();
  await leftover(lockPath, '', now - 20_000);
  const lock = await acquireLock({ lockPath, record, tag: 'cafe0001', now, bootTime: now - 10_000 });
  t.after(() => lock.handle.close());
  assert.deepEqual(JSON.parse(await fs.readFile(lockPath, 'utf8')), record);
  assert.match(lock.reclaimed[0].reason, /before the last boot/u);
});

test('acquireLock judges the identity of the very bytes it read', async t => {
  const dir = await lockDir(t), lockPath = path.join(dir, 'bridge.lock'), now = Date.now();
  await leftover(lockPath, JSON.stringify({ pid: 4242, epoch: 'dead0001' }), now - 5_000);
  let raced = false;
  // A racer reclaims the stale lock and links its own between a read of the path and a stat of it.
  const racing = { ...fs, stat: async (target, options) => {
    if (!raced && target === lockPath) {
      raced = true;
      await fs.rename(lockPath, path.join(dir, 'gone.json'));
      await create(lockPath, JSON.stringify({ pid: process.pid, epoch: 'racerB' }));
    }
    return fs.stat(target, options);
  } };
  const lock = await acquireLock({ lockPath, record, tag: 'cafe0001', now, bootTime: now - 3_600_000,
    isAlive: pid => pid === process.pid, fs: racing }).catch(error => error);
  if (lock.handle) t.after(() => lock.handle.close());
  for (const name of await staleNames(dir)) {
    assert.notEqual(JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')).epoch, 'racerB', 'a live lock must never be set aside');
  }
});

test('acquireLock keeps a racer\'s lock it could not put back, and says where', async t => {
  const dir = await lockDir(t), lockPath = path.join(dir, 'bridge.lock'), now = Date.now();
  await leftover(lockPath, '', now - 120_000);
  let renamed = false, linked = 0;
  // B takes the path just before our rename, and C takes it again before we can link B back.
  const racing = { ...fs,
    rename: async (from, to) => {
      if (!renamed && from === lockPath) { renamed = true; await fs.unlink(lockPath); await create(lockPath, 'racerB'); }
      return fs.rename(from, to);
    },
    link: async (from, to) => {
      if (to === lockPath && ++linked === 2) await create(lockPath, 'thirdC');
      return fs.link(from, to);
    } };
  const error = await acquireLock({ lockPath, record, tag: 'cafe0001', now, bootTime: now - 3_600_000, fs: racing }).catch(failure => failure);
  assert.match(error.message, /A Witchcraft bridge owns/u);
  const kept = (await fs.readdir(dir)).filter(name => name !== 'bridge.lock');
  assert.equal(kept.length, 1, 'B\'s lock is kept under the name it was moved to');
  assert.equal(await fs.readFile(path.join(dir, kept[0]), 'utf8'), 'racerB');
  assert.ok(error.message.includes(kept[0]), 'and the refusal names it');
});

test('acquireLock still holds the lock when only removing its temporary name fails', async t => {
  const dir = await lockDir(t), lockPath = path.join(dir, 'bridge.lock');
  let failed = false;
  const busy = { ...fs, unlink: async target => {
    if (!failed && target.endsWith('.tmp')) { failed = true; throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' }); }
    return fs.unlink(target);
  } };
  const lock = await acquireLock({ lockPath, record, tag: 'cafe0001', fs: busy });
  t.after(() => lock.handle.close());
  assert.deepEqual(JSON.parse(await fs.readFile(lockPath, 'utf8')), record);
});

test('acquireLock never takes a lock that a racer created while it was reclaiming', async t => {
  const dir = await lockDir(t), lockPath = path.join(dir, 'bridge.lock'), now = Date.now();
  await leftover(lockPath, '', now - 120_000);
  let raced = false;
  // Between the staleness check and the claim, another start reclaims the stale lock and takes the path.
  const racing = { ...fs, rename: async (from, to) => {
    if (!raced && from === lockPath) { raced = true; await fs.unlink(lockPath); await create(lockPath, 'racer'); }
    return fs.rename(from, to);
  } };
  await assert.rejects(acquireLock({ lockPath, record, tag: 'cafe0001', now, bootTime: now - 3_600_000, fs: racing }),
    /A Witchcraft bridge owns/u);
  assert.equal(await fs.readFile(lockPath, 'utf8'), 'racer');
  assert.deepEqual(await fs.readdir(dir), ['bridge.lock']);
});

test('bridge: a stale lock from a crashed run is set aside and the bridge starts', async t => {
  const root = await lockDir(t);
  const localDir = path.join(root, 'local'), addonsDir = path.join(root, 'AddOns');
  await fs.mkdir(localDir); await fs.mkdir(addonsDir);
  const lockPath = path.join(localDir, 'bridge.lock');
  await leftover(lockPath, '', Date.now() - 120_000);
  // An invalid ring size fails right after the lock is taken: reaching that error proves the lock was reclaimed.
  const config = { repoRoot: root, addonsDir, ringSize: 2, commands: {} };
  await assert.rejects(runBridge(config, { noMcp: true, noCurrent: true }, [], { localDir }), /Invalid ring configuration/u);
  await assert.rejects(fs.stat(lockPath), { code: 'ENOENT' });
  assert.equal((await staleNames(localDir)).length, 1);
});
