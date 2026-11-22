import fs from 'node:fs/promises';
import path from 'node:path';
import { AGENT_TABS, selectAgentCommands } from './agents.js';
import { pidAlive } from './bridge-lock.js';
import { validateRegion } from './capture.js';
import { checkClientBuild } from './client-build.js';
import { LOCAL_DIR, REPO_ROOT, loadConfig } from './config.js';
import { assertOwnedChunk, chunkName } from './ring.js';

// All output fields are constructed here. Never include paths, account names, raw exceptions,
// text from the cache, or a user's configured commands in a shareable diagnostic.
async function json(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function probeRecord(file, epoch, uiNonce, startedAt, now) {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const size = (await handle.stat()).size;
    // The event logger rotates at 1 MiB. A session can keep its qualification across many frames.
    const tail = Buffer.alloc(Math.min(size, 1024 * 1024));
    const { bytesRead } = await handle.read(tail, 0, tail.length, size - tail.length);
    for (const line of tail.toString('utf8', 0, bytesRead).trim().split('\n').reverse()) {
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (record?.what === 'binding-probe-ack' && record.epoch === epoch && record.ui === uiNonce) {
        const at = Date.parse(record.at);
        if (at >= startedAt && at <= now) return at;
      }
    }
  } catch { /* No host acknowledgement observed. */ }
  finally { await handle?.close(); }
  return null;
}

async function installedRing(addonsDir, size) {
  let valid = 0;
  const present = new Set(await fs.readdir(addonsDir));
  // A normal install has 3,000 slots. Bound simultaneous filesystem operations.
  for (let start = 1; start <= size; start += 16) {
    const batch = Array.from({ length: Math.min(16, size - start + 1) }, async (_, offset) => {
      if (!present.has(chunkName(start + offset))) return false;
      try {
        const directory = await assertOwnedChunk(addonsDir, start + offset);
        return (await fs.lstat(path.join(directory, 'Chunk.lua'))).isFile();
      } catch { return false; }
    });
    valid += (await Promise.all(batch)).filter(Boolean).length;
  }
  return valid;
}

async function dependencies() {
  const [{ resolveLaunch }, { readContextFile }] = await Promise.all([
    import('./pty.js'), import('./context-cache.js'), import('./outbox.js'),
  ]);
  return { resolveLaunch, readContextFile };
}

export async function runDoctor({ options = {}, repoRoot = REPO_ROOT, localDir = LOCAL_DIR,
  loadDependencies = dependencies, isAlive = pidAlive, now = Date.now } = {}) {
  const checks = [];
  const add = (id, status, detail, next) => checks.push({ id, status, detail, ...(next && { next }) });
  const result = () => ({ checks, next: checks.find(c => c.status === 'fail')?.next
    ?? checks.find(c => c.status === 'wait')?.next ?? null });
  const versionPattern = /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/u;
  const pkg = await json(path.join(repoRoot, 'tools', 'witchcraft-daemon', 'package.json')).catch(() => null);
  const version = typeof pkg?.version === 'string' && versionPattern.test(pkg.version) ? pkg.version : null;
  const supported = Number(process.versions.node.split('.')[0]) >= 24;
  add('node', supported ? 'ok' : 'fail', `Node ${process.versions.node}, daemon ${version ?? 'unknown'}.`,
    supported ? null : 'Install Node.js 24 or newer.');
  if (!version) add('package', 'fail', 'Local daemon package version unavailable.', 'Restore the matching daemon source archive.');
  let modules;
  try { modules = await loadDependencies(); add('dependencies', 'ok', 'Terminal and context modules load.'); }
  catch { add('dependencies', 'fail', 'Daemon dependencies could not load.',
    'From tools/witchcraft-daemon, run npm ci --ignore-scripts and npm rebuild node-pty --ignore-scripts=false.'); }

  let config;
  try {
    config = await loadConfig({ repoRoot, configPath: path.join(localDir, 'config.json'),
      account: options.account, character: options.character });
    if (!(await fs.stat(config.accountDir)).isDirectory()) throw new Error('Account directory missing');
    add('client', 'ok', 'Selected client and account directory found.');
  } catch (error) {
    let next = 'Check wow.config.json and the selected account. Log into this client once to create its account directory.';
    if (error.message.startsWith('Choose the WoW account')) next = 'Select an account with --account NAME and use it for init.';
    if (error.message.startsWith('Choose the character')) next = 'Select the character with --character NAME.';
    if (error.code === 'ENOENT' && error.path === path.join(repoRoot, 'wow.config.json')) {
      next = 'Copy wow.config.example.json to wow.config.json and set addonsDir to your Forever client.';
    }
    add('client', 'fail', 'Client or account configuration needs attention.', next);
    return result();
  }
  let installed;
  try {
    const toc = await fs.readFile(path.join(config.addonsDir, 'Witchcraft', 'Witchcraft.toc'), 'utf8');
    const label = /^## Version:\s*(\S+)\s*$/mu.exec(toc)?.[1];
    if (versionPattern.test(label)) installed = label;
  } catch { /* Missing or unreadable addon. */ }
  add('addon', installed === version ? 'ok' : 'fail', `Installed addon ${installed ?? 'unknown'}, daemon ${version ?? 'unknown'}.`,
    installed === version ? null : 'Copy the matching Witchcraft addon folder into the selected client.');
  const build = await checkClientBuild(config.addonsDir);
  add('build', 'info', `Client build ${build.client ?? 'unknown'}. Optional cooldown carrier qualification: ${build.status}.`);
  let valid = 0;
  try { valid = await installedRing(config.addonsDir, config.ringSize); }
  catch { /* No helper ring at this destination. */ }
  add('ring', valid === config.ringSize ? 'ok' : 'fail', `${valid}/${config.ringSize} expected helper slots verified.`,
    valid === config.ringSize ? null : 'Check the client path, run witchcraft init and fully restart WoW after creating helpers.');
  if (modules) {
    let commands;
    try { ({ commands } = selectAgentCommands(config, options)); }
    catch { add('assistants', 'fail', 'Invalid assistant selection.', 'Check commands and choose --only claude, codex, or copilot.'); }
    let selected = 0;
    for (const tab of AGENT_TABS) {
      if (!commands || (options.only && tab !== options.only)) continue;
      if (options.attach?.[tab] || config.attach?.[tab]) {
        selected++;
        add(tab, 'info', 'A console attachment is configured.');
        continue;
      }
      if (!commands[tab]) continue;
      selected++;
      try { modules.resolveLaunch(commands[tab]); add(tab, 'ok', 'Launch command found.'); }
      catch { add(tab, 'fail', 'Launch command unavailable.', `Install or configure ${tab}, or select your installed assistant with --only.`); }
    }
    if (commands && !selected) add('assistants', 'fail', 'No assistant selected for launch or attachment.', 'Configure an assistant command or console attachment.');
  }
  try { validateRegion(config.region); add('calibration', 'ok', 'Saved screen-strip calibration is valid.'); }
  catch { add('calibration', 'info', 'Screen-strip fallback has no valid saved calibration. Use /witch calibrate and witchcraft calibrate to enable it.'); }

  let lock;
  try { lock = await json(path.join(localDir, 'bridge.lock')); } catch { /* Daemon may be stopped. */ }
  const startedAt = Date.parse(lock?.startedAt);
  if (!Number.isSafeInteger(lock?.pid) || lock.pid <= 0 || !isAlive(lock.pid) || !Number.isFinite(startedAt)
      || !/^[0-9a-f]{8}$/u.test(lock.epoch) || lock.epoch === '00000000') {
    add('daemon', 'wait', 'No live daemon observed for this installation.', 'Start witchcraft run with your chosen assistant.');
    return result();
  }
  add('daemon', 'ok', 'This installation has a live daemon lock.');
  const context = modules && await modules.readContextFile(path.join(localDir, 'wow-context.json'), { now: now() });
  if (context?.session?.epoch !== lock.epoch || context.connection?.status !== 'connected') {
    add('heartbeat', 'wait', 'No recent game heartbeat for this daemon.', 'Enable the addon and helpers, then /reload outside combat and run /witch bindprobe.');
    return result();
  }
  add('heartbeat', 'ok', `Current game heartbeat, age ${context.connection.ageSeconds}s.`);
  const trace = path.join(localDir, 'trace.log'), at = now();
  const ack = await probeRecord(trace, lock.epoch, context.session.uiNonce, startedAt, at)
    ?? await probeRecord(trace + '.1', lock.epoch, context.session.uiNonce, startedAt, at);
  if (ack !== null) add('binding', 'ok', `Host acknowledged the binding probe ${Math.max(0, Math.floor((now() - ack) / 1000))}s ago. Confirm cleanup in /witch status.`);
  else add('binding', 'wait', 'No binding-probe acknowledgement observed for this UI session.',
    'Run /witch bindprobe outside combat and wait for the in-game acknowledgement and cleanup.');
  return result();
}

export function formatDoctor(report) {
  return [...report.checks.map(check => `[${check.status.toUpperCase()}] ${check.id} — ${check.detail}`),
    report.next ? `Next step: ${report.next}` : 'Ready.'].join('\n');
}
