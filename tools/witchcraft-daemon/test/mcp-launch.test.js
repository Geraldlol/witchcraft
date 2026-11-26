import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import manifest from '../package.json' with { type: 'json' };
import { localRegistration, setupClaudeMcp, withWoWMcp } from '../src/mcp-launch.js';
import { parseArgs } from '../bin/witchcraft.js';

const paths = { cachePath: path.resolve('a folder', 'cache.json'), nodePath: process.execPath,
  scriptPath: path.resolve('a folder', 'witchcraft-mcp.js') };

test('MCP launch: distinct Claude/Codex configuration preserves original arguments', () => {
  const original = { file: 'claude', args: ['--continue'] };
  const claude = withWoWMcp('claude', original, paths);
  const config = JSON.parse(claude.args[claude.args.indexOf('--mcp-config') + 1]).mcpServers.witchcraft_wow;
  assert.equal(config.command, process.execPath);
  // The daemon grants the local wishlist/passport writes explicitly; the MCP binary defaults to read-only.
  assert.deepEqual(config.args, [paths.scriptPath, '--cache', paths.cachePath, '--allow-local-writes']);
  assert.deepEqual(original.args, ['--continue']);
  assert.ok(claude.args.includes('--continue'));
  const codex = withWoWMcp('codex', { file: 'codex.exe', args: ['resume', '--last'] }, paths);
  assert.deepEqual(codex.args.slice(-2), ['resume', '--last']);
  assert.equal(codex.args[1], `mcp_servers.witchcraft_wow.command=${JSON.stringify(process.execPath)}`);
  assert.deepEqual(JSON.parse(codex.args[3].split('=').slice(1).join('=')), config.args);
});

test('MCP launch: arbitrary terminal commands are unchanged; opt-out is explicit', () => {
  const shell = { file: 'powershell.exe', args: ['-NoProfile'] };
  assert.equal(withWoWMcp('claude', shell, paths), shell);
  assert.equal(withWoWMcp('claude', null, paths), null);
  assert.equal(parseArgs(['run', '--no-mcp']).options.noMcp, true);
  assert.equal(parseArgs(['run', '--no-overlay']).options.noOverlay, true);
  assert.equal(parseArgs(['run', '--overlay']).options.overlay, true);
  assert.equal(parseArgs(['run', '--pixels']).options.pixels, true);
  assert.equal(parseArgs(['run', '--no-pixels']).options.noPixels, true);
  assert.throws(() => withWoWMcp('codex', { file: 'codex' }, { ...paths, cachePath: 'relative.json' }), /absolute/u);
});

test('CLI: --character names the cooldown carrier character and still rejects unknown options', () => {
  assert.equal(parseArgs(['run', '--character', 'Testchar-Testrealm']).options.character, 'Testchar-Testrealm');
  assert.equal(parseArgs(['run', '--account', 'one', '--character', 'Testchar']).options.account, 'one');
  assert.throws(() => parseArgs(['run', '--character']), /incomplete/u);
  assert.throws(() => parseArgs(['run', '--charcter', 'Testchar']), /Unknown/u);
});

// The joined Claude tab mirrors a session the player started, which no launcher configured.
const repoRoot = path.resolve('Some Repo');
const spaced = {
  repoRoot,
  cachePath: path.join(repoRoot, 'daemon', '.local', 'wow-context.json'),
  nodePath: path.resolve('Program Files', 'nodejs', 'node'),
  scriptPath: path.join(repoRoot, 'daemon', 'bin', 'witchcraft-mcp.js'),
};

test('mcp-setup prints the local registration for this checkout and changes nothing by itself', async () => {
  const printed = [], ran = [];
  const result = await setupClaudeMcp({ ...spaced, print: line => printed.push(line), run: (...call) => { ran.push(call); } });
  assert.equal(ran.length, 0, 'without --apply nothing is run');
  assert.equal(result.applied, false);
  assert.ok(printed.includes(`  claude mcp add -s local witchcraft_wow -- "${spaced.nodePath}" "${spaced.scriptPath}" --cache "${spaced.cachePath}" --allow-local-writes`),
    printed.join('\n'));
  assert.ok(printed.some(line => line.includes(`run this once in ${repoRoot}:`)), 'it says which folder to run it in');
});

test('mcp-setup --apply on an identical registration only says to restart, instead of failing as a duplicate', async () => {
  // claude mcp add refuses a name that already exists; the player already registered this exact server.
  const printed = [], ran = [];
  const existing = { type: 'stdio', command: spaced.nodePath, args: [spaced.scriptPath, '--cache', spaced.cachePath, '--allow-local-writes'] };
  const result = await setupClaudeMcp({ ...spaced, apply: true, existing: async () => existing,
    print: line => printed.push(line), run: (...call) => { ran.push(call); } });
  assert.equal(ran.length, 0);
  assert.equal(result.already, true);
  assert.match(printed.join('\n'), /already registered/u);
  assert.match(printed.join('\n'), /restart/u);
});

test('mcp-setup --apply refuses to stack on a different witchcraft_wow registration and says how to replace it', async () => {
  const ran = [];
  const stale = { type: 'stdio', command: spaced.nodePath, args: [path.resolve('old checkout', 'bin', 'witchcraft-mcp.js')] };
  await assert.rejects(setupClaudeMcp({ ...spaced, apply: true, existing: async () => stale, print: () => {}, run: (...call) => { ran.push(call); } }),
    /claude mcp remove -s local witchcraft_wow/u);
  assert.equal(ran.length, 0);
});

test('the registration is looked up for the folder it applies to, however the path is spelled', async () => {
  const config = { projects: { 'E:/Some Repo': { mcpServers: { witchcraft_wow: { command: 'node' } } }, 'E:/Other': { mcpServers: {} } } };
  assert.deepEqual(localRegistration(config, 'e:\\some repo\\'), { command: 'node' });
  assert.equal(localRegistration(config, 'E:\\Other'), undefined);
  assert.equal(localRegistration({}, 'E:\\Some Repo'), undefined);
});

test('mcp-setup --apply runs exactly that registration in the repo root, without a shell', async () => {
  const ran = [];
  const result = await setupClaudeMcp({ ...spaced, apply: true, existing: async () => undefined, print: () => {}, run: (...call) => { ran.push(call); } });
  assert.equal(result.applied, true);
  assert.deepEqual(ran, [['claude', ['mcp', 'add', '-s', 'local', 'witchcraft_wow', '--', spaced.nodePath, spaced.scriptPath,
    '--cache', spaced.cachePath, '--allow-local-writes'], { cwd: spaced.repoRoot }]]);
  assert.equal(parseArgs(['mcp-setup', '--apply']).options.apply, true);
});

test('installed mcp-setup registers a pinned launcher that survives npx cache eviction', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'witchcraft-mcp-npm-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const state = path.join(root, 'Witch & Craft');
  const packageDir = path.join(root, 'temporary npx install');
  const scriptPath = path.join(packageDir, 'bin', 'witchcraft-mcp.js');
  await fs.mkdir(path.dirname(scriptPath), { recursive: true });
  await fs.writeFile(scriptPath, "console.log(JSON.stringify({ direct: true, home: process.env.WITCHCRAFT_STATE_DIR }));");
  const npmCli = path.join(root, 'npm-cli.cjs');
  // npm flattens scoped names in its archive filename. Only the pack report is authoritative.
  const archiveName = 'example-witchcraft-daemon-0.5.1.tgz';
  const packStub = `require('node:fs').writeFileSync(require('node:path').join(process.cwd(), ${JSON.stringify(archiveName)}), 'candidate');
    console.log(JSON.stringify([{ filename: ${JSON.stringify(archiveName)}, files: [{path: 'bin/witchcraft-mcp.js'}] }]));`;
  await fs.writeFile(npmCli, `if (process.argv[2] === 'pack') { ${packStub} } else {
    console.log(JSON.stringify({args: process.argv.slice(2), home: process.env.WITCHCRAFT_STATE_DIR,
      parent: Number(process.env.WITCHCRAFT_MCP_CLIENT_PID), cwd: process.cwd()}));
  }`);
  const options = { repoRoot: root, cachePath: path.join(state, 'wow-context.json'), scriptPath,
    installed: true, packageDir, npmCli, print() {}, existing: async () => undefined };
  const preview = await setupClaudeMcp(options);
  await assert.rejects(fs.stat(state), { code: 'ENOENT' }, 'preview must not write a launcher or install a package');
  const calls = [];
  await setupClaudeMcp({ ...options, apply: true, run: (...args) => calls.push(args) });
  assert.deepEqual(calls, [['claude', preview.args, { cwd: root }]]);
  const [node, ...args] = preview.args.slice(preview.args.indexOf('--') + 1);
  const start = () => JSON.parse(execFileSync(node, args, { cwd: root, encoding: 'utf8' }));
  assert.deepEqual(start(), { direct: true, home: state }, 'existing exact install works without consulting npm');
  await fs.writeFile(scriptPath, "throw Error('different build');");
  assert.equal(start().args[0], 'exec', 'a same-version replacement must not be used');
  await fs.rm(packageDir, { recursive: true });
  const result = start();
  const runtime = path.join(state, 'mcp-runtime', `${manifest.name}@${manifest.version}`);
  const pointer = JSON.parse(await fs.readFile(path.join(runtime, 'current.json'), 'utf8'));
  const archive = path.join(runtime, `${pointer.sha256}.tgz`);
  assert.equal(await fs.readFile(archive, 'utf8'), 'candidate');
  assert.deepEqual(result, {
    args: ['exec', '--yes', '--ignore-scripts', '--package', `file:./mcp-runtime/${manifest.name}@${manifest.version}/${pointer.sha256}.tgz`, '--', 'witchcraft-mcp', '--allow-local-writes'],
    home: state, parent: process.pid, cwd: state,
  });
});
