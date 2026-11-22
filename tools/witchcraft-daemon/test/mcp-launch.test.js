import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
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
const spaced = { repoRoot: 'E:\\Some Repo', cachePath: 'E:\\Some Repo\\daemon\\.local\\wow-context.json',
  nodePath: 'C:\\Program Files\\nodejs\\node.exe', scriptPath: 'E:\\Some Repo\\daemon\\bin\\witchcraft-mcp.js' };

test('mcp-setup prints the local registration for this checkout and changes nothing by itself', async () => {
  const printed = [], ran = [];
  const result = await setupClaudeMcp({ ...spaced, print: line => printed.push(line), run: (...call) => { ran.push(call); } });
  assert.equal(ran.length, 0, 'without --apply nothing is run');
  assert.equal(result.applied, false);
  assert.ok(printed.includes('  claude mcp add -s local witchcraft_wow -- "C:\\Program Files\\nodejs\\node.exe" '
    + '"E:\\Some Repo\\daemon\\bin\\witchcraft-mcp.js" --cache "E:\\Some Repo\\daemon\\.local\\wow-context.json" --allow-local-writes'),
  printed.join('\n'));
  assert.match(printed.join('\n'), /E:\\Some Repo/u, 'it says which folder to run it in');
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
  const stale = { type: 'stdio', command: spaced.nodePath, args: ['E:\\old checkout\\bin\\witchcraft-mcp.js'] };
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
