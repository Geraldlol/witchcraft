import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MCP_SCRIPT = fileURLToPath(new URL('../bin/witchcraft-mcp.js', import.meta.url));

/** The WoW MCP server's command line: node, the script, the daemon's cache, and the local writes it grants. */
export function serverCommand({ cachePath, nodePath = process.execPath, scriptPath = MCP_SCRIPT } = {}) {
  if (![cachePath, nodePath, scriptPath].every(value => typeof value === 'string' && path.isAbsolute(value))) {
    throw new TypeError('WoW MCP requires absolute executable, script, and cache paths');
  }
  return [nodePath, scriptPath, '--cache', cachePath, '--allow-local-writes'];
}

// Pass arguments directly to the existing PTY launcher. No shell, user-wide
// configuration changes, prompt injection, or automatic tool approvals.
export function withWoWMcp(tab, entry, options = {}) {
  if (!entry) return entry;
  const basename = path.basename(entry.file).toLowerCase().replace(/\.exe$/u, '');
  if (!['claude', 'codex'].includes(tab) || basename !== tab) return entry;
  const [nodePath, ...serverArgs] = serverCommand(options);
  const args = [...(entry.args ?? [])];
  if (tab === 'claude') {
    // Keep this variadic option after existing positional arguments, but before
    // an explicit end-of-options marker, so resume/prompt text stays intact.
    const config = JSON.stringify({ mcpServers: { witchcraft_wow: { type: 'stdio', command: nodePath, args: serverArgs } } });
    const separator = args.indexOf('--');
    args.splice(separator < 0 ? args.length : separator, 0, '--mcp-config', config);
    return { ...entry, args };
  }
  const prefix = 'mcp_servers.witchcraft_wow';
  return { ...entry, args: ['-c', `${prefix}.command=${JSON.stringify(nodePath)}`,
    '-c', `${prefix}.args=${JSON.stringify(serverArgs)}`, ...args] };
}

const quoted = value => (/[\s"]/u.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value);

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
 * sessions started in repoRoot get it, and nothing is committed. Only an explicit --apply runs it,
 * and it does nothing when the same server is already registered there.
 */
export async function setupClaudeMcp({ repoRoot, cachePath, nodePath, scriptPath, apply = false, run = runClaude,
  existing = readLocalRegistration, print = line => console.log(line) } = {}) {
  const server = serverCommand({ cachePath, nodePath, scriptPath });
  const args = ['mcp', 'add', '-s', 'local', 'witchcraft_wow', '--', ...server];
  const restart = `Then restart the Claude Code session in ${repoRoot} once (claude --continue) so it loads the tools, and restart Witchcraft so the Claude tab joins it again.`;
  if (!apply) {
    print(`To give the Claude tab the WoW tools, run this once in ${repoRoot}:`);
    print(`  ${['claude', ...args].map(quoted).join(' ')}`);
    print(`or run this command again with --apply. ${restart}`);
    return { applied: false, args };
  }
  // claude mcp add refuses a name that already exists, so a second --apply would only fail.
  const current = await existing(repoRoot);
  if (current) {
    const same = current.command === server[0] && JSON.stringify(current.args ?? []) === JSON.stringify(server.slice(1));
    if (!same) {
      throw new Error(`A different witchcraft_wow is already registered for ${repoRoot}. Replace it with `
        + '"claude mcp remove -s local witchcraft_wow" in that folder, then run this again.');
    }
    print(`witchcraft_wow is already registered for Claude Code sessions in ${repoRoot}. ${restart}`);
    return { applied: false, already: true, args };
  }
  await run('claude', args, { cwd: repoRoot });
  print(`Registered witchcraft_wow for Claude Code sessions in ${repoRoot}. ${restart}`);
  return { applied: true, args };
}
