import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { claudeSessionAlive, findClaudeSession, findCodexThread } from '../src/current-sessions.js';

async function temp(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'witchcraft-current-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
const repo = 'E:\\Projects\\Personal\\WoW Addons';

test('a joined Claude session is still live only while its own record names it and its process runs', async t => {
  // A pid alone can be reused by any process after Claude exits; its record is what names a session.
  const dir = await temp(t);
  await fs.writeFile(path.join(dir, '21.json'), JSON.stringify({ pid: 21, kind: 'interactive', cwd: repo, startedAt: 1 }));
  await fs.writeFile(path.join(dir, '22.json'), JSON.stringify({ pid: 22, kind: 'interactive', cwd: 'C:\\elsewhere', startedAt: 1 }));
  const isAlive = pid => pid !== 23;
  assert.equal(await claudeSessionAlive(21, { cwd: repo, dir, isAlive }), true);
  assert.equal(await claudeSessionAlive(21, { cwd: repo, dir, isAlive: () => false }), false, 'its process has exited');
  assert.equal(await claudeSessionAlive(22, { cwd: repo, dir, isAlive }), false, 'a session in another folder');
  assert.equal(await claudeSessionAlive(24, { cwd: repo, dir, isAlive }), false, 'no record: the pid is no longer a Claude session');
});

test('the newest live interactive Claude session in the folder is chosen', async t => {
  const dir = await temp(t);
  const write = (pid, record) => fs.writeFile(path.join(dir, `${pid}.json`), JSON.stringify({ pid, kind: 'interactive', ...record }));
  await write(11, { cwd: repo, startedAt: 100, sessionId: 'older' });
  await write(12, { cwd: 'e:\\projects\\personal\\wow addons\\', startedAt: 200, sessionId: 'newest' });
  await write(13, { cwd: repo, startedAt: 300, sessionId: 'dead' });
  await write(14, { cwd: 'C:\\elsewhere', startedAt: 400 });
  await write(15, { cwd: repo, startedAt: 500, kind: 'sdk' });
  await fs.writeFile(path.join(dir, '16.json'), '{ not json');
  await fs.writeFile(path.join(dir, '12.abc.key'), 'ignored');
  const isAlive = pid => pid !== 13;
  assert.deepEqual(await findClaudeSession({ cwd: repo, dir, isAlive }), { pid: 12, sessionId: 'newest', startedAt: 200 },
    'case and a trailing separator do not hide the folder; dead, other-folder and non-interactive records are skipped');
  assert.equal(await findClaudeSession({ cwd: 'C:\\nowhere', dir, isAlive }), undefined);
  assert.equal(await findClaudeSession({ cwd: repo, dir: path.join(dir, 'missing') }), undefined);
});

test('the most recently written top-level Codex thread in the folder is chosen', async t => {
  const root = await temp(t);
  const day = path.join(root, '2026', '09', '23');
  await fs.mkdir(day, { recursive: true });
  let clock = Date.parse('2026-09-23T10:00:00Z') / 1000;
  const rollout = async (id, payload, extra = '') => {
    const file = path.join(day, `rollout-2026-09-23T10-00-00-${id}.jsonl`);
    await fs.writeFile(file, JSON.stringify({ type: 'session_meta', payload: { id, ...payload, note: extra } }) + '\n{"type":"event"}\n');
    clock += 60; await fs.utimes(file, clock, clock);
  };
  const id = n => `01a0cd0c-b928-77f2-993d-02${String(n).padStart(10, '0')}`;
  // Oldest to newest by write time; only the second is a top-level thread in this folder.
  await rollout(id(1), { cwd: repo, source: 'cli' });
  await rollout(id(2), { cwd: 'e:\\Projects\\Personal\\WoW Addons', source: 'vscode' }, 'x'.repeat(200000));
  await rollout(id(3), { cwd: repo, source: { subagent: { other: 'guardian' } } });
  await rollout(id(4), { cwd: repo, source: 'exec' });
  await rollout(id(5), { cwd: 'C:\\elsewhere', source: 'vscode' });
  await fs.writeFile(path.join(day, 'rollout-broken.jsonl'), '{"type":');
  const found = await findCodexThread({ cwd: repo, root });
  assert.equal(found.id, id(2), 'a long metadata line, lowercase drive and newer subagent/exec/other threads do not hide it');
  assert.equal(found.source, 'vscode');
  assert.equal(await findCodexThread({ cwd: 'C:\\nowhere', root }), undefined);
  assert.equal(await findCodexThread({ cwd: repo, root: path.join(root, 'missing') }), undefined);
});
