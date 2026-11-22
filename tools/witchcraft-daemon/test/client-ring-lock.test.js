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
