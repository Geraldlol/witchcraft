#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createMcpServer } from '../src/mcp-server.js';
import { announcePresence, presenceDir } from '../src/mcp-presence.js';

const args = process.argv.slice(2);
const defaultCache = fileURLToPath(new URL('../.local/wow-context.json', import.meta.url));
const USAGE = 'Usage: witchcraft-mcp [--cache ABSOLUTE_PATH] [--allow-local-writes]\n';
// Writes are a capability the launcher grants, never a default: without the flag no write tool exists.
const allowWrites = args.at(-1) === '--allow-local-writes';
const rest = allowWrites ? args.slice(0, -1) : args;
if (args.length === 1 && args[0] === '--help') {
  process.stderr.write(`${USAGE}WoW context over MCP STDIO; start the Witchcraft daemon to populate the cache.\n`
    + 'Read-only by default. --allow-local-writes adds three tools that change only local records:\n'
    + 'the loot wishlist (wow_set_loot_goal) and the passport (wow_stamp_passport, wow_set_passport_campaign).\n');
} else if (rest.length !== 0 && (rest.length !== 2 || rest[0] !== '--cache' || !path.isAbsolute(rest[1]))) {
  process.stderr.write(USAGE);
  process.exitCode = 2;
} else {
  const cachePath = rest[1] ?? defaultCache;
  // Tell the daemon which client has the WoW tools loaded (see mcp-presence.js). A record left by a
  // server killed outright is cleared by whoever next finds its pid gone.
  try { process.once('exit', announcePresence(presenceDir(cachePath))); }
  catch { process.stderr.write('Witchcraft MCP could not record its presence; the daemon may report the tools missing.\n'); }
  const handle = serveStdio(() => createMcpServer({ cachePath, allowWrites }), {
    onerror: () => process.stderr.write('Witchcraft MCP transport error.\n'),
  });
  const close = () => { void handle.close().catch(() => { process.exitCode = 1; }); };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}
