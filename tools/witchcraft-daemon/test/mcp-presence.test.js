import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { announcePresence, hasWoWTools, livePresences, presenceDir } from '../src/mcp-presence.js';

const SCRIPT = fileURLToPath(new URL('../bin/witchcraft-mcp.js', import.meta.url));
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function scratch(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'witchcraft-presence-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
async function until(predicate, label, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await sleep(20); }
  throw new Error(`${label} timed out`);
}

// A Claude session loads its MCP servers when it starts, so its config cannot say whether the
// running session has the WoW tools. The server itself can: it records which process started it.
test('a running WoW MCP server records the client that started it, and withdraws when that client lets go', async t => {
  const root = await scratch(t), cache = path.join(root, 'wow-context.json');
  const server = childProcess.spawn(process.execPath, [SCRIPT, '--cache', cache], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { try { server.kill(); } catch { /* already gone */ } });
  const file = path.join(presenceDir(cache), `${server.pid}.json`);
  const record = await until(async () => JSON.parse(await fs.readFile(file, 'utf8').catch(() => 'null')), 'Presence');
  assert.equal(record.pid, server.pid);
  assert.equal(record.ppid, process.pid, 'the client that started the server is its parent');
  assert.equal(await hasWoWTools(presenceDir(cache), process.pid), true);
  const exited = new Promise(resolve => server.on('exit', resolve));
  server.stdin.end();
  await exited;
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  assert.equal(await hasWoWTools(presenceDir(cache), process.pid), false);
});

test('a presence record survives a scanner holding the new file: the rename is retried, then written directly', async t => {
  // Windows refuses to rename a file another process (antivirus, an indexer) has just opened.
  const busy = () => Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
  for (const failures of [2, Infinity]) {
    const dir = path.join(await scratch(t), 'mcp-clients');
    let attempts = 0;
    const files = { ...fsSync, renameSync: (from, to) => { if (attempts++ < failures) throw busy(); return fsSync.renameSync(from, to); } };
    const withdraw = announcePresence(dir, { pid: 4321, ppid: 99, now: 5, files });
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, '4321.json'), 'utf8')), { pid: 4321, ppid: 99, startedAt: 5 });
    assert.deepEqual(await fs.readdir(dir), ['4321.json'], 'no temporary name is left behind');
    withdraw();
    assert.deepEqual(await fs.readdir(dir), []);
  }
});

test('only live servers count, a dead one\'s record is cleared, and unknown files are left alone', async t => {
  const dir = path.join(await scratch(t), 'mcp-clients');
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, '111.json'), JSON.stringify({ pid: 111, ppid: 900, startedAt: 1 }));
  await fs.writeFile(path.join(dir, '222.json'), JSON.stringify({ pid: 222, ppid: 900, startedAt: 2 }));
  await fs.writeFile(path.join(dir, 'notes.json'), 'not a record');
  const isAlive = pid => pid === 222;
  assert.deepEqual((await livePresences(dir, { isAlive })).map(record => record.pid), [222]);
  await assert.rejects(fs.stat(path.join(dir, '111.json')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(dir, 'notes.json'), 'utf8'), 'not a record');
  assert.equal(await hasWoWTools(dir, 900, { isAlive }), true);
  assert.equal(await hasWoWTools(dir, 901, { isAlive }), false, 'another process\'s server is not this client\'s');
  assert.equal(await hasWoWTools(path.join(dir, 'missing'), 900), false, 'no records means no server');
});
