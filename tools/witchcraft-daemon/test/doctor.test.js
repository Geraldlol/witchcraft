import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runDoctor } from '../src/doctor.js';
import { initializeRing } from '../src/init.js';
import { ContextCache } from '../src/context-cache.js';

const source = fileURLToPath(new URL('../', import.meta.url));
const check = (report, id) => report.checks.find(row => row.id === id);
const json = (file, value) => fs.writeFile(file, JSON.stringify(value));
const account = 'PRIVATE-DOCTOR-ACCOUNT';

async function setup(t) {
  const temp = await fs.realpath(os.tmpdir());
  const repoRoot = await fs.mkdtemp(path.join(temp, 'witchcraft-doctor-'));
  t.after(async () => {
    const resolved = await fs.realpath(repoRoot);
    assert.equal(path.dirname(resolved), temp);
    assert.match(path.basename(resolved), /^witchcraft-doctor-/u);
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const daemon = path.join(repoRoot, 'tools', 'witchcraft-daemon');
  const localDir = path.join(daemon, '.local');
  const client = path.join(repoRoot, '_forever_');
  const addonsDir = path.join(client, 'Interface', 'AddOns');
  const local = { account, ringSize: 5, commands: { codex: { file: process.execPath, args: [] } } };
  await Promise.all([localDir, path.join(addonsDir, 'Witchcraft'), path.join(client, 'WTF', 'Account', account)]
    .map(dir => fs.mkdir(dir, { recursive: true })));
  await Promise.all([
    json(path.join(daemon, 'package.json'), { type: 'module', version: '1.2.3' }),
    json(path.join(repoRoot, 'wow.config.json'), { addonsDir }),
    json(path.join(localDir, 'config.json'), local),
    fs.writeFile(path.join(addonsDir, 'Witchcraft', 'Witchcraft.toc'), '## Version: 1.2.3\n'),
  ]);
  await initializeRing({ addonsDir, ringSize: local.ringSize });
  const diagnose = (overrides = {}) => runDoctor({ repoRoot, localDir, options: { only: 'codex' }, ...overrides });
  return { repoRoot, daemon, localDir, addonsDir, local, diagnose };
}

test('the CLI reports missing dependencies and redacts malformed config in a clean source tree', async t => {
  const f = await setup(t);
  for (const dir of ['src', 'bin']) await fs.cp(path.join(source, dir), path.join(f.daemon, dir), { recursive: true });
  const args = [path.join(f.daemon, 'bin', 'witchcraft.js'), 'doctor', '--json', '--only', 'codex'];
  const run = () => promisify(execFile)(process.execPath, args, { cwd: f.daemon });
  await fs.writeFile(path.join(f.repoRoot, 'wow.config.json'), account + ' invalid JSON');
  await assert.rejects(run(), error => {
    assert.equal(error.code, 1);
    const report = JSON.parse(error.stdout);
    assert.equal(check(report, 'dependencies').status, 'fail');
    assert.equal(check(report, 'client').status, 'fail');
    assert.ok(!error.stdout.includes(account) && !error.stdout.includes(path.basename(f.repoRoot)));
    assert.equal(error.stderr, '');
    return true;
  });
  await json(path.join(f.repoRoot, 'wow.config.json'), { addonsDir: f.addonsDir });
  // Resolve the already installed dependencies without launching an assistant or touching its files.
  const link = path.join(f.daemon, 'node_modules');
  await fs.symlink(path.join(source, 'node_modules'), link, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    const { stdout } = await run();
    const report = JSON.parse(stdout);
    assert.equal(check(report, 'dependencies').status, 'ok');
    assert.equal(check(report, 'daemon').status, 'wait');
    assert.ok(!stdout.includes(account) && !stdout.includes(path.basename(f.repoRoot)));
  } finally { await fs.unlink(link); }
});

test('only the selected assistant is checked and calibration is optional', async t => {
  const f = await setup(t);
  const initial = await f.diagnose();
  assert.equal(check(initial, 'codex').status, 'ok');
  assert.equal(check(initial, 'claude'), undefined);
  assert.equal(check(initial, 'copilot'), undefined);
  assert.equal(check(initial, 'calibration').status, 'info');
  assert.equal(check(initial, 'ring').detail, '5/5 expected helper slots verified.');
  await json(path.join(f.localDir, 'config.json'), { ...f.local, commands: { codex: null }, region: { x: 0, y: 0 } });
  const disabled = await f.diagnose();
  assert.equal(check(disabled, 'assistants').status, 'fail');
  assert.equal(check(disabled, 'calibration').status, 'ok');
  const attached = await f.diagnose({ options: { only: 'codex', attach: { codex: { pid: 123 } } } });
  assert.equal(check(attached, 'codex').status, 'info');
});

test('missing or damaged slots in the middle of the ring count as failures', async t => {
  const f = await setup(t);
  const middle = path.join(f.addonsDir, 'Witchcraft_Chunk_0003');
  await fs.unlink(path.join(middle, 'Chunk.lua'));
  const predecessor = 'Witchcraft_Chunk_0002';
  const toc = path.join(f.addonsDir, predecessor, predecessor + '.toc');
  await fs.writeFile(toc, (await fs.readFile(toc, 'utf8')).replace('Chunk.lua', 'Missing.lua'));
  const report = await f.diagnose();
  assert.equal(check(report, 'ring').status, 'fail');
  assert.match(check(report, 'ring').detail, /3\/5/u);
  assert.match(check(report, 'ring').next, /Witchcraft_Chunk_0002/u);
});

test('heartbeat and probe acknowledgements must belong to the live daemon and current UI', async t => {
  const f = await setup(t);
  const now = Date.now(), epoch = 'aaaaaaaa', ui = 'bbbbbbbb';
  const cache = new ContextCache({ epoch });
  cache.setSession(epoch, ui);
  await json(path.join(f.localDir, 'bridge.lock'), { epoch, pid: process.pid, startedAt: new Date(now - 60000).toISOString() });
  const diagnose = () => f.diagnose({ now: () => now });
  const store = async time => {
    cache.heartbeat(time);
    await json(path.join(f.localDir, 'wow-context.json'), cache.snapshot(time));
  };
  const trace = path.join(f.localDir, 'trace.log');
  const probe = (at, overrides = {}) => JSON.stringify({ what: 'binding-probe-ack', epoch, ui, at: new Date(at).toISOString(), ...overrides });
  await store(now - 31000);
  assert.equal(check(await diagnose(), 'heartbeat').status, 'wait');
  await store(now);
  await fs.writeFile(trace, [probe(now, { epoch: 'dddddddd' }), probe(now, { ui: 'eeeeeeee' }),
    probe(now - 70000), probe(now + 60000), 'null'].join('\n'));
  const current = await diagnose();
  assert.equal(check(current, 'heartbeat').status, 'ok');
  assert.equal(check(current, 'binding').status, 'wait');
  await fs.writeFile(trace + '.1', probe(now - 1500));
  const report = await diagnose();
  assert.equal(check(report, 'binding').status, 'ok');
  assert.match(check(report, 'binding').detail, /1s ago/u);
  assert.ok(!JSON.stringify(report).includes(epoch) && !JSON.stringify(report).includes(ui));
});

test('a live holder of the client ring lock gets wait advice instead of a start', async t => {
  const f = await setup(t);
  const lockPath = path.join(f.addonsDir, '.witchcraft-ring.lock');
  const record = (pid, type = 'witchcraft-ring-v1') => ({ type, pid, startedAt: new Date().toISOString(), operation: 'run' });
  const diagnose = () => f.diagnose({ isAlive: pid => pid === 4242 });
  await json(lockPath, record(4242));
  const lockBytes = await fs.readFile(lockPath, 'utf8');
  const held = await diagnose();
  assert.equal(await fs.readFile(lockPath, 'utf8'), lockBytes, 'the ring lock is only read');
  assert.equal(check(held, 'daemon').status, 'wait');
  assert.equal(check(held, 'daemon').detail, "Another process holds this client's ring lock (pid 4242).");
  assert.equal(check(held, 'daemon').next, "Stop the other installation's witchcraft run, or wait for its init to finish, then start here.");
  assert.doesNotMatch(JSON.stringify(held), /Start witchcraft run/u);
  assert.ok(!JSON.stringify(held).includes(path.basename(f.repoRoot)));
  const unchanged = async label => {
    const report = await diagnose();
    assert.equal(check(report, 'daemon').detail, 'No live daemon observed for this installation.', label);
    assert.equal(check(report, 'daemon').next, 'Start witchcraft run with your chosen assistant.', label);
  };
  await json(lockPath, record(999)); await unchanged('dead pid');
  await json(lockPath, record(4242, 'other')); await unchanged('foreign record type');
  await fs.rm(lockPath); await fs.mkdir(lockPath); await unchanged('unreadable lock');
  await fs.rm(lockPath, { recursive: true }); await unchanged('no lock');
});
