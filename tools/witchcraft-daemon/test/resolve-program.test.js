import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveProgram, taskkillPath } from '../src/pty.js';

test('resolveProgram ignores empty and relative PATH entries instead of resolving them against the cwd', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'witchcraft-resolve-'));
  const planted = path.join(root, 'planted'), real = path.join(root, 'real');
  fs.mkdirSync(path.join(planted, 'bin'), { recursive: true });
  fs.mkdirSync(real);
  fs.writeFileSync(path.join(planted, 'fam-agent.exe'), '');
  fs.writeFileSync(path.join(planted, 'bin', 'fam-agent.exe'), '');
  fs.writeFileSync(path.join(real, 'fam-agent.exe'), '', { mode: 0o755 });
  const cwd = process.cwd(), oldPath = process.env.PATH;
  t.after(() => { process.chdir(cwd); process.env.PATH = oldPath; fs.rmSync(root, { recursive: true, force: true }); });
  process.chdir(planted);
  process.env.PATH = ['', '.', 'bin', real].join(path.delimiter);
  assert.equal(resolveProgram('fam-agent.exe'), path.join(real, 'fam-agent.exe'));
});

test('resolveProgram skips a file on PATH that lacks the execute bit', { skip: process.platform === 'win32' && 'POSIX execute bits only' }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'witchcraft-resolve-'));
  const plain = path.join(root, 'plain'), runnable = path.join(root, 'runnable');
  fs.mkdirSync(plain); fs.mkdirSync(runnable);
  fs.writeFileSync(path.join(plain, 'fam-agent'), '', { mode: 0o644 });
  fs.chmodSync(path.join(plain, 'fam-agent'), 0o644);
  fs.writeFileSync(path.join(runnable, 'fam-agent'), '', { mode: 0o755 });
  fs.chmodSync(path.join(runnable, 'fam-agent'), 0o755);
  const oldPath = process.env.PATH;
  t.after(() => { process.env.PATH = oldPath; fs.rmSync(root, { recursive: true, force: true }); });
  process.env.PATH = [plain, runnable].join(path.delimiter);
  assert.equal(resolveProgram('fam-agent'), path.join(runnable, 'fam-agent'));
  process.env.PATH = plain;
  assert.throws(() => resolveProgram('fam-agent'), /Cannot find executable/u);
});

// The Store's PowerShell 7 is reached through an app-execution alias under WindowsApps: a
// reparse point that stat refuses with EACCES. The daemon still has to find pwsh there.
const windowsApps = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps') : null;
const storeAlias = (() => {
  if (process.platform !== 'win32' || !windowsApps) return null;
  try { fs.statSync(path.join(windowsApps, 'pwsh.exe')); return null; } catch (error) { return error.code === 'EACCES' ? path.join(windowsApps, 'pwsh.exe') : null; }
})();

test('resolveProgram takes a Store app-execution alias that stat refuses but Windows can launch', { skip: !storeAlias && 'no Store pwsh alias on this machine' }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'witchcraft-alias-'));
  fs.writeFileSync(path.join(root, 'pwsh.cmd'), '');
  const oldPath = process.env.PATH;
  t.after(() => { process.env.PATH = oldPath; fs.rmSync(root, { recursive: true, force: true }); });
  process.env.PATH = [root, windowsApps].join(path.delimiter);
  assert.equal(resolveProgram('pwsh'), storeAlias, 'the alias, not the batch file beside it on PATH');
  assert.throws(() => resolveProgram('pwsh.cmd'), /Cannot find executable/, 'a batch file that exists is still refused');
});

test('forced shutdown uses the absolute System32 taskkill, never a PATH or cwd lookup', { skip: process.platform !== 'win32' }, () => {
  const resolved = taskkillPath();
  assert.ok(path.isAbsolute(resolved));
  assert.equal(resolved.toLowerCase(), path.join(process.env.SystemRoot, 'System32', 'taskkill.exe').toLowerCase());
  assert.ok(fs.statSync(resolved).isFile());
});
