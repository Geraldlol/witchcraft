import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { ContextCache } from '../src/context-cache.js';

const packageDir = fileURLToPath(new URL('../', import.meta.url));
const npmCli = process.env.npm_execpath;
assert.ok(npmCli && path.isAbsolute(npmCli), 'Run npm run test:package from the daemon source directory');
const { values } = parseArgs({ options: { 'pack-destination': { type: 'string' } } });

function npm(args, cwd, env = process.env) {
  return execFileSync(process.execPath, [npmCli, ...args], {
    cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], timeout: 240_000,
  }).trim();
}

async function checkMcp(command, args, cwd, env, version, writes) {
  const client = new Client({ name: 'packed-client', version: '1.0.0' });
  const transport = new StdioClientTransport({ command, args, cwd, env, stderr: 'inherit' });
  try {
    await client.connect(transport);
    assert.deepEqual(client.getServerVersion(), { name: 'witchcraft-wow', version });
    const { tools } = await client.listTools();
    assert.ok(tools.some(tool => tool.name === 'wow_find_guide'));
    assert.equal(tools.some(tool => tool.name === 'wow_set_loot_goal'), writes);
    const result = await client.readResource({ uri: 'wow://context' });
    assert.equal(JSON.parse(result.contents[0].text).session?.epoch, 'abcd0001', 'MCP must share daemon state');
  } finally {
    await client.close();
  }
}

const temporaryRoot = await realpath(os.tmpdir());
const scratch = await mkdtemp(path.join(temporaryRoot, 'witchcraft-package-'));
try {
  const [pack] = JSON.parse(npm(['pack', '--json', '--pack-destination', scratch], packageDir));
  const archive = path.join(scratch, pack.filename);
  const tarball = pathToFileURL(archive).href;
  const shipped = pack.files.map(file => file.path);
  const runtime = ['bin', 'capture/*.py', 'capture/*.ps1', 'console/*.ps1', 'data/*.json', 'overlay', 'src'];
  const expected = execFileSync('git', ['ls-files', '--', ...runtime], { cwd: packageDir, encoding: 'utf8' })
    .trim().split(/\r?\n/u);
  assert.deepEqual(shipped.sort(), [...expected, 'LICENSE', 'README.md', 'package.json'].sort(),
    'The tarball must include every tracked runtime resource and only public package files');

  const project = path.join(scratch, 'consumer project');
  const home = path.join(scratch, 'fake home');
  const state = path.join(scratch, 'persistent state');
  const game = path.join(scratch, 'fake game');
  const addons = path.join(game, 'Interface', 'AddOns');
  const addon = path.join(addons, 'Witchcraft');
  for (const dir of [project, home, addon, path.join(game, 'WTF', 'Account', 'Fixture')]) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(path.join(addon, 'Witchcraft.toc'), `## Version: ${pack.version}\n`);
  const env = { ...process.env, HOME: home, USERPROFILE: home, WITCHCRAFT_HOME: state,
    npm_config_cache: npm(['config', 'get', 'cache'], packageDir),
    npm_config_audit: 'false', npm_config_fund: 'false' };
  delete env.NODE_PATH;
  const run = (...args) => npm(['exec', '--yes', '--', tarball, ...args], project, env);

  // Positional tarball syntax uses npm's own bin inference, just like npx witchcraft-daemon.
  assert.match(run('help'), /witchcraft init/u);
  const defaultHomeEnv = { ...env };
  delete defaultHomeEnv.WITCHCRAFT_HOME;
  npm(['exec', '--yes', '--', tarball, 'configure', '--addons-dir', addons], project, defaultHomeEnv);
  assert.equal(JSON.parse(await readFile(path.join(home, '.witchcraft', 'wow.config.json'))).addonsDir, addons);
  run('configure', '--addons-dir', addons);
  assert.equal(JSON.parse(await readFile(path.join(state, 'wow.config.json'))).addonsDir, addons);
  run('init', '--ring', '3');

  // Doctor locates an executable without starting an assistant or touching a real WoW account.
  const preferences = path.join(state, 'config.json');
  const config = JSON.parse(await readFile(preferences));
  await writeFile(preferences, JSON.stringify({ ...config, commands: { codex: { file: process.execPath, args: [] } } }));
  const doctor = JSON.parse(run('doctor', '--only', 'codex', '--json'));
  for (const id of ['dependencies', 'client', 'addon', 'ring', 'codex']) {
    assert.equal(doctor.checks.find(c => c.id === id)?.status, 'ok', JSON.stringify(doctor));
  }
  const registration = run('mcp-setup');
  assert.ok(registration.includes(project), 'MCP registration must use the consumer project by default');
  assert.ok(registration.includes(state), 'Persistent registration must use the shared state directory');
  assert.ok(registration.includes(`witchcraft-daemon@${pack.version}`), 'MCP registration must pin the installed version');
  assert.ok(!registration.includes('_npx'), 'Persistent registration must survive npm cache eviction');

  const context = new ContextCache();
  context.setSession('abcd0001', 'abcd0002');
  context.disconnect();
  await writeFile(path.join(state, 'wow-context.json'), JSON.stringify(context.snapshot()));
  await checkMcp(process.execPath, [npmCli, 'exec', '--yes', '--package', tarball, '--', 'witchcraft-mcp'],
    project, env, pack.version, false);

  // Capture the same registration argv a real --apply would pass to Claude, without starting an assistant.
  const install = path.join(scratch, 'temporary install');
  await mkdir(install);
  npm(['install', '--prefix', install, '--no-save', '--package-lock=false', tarball], install, env);
  const module = path.join(install, 'node_modules', pack.name, 'src', 'mcp-launch.js');
  assert.throws(() => createRequire(module).resolve('electron'), { code: 'MODULE_NOT_FOUND' });
  const { setupClaudeMcp } = await import(pathToFileURL(module).href);
  const calls = [];
  await setupClaudeMcp({ apply: true, repoRoot: project, cachePath: path.join(state, 'wow-context.json'), npmCli,
    print() {}, existing: async () => undefined, run: (...args) => calls.push(args) });
  assert.equal(calls.length, 1);
  const [[claude, registrationArgs, options]] = calls;
  assert.equal(claude, 'claude');
  assert.deepEqual(options, { cwd: project });
  assert.deepEqual(registrationArgs.slice(0, 6), ['mcp', 'add', '-s', 'local', 'witchcraft_wow', '--']);
  const [command, ...args] = registrationArgs.slice(6);
  const persistentEnv = { ...env, npm_config_offline: 'true' };
  delete persistentEnv.WITCHCRAFT_HOME;
  // A surviving install already has the dependencies, even if npm's cache is empty.
  await checkMcp(command, args, project, { ...persistentEnv, npm_config_cache: path.join(scratch, 'empty npm cache') },
    pack.version, true);
  await rm(install, { recursive: true, force: true });
  await checkMcp(command, args, project, persistentEnv, pack.version, true);

  assert.deepEqual(await readdir(project), [], 'Running from a consumer project must leave it untouched');
  const bytes = await readFile(archive);
  assert.equal(`sha512-${createHash('sha512').update(bytes).digest('base64')}`, pack.integrity);
  if (values['pack-destination']) {
    const destination = path.resolve(values['pack-destination']);
    await mkdir(destination, { recursive: true });
    const retained = path.join(destination, pack.filename);
    await writeFile(retained, bytes);
    console.log(`Saved tested npm tarball to ${retained}`);
  }
  console.log(`Verified ${pack.filename} (${pack.integrity}) via npm exec on ${process.platform}`);
} finally {
  assert.equal(path.dirname(scratch), temporaryRoot);
  await rm(scratch, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
}
