import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
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
