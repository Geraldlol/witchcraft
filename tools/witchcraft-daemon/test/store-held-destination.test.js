import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readLootGoals, setLootGoal } from '../src/loot-goals.js';
import { stampPassport, readPassport } from '../src/passport-store.js';
import { resolveProgram } from '../src/pty.js';

// Holds `file` open without delete sharing (as an editor or scanner can), which makes a
// rename-over fail with EPERM on Windows until the handle is released.
async function holdBriefly(file, ms) {
  const script = `$h = [IO.File]::Open('${file.replaceAll("'", "''")}', 'Open', 'Read', 'Read'); [Console]::Out.WriteLine('held'); Start-Sleep -Milliseconds ${ms}; $h.Close()`;
  const child = spawn(resolveProgram('pwsh'), ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); });
  return { released: new Promise(resolve => child.once("exit", resolve)) };
}

test('goal and passport saves retry while the destination is briefly held open', { skip: process.platform !== 'win32' }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'witchcraft-store-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const goals = path.join(dir, 'ctx.loot-goals.json'), passport = path.join(dir, 'ctx.passport.json');
  await setLootGoal(goals, { itemId: 1, status: 'active' });
  await stampPassport(passport, { kind: "dungeon", referenceId: "deadmines", title: "The Deadmines", status: "complete" });
  const { released } = await holdBriefly(goals, 800);
  await setLootGoal(goals, { itemId: 2, status: 'active' });
  await released;
  assert.deepEqual((await readLootGoals(goals)).goals.map(goal => goal.itemId), [1, 2]);
  {
    const { released: releasedPassport } = await holdBriefly(passport, 800);
    await stampPassport(passport, { kind: 'dungeon', referenceId: 'deadmines', title: 'The Deadmines', status: "complete", note: "second" });
    await releasedPassport;
    assert.equal((await readPassport(passport)).entries[0].note, 'second');
  }
});
