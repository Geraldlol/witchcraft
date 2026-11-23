import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import manifest from '../package.json' with { type: 'json' };
import { INSTALLED_PACKAGE, PACKAGE_DIR } from './config.js';
import { atomicWrite } from './ring.js';
import runtimeTools from './npm-mcp-launch.cjs';

export const MCP_SCRIPT = fileURLToPath(new URL('../bin/witchcraft-mcp.js', import.meta.url));
const LAUNCH_MCP_TABS = new Set(['claude', 'codex', 'copilot']);

/** The WoW MCP server's command line: node, the script, the daemon's cache, and the local writes it grants. */
export function serverCommand({ cachePath, nodePath = process.execPath, scriptPath = MCP_SCRIPT } = {}) {
  if (![cachePath, nodePath, scriptPath].every(value => typeof value === 'string' && path.isAbsolute(value))) {
    throw new TypeError('WoW MCP requires absolute executable, script, and cache paths');
  }
  return [nodePath, scriptPath, '--cache', cachePath, '--allow-local-writes'];
}

// Pass arguments directly to the existing PTY launcher. No shell, user-wide
// configuration changes, prompt injection, or automatic tool approvals.
// Note: agy defines -c as --continue and uses mcp_config.json / `agy mcp add` rather than session CLI flags.
export function withWoWMcp(tab, entry, options = {}) {
  if (!entry) return entry;
  const basename = path.basename(entry.file).toLowerCase().replace(/\.exe$/u, '');
  if (!LAUNCH_MCP_TABS.has(tab) || basename !== tab) return entry;
  const [nodePath, ...serverArgs] = serverCommand(options);
  const args = [...(entry.args ?? [])];
  if (tab === 'claude' || tab === 'copilot') {
    // Keep this variadic option after existing positional arguments, but before
    // an explicit end-of-options marker, so resume/prompt text stays intact.
    const config = JSON.stringify({ mcpServers: { witchcraft_wow: { type: 'stdio', command: nodePath, args: serverArgs, ...(tab === 'copilot' ? { tools: ['*'] } : {}) } } });
    const separator = args.indexOf('--');
    args.splice(separator < 0 ? args.length : separator, 0, tab === 'copilot' ? '--additional-mcp-config' : '--mcp-config', config);
    return { ...entry, args };
  }
  const prefix = 'mcp_servers.witchcraft_wow';
  return { ...entry, args: ['-c', `${prefix}.command=${JSON.stringify(nodePath)}`,
    '-c', `${prefix}.args=${JSON.stringify(serverArgs)}`, ...args] };
}

const quoted = value => (/[\s"]/u.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value);

// Persist npm's JavaScript executable rather than a platform-specific shell shim. npm exec
// supplies npm_execpath; a global installation may instead find npm beside Node or on PATH.
async function findNpmCli(nodePath) {
  const nodeDir = path.dirname(nodePath);
  const candidates = [path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(nodeDir, '../lib/node_modules/npm/bin/npm-cli.js')];
  const caller = process.env.npm_execpath;
  if (caller && path.isAbsolute(caller) && ['npm-cli.js', 'npx-cli.js'].includes(path.basename(caller))) {
    candidates.push(path.join(path.dirname(caller), 'npm-cli.js'));
  }
  const dirs = new Set((process.env.PATH ?? '').split(path.delimiter).filter(dir => path.isAbsolute(dir)));
  for (const dir of dirs) {
    candidates.push(path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.join(dir, 'npm'));
  }
  for (const candidate of candidates) {
    const resolved = await fs.realpath(candidate).catch(() => null);
    if (resolved && path.basename(resolved) === 'npm-cli.js' && !isNpxCachePath(resolved)) return resolved;
  }
  throw new Error('Cannot locate npm for MCP registration. Run npx witchcraft-daemon mcp-setup with an installation of Node that includes npm.');
}

const isNpxCachePath = file => path.resolve(file).split(path.sep).includes('_npx');

// Keep precisely this install's publishable files for Claude. npm exec can recreate its directory
// from the archive even after an npx cache eviction or before this version reaches the registry.
async function retainMcpRuntime([nodePath, launcher, npmCli, packageSpec], packageDir) {
  const state = path.dirname(launcher);
  const runtime = path.join(state, 'mcp-runtime', packageSpec);
  await fs.mkdir(runtime, { recursive: true, mode: 0o700 });
  const staging = await fs.mkdtemp(path.join(runtime, 'pack-'));
  try {
    const { stdout } = await promisify(execFile)(nodePath, [npmCli, 'pack', '--json', '--offline', '--ignore-scripts', '--cache',
      path.join(staging, 'cache'), '--pack-destination', staging, packageDir], { cwd: staging, windowsHide: true });
    const files = JSON.parse(stdout)[0].files.map(entry => entry.path).sort();
    const source = { root: packageDir, files, fingerprint: runtimeTools.packageFingerprint(packageDir, files) };
    const archive = await fs.readFile(path.join(staging, `${manifest.name}-${manifest.version}.tgz`));
    const sha256 = createHash('sha256').update(archive).digest('hex');
    await atomicWrite(path.join(runtime, `${sha256}.tgz`), archive);
    await atomicWrite(launcher, await fs.readFile(new URL('./npm-mcp-launch.cjs', import.meta.url)));
    await atomicWrite(path.join(runtime, 'current.json'), JSON.stringify({ sha256, source }));
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

function runClaude(file, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { ...options, stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', code => (code === 0 ? resolve() : reject(new Error(`claude mcp add exited with ${code}`))));
  });
}

const folderKey = folder => path.resolve(folder).replace(/\\/gu, '/').replace(/\/+$/u, '').toLowerCase();

/** The witchcraft_wow server Claude Code has registered in local scope for folder, from its config. */
export function localRegistration(config, folder) {
  const entry = Object.entries(config?.projects ?? {}).find(([key]) => folderKey(key) === folderKey(folder));
  return entry?.[1]?.mcpServers?.witchcraft_wow;
}

// Read-only: the daemon never writes Claude Code's own configuration.
async function readLocalRegistration(folder) {
  try { return localRegistration(JSON.parse(await fs.readFile(path.join(os.homedir(), '.claude.json'), 'utf8')), folder); }
  catch { return undefined; }
}

/**
 * The Claude tab mirrors a Claude Code session the player started, which no launcher configured.
 * This prints the one registration that gives such sessions the WoW tools: local scope, so only
 * sessions started in repoRoot get it. An explicit --apply retains the installed package and
 * registers the server with Claude if the project's existing registration differs.
 */
export async function setupClaudeMcp({ repoRoot, cachePath, nodePath = process.execPath, scriptPath, apply = false,
  installed = INSTALLED_PACKAGE, packageDir = PACKAGE_DIR, npmCli, run = runClaude,
  existing = readLocalRegistration, print = line => console.log(line) } = {}) {
  const direct = serverCommand({ cachePath, nodePath, scriptPath });
  if (installed && isNpxCachePath(nodePath)) {
    throw new Error('MCP registration needs a persistent Node installation. Run mcp-setup using Node 24 or newer installed outside the npx cache.');
  }
  const launcher = path.join(path.dirname(cachePath), 'mcp-launch.cjs');
  const packageSpec = `${manifest.name}@${manifest.version}`;
  const server = installed ? [nodePath, launcher, npmCli ?? await findNpmCli(nodePath), packageSpec] : direct;
  const args = ['mcp', 'add', '-s', 'local', 'witchcraft_wow', '--', ...server];
  const restart = `Then restart the Claude Code session in ${repoRoot} once (claude --continue) so it loads the tools, and restart Witchcraft so the Claude tab joins it again.`;
  if (!apply) {
    if (installed) {
      print(`Claude registration preview for ${repoRoot}:`);
      print(`  ${server.map(quoted).join(' ')}`);
      print(`In that project folder, run npx ${packageSpec} mcp-setup --apply to create the launcher and register it. ${restart}`);
    } else {
      print(`To give the Claude tab the WoW tools, run this once in ${repoRoot}:`);
      print(`  ${['claude', ...args].map(quoted).join(' ')}`);
      print(`or run this command again with --apply. ${restart}`);
    }
    return { applied: false, args };
  }
  // claude mcp add refuses a name that already exists, so a second --apply would only fail.
  const current = await existing(repoRoot);
  if (current && (current.command !== server[0] || JSON.stringify(current.args ?? []) !== JSON.stringify(server.slice(1)))) {
    throw new Error(`A different witchcraft_wow is already registered for ${repoRoot}. Replace it with `
      + '"claude mcp remove -s local witchcraft_wow" in that folder, then run this again.');
  }
  if (installed) await retainMcpRuntime(server, packageDir);
  if (current) {
    print(`witchcraft_wow is already registered for Claude Code sessions in ${repoRoot}. ${restart}`);
    return { applied: false, already: true, args };
  }
  await run('claude', args, { cwd: repoRoot });
  print(`Registered witchcraft_wow for Claude Code sessions in ${repoRoot}. ${restart}`);
  return { applied: true, args };
}
