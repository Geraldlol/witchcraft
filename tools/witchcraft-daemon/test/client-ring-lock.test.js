import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runBridge } from '../bin/witchcraft.js';
import { acquireLock, acquireRingLock, releaseOwnedLock, RING_LOCK_NAME } from '../src/bridge-lock.js';
import { initializeRing } from '../src/init.js';

async function sandbox(t) {
  const temp = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temp, 'witchcraft-ring-lock-'));
  t.after(async () => {
    const resolved = await fs.realpath(root);
    assert.equal(path.dirname(resolved), temp);
    assert.match(path.basename(resolved), /^witchcraft-ring-lock-/u);
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return root;
}

test('a second checkout and init/clean cannot scrub a running client ring or enter during teardown', async t => {
  const root = await sandbox(t);
  const addonsDir = path.join(root, 'AddOns');
  await fs.mkdir(addonsDir);
  await initializeRing({ addonsDir, ringSize: 3 });
  const config = { addonsDir, repoRoot: root, ringSize: 3 };
  const ready = Promise.withResolvers(), disposing = Promise.withResolvers(), finish = Promise.withResolvers();
  let exit;
  class Terminal {
    constructor({ onExit, cols, rows }) {
      this.cols = cols; this.rows = rows;
      this.sessions = new Map([['claude', { status: 'running' }]]);
      exit = () => { this.sessions.get('claude').status = 'exited'; onExit('claude'); };
    }
    snapshot() { return [{ id: 'claude', title: 'Claude', status: 'running', lines: ['first checkout'] }]; }
    async dispose() { disposing.resolve(); await finish.promise; }
  }
  const options = { only: 'claude', noCurrent: true, noMcp: true, noOverlay: true };
  const adapters = { localDir: path.join(root, 'checkoutA'), TerminalPair: Terminal,
    attachTerminal: () => ({ dispose() {} }), createSessionInfo: () => ({ start() { return this; }, get() {}, stop() {} }),
    watchSavedVariables: () => { ready.resolve(); return () => {}; } };
  const run = runBridge(config, options, [], adapters);
  const contender = { ...adapters, localDir: path.join(root, 'checkoutB') };
  const slot = path.join(addonsDir, 'Witchcraft_Chunk_0001', 'Chunk.lua');
  try {
    await Promise.race([ready.promise, run.then(error => { throw error ?? Error('bridge exited before ready'); })]);
    const live = await fs.readFile(slot, 'utf8');
    assert.match(live, /first checkout/u);
    await assert.rejects(runBridge(config, options, [], contender), { code: 'LOCK_HELD' });
    await assert.rejects(fs.stat(path.join(contender.localDir, 'bridge.lock')), { code: 'ENOENT' });
    for (const clean of [false, true]) {
      await assert.rejects(initializeRing({ addonsDir, ringSize: 3, clean }), { code: 'LOCK_HELD' });
    }
    assert.equal(await fs.readFile(slot, 'utf8'), live);
    exit();
    await disposing.promise;
    await assert.rejects(initializeRing({ addonsDir, ringSize: 3, clean: true }), { code: 'LOCK_HELD' });
  } finally {
    exit?.();
    finish.resolve();
    assert.equal(await run, undefined);
  }
  assert.equal((await initializeRing({ addonsDir, ringSize: 3, clean: true })).created, 3);
});

test('different client directories can initialize concurrently and a foreign lock file is preserved', async t => {
  const root = await sandbox(t);
  const a = path.join(root, 'one'), b = path.join(root, 'two');
  await fs.mkdir(a); await fs.mkdir(b);
  const release = await acquireRingLock(a, 'init');
  try {
    assert.equal((await initializeRing({ addonsDir: b, ringSize: 3 })).created, 3);
  } finally { await release(); }
  const file = path.join(a, RING_LOCK_NAME);
  await fs.writeFile(file, 'owned by somebody else');
  await fs.utimes(file, 1, 1);
  await assert.rejects(initializeRing({ addonsDir: a, ringSize: 3 }), { code: 'LOCK_HELD' });
  assert.equal(await fs.readFile(file, 'utf8'), 'owned by somebody else');
});

test('init recovers a client ring left locked by a process that exited', async t => {
  const root = await sandbox(t);
  const script = `const { acquireRingLock } = await import(process.argv[1]);
    await acquireRingLock(process.argv[2], 'run');`;
  await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script,
    import.meta.resolve('../src/bridge-lock.js'), root]);
  const abandoned = await fs.readFile(path.join(root, RING_LOCK_NAME), 'utf8');
  assert.equal((await initializeRing({ addonsDir: root, ringSize: 3 })).created, 3);
  const recovered = (await fs.readdir(root)).filter(name => name.startsWith(RING_LOCK_NAME + '.stale-'));
  assert.equal(recovered.length, 1);
  assert.equal(await fs.readFile(path.join(root, recovered[0]), 'utf8'), abandoned);
});

test('a delayed stale recovery never moves the new client owner or gives a third writer a vacancy', async t => {
  const root = await sandbox(t), lockPath = path.join(root, RING_LOCK_NAME), recordType = 'witchcraft-ring-v1';
  const record = { type: recordType, pid: process.pid, startedAt: new Date().toISOString() };
  await fs.writeFile(lockPath, JSON.stringify({ ...record, pid: process.pid + 1 }));
  const readOld = Promise.withResolvers(), resume = Promise.withResolvers();
  const take = (tag, files = fs) => acquireLock({ lockPath, recordType, record: { ...record, tag },
    tag, fs: files, isAlive: pid => pid === process.pid });
  let moves = 0;
  const delayed = take('late', { ...fs,
    async link(from, to) {
      if (to.startsWith(lockPath + '.recover-')) { readOld.resolve(); await resume.promise; }
      return fs.link(from, to);
    },
    async rename(from, to) { if (from === lockPath) moves++; return fs.rename(from, to); },
  });
  await readOld.promise;
  const current = await take('winner');
  try {
    resume.resolve();
    await assert.rejects(delayed, { code: 'LOCK_HELD' });
    assert.equal(moves, 0);
    await assert.rejects(take('third'), { code: 'LOCK_HELD' });
    assert.equal(JSON.parse(await fs.readFile(lockPath, 'utf8')).tag, 'winner');
  } finally {
    await current.handle.close();
    await releaseOwnedLock({ lockPath, identity: current.identity, tag: 'winner' });
  }
});

// A dead lock owner plus a recovery claim already on disk, as a claimer that died mid-recovery leaves.
async function claimedDeadLock(t, claimText) {
  const root = await sandbox(t), lockPath = path.join(root, RING_LOCK_NAME), recordType = 'witchcraft-ring-v1';
  const dead = JSON.stringify({ type: recordType, pid: process.pid + 1, startedAt: new Date().toISOString() });
  await fs.writeFile(lockPath, dead);
  const stat = await fs.stat(lockPath, { bigint: true });
  const claim = `${lockPath}.recover-${stat.dev}-${stat.ino}`;
  await fs.writeFile(claim, claimText ?? dead);
  const take = files => acquireLock({ lockPath, recordType, record: { type: recordType, pid: process.pid },
    tag: 'next', isAlive: pid => pid === process.pid, ...(files ? { fs: files } : {}) });
  return { root, lockPath, recordType, dead, claim, take };
}

async function refusedUntouched(t, claimText, files) {
  const { root, lockPath, dead, claim, take } = await claimedDeadLock(t, claimText);
  const before = (await fs.readdir(root)).sort();
  await assert.rejects(take(files), error => {
    assert.equal(error.code, 'LOCK_HELD');
    assert.ok(error.message.includes('recovery is already claimed') && error.message.includes(claim));
    return true;
  });
  assert.equal(await fs.readFile(lockPath, 'utf8'), dead);
  assert.deepEqual((await fs.readdir(root)).sort(), before);
  return claim;
}

test('a recovery claim left by a claimer that exited is dropped and the dead lock is recovered', async t => {
  const { root, lockPath, dead, claim, take } = await claimedDeadLock(t);
  const taken = await take();
  try {
    assert.equal(taken.reclaimed.length, 1);
    assert.match(path.basename(taken.reclaimed[0].path), /^\.witchcraft-ring\.lock\.stale-.*-next\.json$/u);
    assert.equal(await fs.readFile(taken.reclaimed[0].path, 'utf8'), dead);
    await assert.rejects(fs.stat(claim), { code: 'ENOENT' });
    assert.deepEqual((await fs.readdir(root)).filter(name => name.includes('.recover-')), []);
    assert.equal(JSON.parse(await fs.readFile(lockPath, 'utf8')).pid, process.pid);
  } finally {
    await taken.handle.close();
    await releaseOwnedLock({ lockPath, identity: taken.identity, tag: 'next' });
  }
});

test('a recovery claim whose claimer still runs is refused and both records are untouched', async t => {
  const live = JSON.stringify({ type: 'witchcraft-ring-v1', pid: process.pid, startedAt: new Date().toISOString() });
  const claim = await refusedUntouched(t, live);
  assert.equal(await fs.readFile(claim, 'utf8'), live);
});

test('a recovery claim that is not a ring record is refused and untouched', async t => {
  const foreign = JSON.stringify({ type: 'something-else', pid: process.pid + 1 });
  assert.equal(await fs.readFile(await refusedUntouched(t, foreign), 'utf8'), foreign);
  const large = JSON.stringify({ type: 'witchcraft-ring-v1', pid: process.pid + 1, pad: 'x'.repeat(5000) });
  assert.equal(await fs.readFile(await refusedUntouched(t, large), 'utf8'), large);
});

test('a recoverer that judged a dead claim late never moves or vacates the newer live claim', async t => {
  const { root, lockPath, recordType, dead, claim } = await claimedDeadLock(t);
  const take = (tag, files) => acquireLock({ lockPath, recordType, record: { type: recordType, pid: process.pid, tag },
    tag, fs: files, isAlive: pid => pid === process.pid });
  const judged = Promise.withResolvers(), resumeB = Promise.withResolvers();
  const holding = Promise.withResolvers(), resumeA = Promise.withResolvers();
  let paused = false, aHolds = false;
  const violations = [];
  // After every step of B while A holds its claim: the claim is A's and the lock path is not vacant.
  const watch = async step => {
    if (!aHolds) return;
    const text = await fs.readFile(claim, 'utf8').catch(error => error.code);
    if (!text.startsWith('{') || JSON.parse(text).tag !== 'A') violations.push(`${step}: claim is ${text}`);
    const lock = await fs.readFile(lockPath, 'utf8').catch(error => error.code);
    if (lock !== dead) violations.push(`${step}: lock is ${lock}`);
  };
  // B pauses at its first move after judging the dead claim (taking a guard, or renaming the claim).
  const filesB = Object.fromEntries(Object.entries(fs).map(([name, fn]) => [name, typeof fn !== 'function' ? fn
    : async (...args) => {
      const [from, to] = args;
      if (!paused && ((name === 'link' && String(to).startsWith(`${claim}.`)) || (name === 'rename' && from === claim))) {
        paused = true; judged.resolve(); await resumeB.promise;
      }
      try { return await fn(...args); } finally { await watch(`${name} ${args.slice(0, 2).join(' -> ')}`); }
    }]));
  const filesA = { ...fs, async link(from, to) {
    await fs.link(from, to);
    if (to === claim) { aHolds = true; holding.resolve(); await resumeA.promise; }
  } };
  const b = take('B', filesB);
  await judged.promise;
  const a = take('A', filesA);
  await Promise.race([holding.promise, a.then(() => { throw new Error('A finished without pausing'); })]);
  const aClaim = await fs.readFile(claim, 'utf8');
  assert.equal(JSON.parse(aClaim).tag, 'A');
  resumeB.resolve();
  await assert.rejects(b, error => {
    assert.equal(error.code, 'LOCK_HELD');
    assert.ok(error.message.includes('recovery is already claimed'), error.message);
    return true;
  });
  assert.deepEqual(violations, []);
  assert.equal(await fs.readFile(claim, 'utf8'), aClaim);
  assert.equal(await fs.readFile(lockPath, 'utf8'), dead);
  aHolds = false;
  resumeA.resolve();
  const owner = await a;
  try {
    assert.equal(JSON.parse(await fs.readFile(lockPath, 'utf8')).tag, 'A');
    assert.deepEqual((await fs.readdir(root)).filter(name => name.includes('.recover-')), []);
  } finally {
    await owner.handle.close();
    await releaseOwnedLock({ lockPath, identity: owner.identity, tag: 'A' });
  }
});

test('a recovery guard left by a process that exited refuses the start and names the guard', async t => {
  const { root, lockPath, dead, claim, take } = await claimedDeadLock(t);
  const held = await fs.stat(claim, { bigint: true });
  const guard = `${claim}.recover-${held.dev}-${held.ino}`;
  await fs.writeFile(guard, dead);
  const contents = async () => Promise.all((await fs.readdir(root)).sort()
    .map(async name => [name, await fs.readFile(path.join(root, name), 'utf8')]));
  const before = await contents();
  await assert.rejects(take(), error => {
    assert.equal(error.code, 'LOCK_HELD');
    assert.ok(error.message.includes(guard), error.message);
    return true;
  });
  assert.deepEqual(await contents(), before);
  assert.equal(await fs.readFile(lockPath, 'utf8'), dead);
});

test('two concurrent recoveries of a dead lock and a dead claim never make two owners', async t => {
  for (let round = 0; round < 5; round++) {
    const { root, lockPath, recordType } = await claimedDeadLock(t);
    const take = tag => acquireLock({ lockPath, recordType, record: { type: recordType, pid: process.pid, tag },
      tag, isAlive: pid => pid === process.pid });
    const results = await Promise.allSettled([take('one'), take('two')]);
    const won = results.map((result, i) => [result, ['one', 'two'][i]]).filter(([result]) => result.status === 'fulfilled');
    for (const result of results) {
      if (result.status === 'rejected') assert.equal(result.reason.code, 'LOCK_HELD', result.reason.message);
    }
    assert.ok(won.length <= 1, `round ${round}: ${won.length} owners`);
    if (won.length === 1) {
      const [[{ value }, tag]] = won;
      try {
        assert.equal(JSON.parse(await fs.readFile(lockPath, 'utf8')).tag, tag);
        assert.deepEqual((await fs.readdir(root)).filter(name => name.includes('.recover-')), []);
      } finally {
        await value.handle.close();
        await releaseOwnedLock({ lockPath, identity: value.identity, tag });
      }
    }
  }
});

// A dead ring lock and a recoverer whose fs runs `before` once, just before it links the recovery claim.
async function deadLockWithClaimHook(t, before) {
  const root = await sandbox(t), lockPath = path.join(root, RING_LOCK_NAME), recordType = 'witchcraft-ring-v1';
  await fs.writeFile(lockPath, JSON.stringify({ type: recordType, pid: process.pid + 1, startedAt: new Date().toISOString() }));
  let fired = false;
  const files = { ...fs, async link(from, to) {
    if (!fired && to.startsWith(lockPath + '.recover-')) { fired = true; await before(lockPath); }
    return fs.link(from, to);
  } };
  const take = () => acquireLock({ lockPath, recordType, record: { type: recordType, pid: process.pid, tag: 'A' },
    tag: 'A', fs: files, isAlive: pid => pid === process.pid });
  return { root, lockPath, take, fired: () => fired };
}

test('a recoverer never sets aside a live lock that reuses the judged inode after a clean release', async t => {
  const live = JSON.stringify({ type: 'witchcraft-ring-v1', pid: process.pid, startedAt: new Date().toISOString(), tag: 'B' });
  // The dead owner's lock is released and B's new lock gets the same inode: an in-place rewrite keeps it.
  const { root, lockPath, take, fired } = await deadLockWithClaimHook(t, file => fs.writeFile(file, live));
  const judged = await fs.stat(lockPath, { bigint: true });
  await assert.rejects(take(), { code: 'LOCK_HELD' });
  assert.ok(fired());
  assert.equal((await fs.stat(lockPath, { bigint: true })).ino, judged.ino);
  assert.equal(await fs.readFile(lockPath, 'utf8'), live);
  assert.deepEqual((await fs.readdir(root)).filter(name => name.includes('.stale-') || name.includes('.recover-')), []);
});

test('a dead lock that vanishes before the recovery claim is taken on the retry', async t => {
  const { root, lockPath, take, fired } = await deadLockWithClaimHook(t, file => fs.unlink(file));
  const taken = await take();
  try {
    assert.ok(fired());
    assert.equal(JSON.parse(await fs.readFile(lockPath, 'utf8')).tag, 'A');
    assert.deepEqual(taken.reclaimed, []);
    assert.deepEqual((await fs.readdir(root)).filter(name => name.includes('.recover-')), []);
  } finally {
    await taken.handle.close();
    await releaseOwnedLock({ lockPath, identity: taken.identity, tag: 'A' });
  }
});

// A recoverer's fs that tracks the handles it opens on the lock and the recovery names, and an isAlive
// in which, once a link to a name matching `armAt` succeeds, the next dead owner judged exits while a
// live owner takes `target`. The live owner's file reuses the judged inode (an in-place rewrite) only
// while the recoverer has no handle open on `target`; while it has one, the new file is a new inode.
function ownerExitsDuringJudgment({ lockPath, target, live, armAt }) {
  const handles = new Map();
  let opened = 0, armed = false, fired = false;
  const files = { ...fs,
    async open(file, ...rest) {
      const handle = await fs.open(file, ...rest), name = String(file);
      if (name !== lockPath && !name.startsWith(`${lockPath}.recover-`)) return handle;
      opened++; handles.set(handle, name);
      const close = handle.close.bind(handle);
      handle.close = async () => { handles.delete(handle); return close(); };
      return handle;
    },
    async link(from, to) {
      await fs.link(from, to);
      if (armAt(String(to))) armed = true;
    } };
  const isAlive = pid => {
    if (pid === process.pid) return true;
    if (armed && !fired) {
      fired = true;
      if ([...handles.values()].includes(target)) unlinkSync(target);
      writeFileSync(target, live);
    }
    return false;
  };
  return { files, isAlive, fired: () => fired, opened: () => opened, open: () => [...handles.values()] };
}

test('an owner that exits during the judgment under the claim never gets its live successor set aside', async t => {
  const root = await sandbox(t), lockPath = path.join(root, RING_LOCK_NAME), recordType = 'witchcraft-ring-v1';
  await fs.writeFile(lockPath, JSON.stringify({ type: recordType, pid: process.pid + 1, startedAt: new Date().toISOString() }));
  const live = JSON.stringify({ type: recordType, pid: process.pid, startedAt: new Date().toISOString(), tag: 'B' });
  const model = ownerExitsDuringJudgment({ lockPath, target: lockPath, live, armAt: to => to.startsWith(`${lockPath}.recover-`) });
  await assert.rejects(acquireLock({ lockPath, recordType, record: { type: recordType, pid: process.pid, tag: 'A' },
    tag: 'A', fs: model.files, isAlive: model.isAlive }), { code: 'LOCK_HELD' });
  assert.ok(model.fired());
  assert.equal(await fs.readFile(lockPath, 'utf8'), live);
  const names = await fs.readdir(root);
  for (const name of names.filter(entry => entry.includes('.stale-'))) {
    assert.notEqual(await fs.readFile(path.join(root, name), 'utf8'), live, name);
  }
  assert.deepEqual(names.filter(name => name.includes('.recover-')), []);
  assert.ok(model.opened() > 0);
  assert.deepEqual(model.open(), []);
});

test('a claimer that exits during the judgment under the guard never gets its live successor unlinked', async t => {
  const { root, lockPath, recordType, dead, claim } = await claimedDeadLock(t);
  const live = JSON.stringify({ type: recordType, pid: process.pid, startedAt: new Date().toISOString(), tag: 'B' });
  const model = ownerExitsDuringJudgment({ lockPath, target: claim, live, armAt: to => to.startsWith(`${claim}.recover-`) });
  await assert.rejects(acquireLock({ lockPath, recordType, record: { type: recordType, pid: process.pid, tag: 'A' },
    tag: 'A', fs: model.files, isAlive: model.isAlive }), error => {
    assert.equal(error.code, 'LOCK_HELD');
    assert.ok(error.message.includes('recovery is already claimed') && error.message.includes(claim), error.message);
    return true;
  });
  assert.ok(model.fired());
  assert.equal(await fs.readFile(claim, 'utf8'), live);
  assert.equal(await fs.readFile(lockPath, 'utf8'), dead);
  assert.deepEqual((await fs.readdir(root)).filter(name => name.includes('.recover-')), [path.basename(claim)]);
  assert.ok(model.opened() > 0);
  assert.deepEqual(model.open(), []);
});

test('a recovery of a dead claim and a dead lock holds each judged file open until it has acted on it, then closes every handle', async t => {
  const { lockPath, dead, claim, take } = await claimedDeadLock(t);
  const model = ownerExitsDuringJudgment({ lockPath, target: lockPath, live: '', armAt: () => false });
  // The handles open at the moment of each action on a judged file: closing one earlier would
  // free its inode for a newer owner's file before the action.
  const held = {};
  const files = { ...model.files,
    async unlink(file) { if (file === claim) held.unlink ??= model.open(); return fs.unlink(file); },
    async rename(from, to) { if (from === lockPath) held.rename ??= model.open(); return fs.rename(from, to); },
    async stat(file, ...rest) { if (String(file).includes('.stale-')) held.check ??= model.open(); return fs.stat(file, ...rest); } };
  const taken = await take(files);
  try {
    assert.deepEqual(held, { unlink: [claim], rename: [lockPath], check: [lockPath] });
    assert.equal(taken.reclaimed.length, 1);
    assert.equal(await fs.readFile(taken.reclaimed[0].path, 'utf8'), dead);
    assert.equal(model.opened(), 4);
    assert.deepEqual(model.open(), []);
  } finally {
    await taken.handle.close();
    await releaseOwnedLock({ lockPath, identity: taken.identity, tag: 'next' });
  }
});
