import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Windows paths compare without case or trailing separators: one Codex thread records `e:\...`
// for the same folder another records as `E:\...`.
const samePath = (left, right) => typeof left === 'string' && typeof right === 'string'
  && path.resolve(left).replace(/[\\/]+$/u, '').toLowerCase() === path.resolve(right).replace(/[\\/]+$/u, '').toLowerCase();

// A rollout's first line is its session metadata, which embeds the base instructions and can run
// to tens of kilobytes. Read until the newline, but never more than a megabyte.
async function firstLine(file, limit = 1 << 20) {
  const handle = await fs.open(file, 'r');
  try {
    const chunks = [];
    for (let position = 0; position < limit;) {
      const { buffer, bytesRead } = await handle.read(Buffer.alloc(65536), 0, 65536, position);
      if (!bytesRead) break;
      const end = buffer.subarray(0, bytesRead).indexOf(10);
      if (end >= 0) { chunks.push(buffer.subarray(0, end)); break; }
      chunks.push(buffer.subarray(0, bytesRead)); position += bytesRead;
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { await handle.close(); }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

/**
 * The newest interactive Claude Code session running in `cwd`, from the records Claude Code keeps
 * in ~/.claude/sessions/<pid>.json. Its pid shares the console the mirror attaches to.
 */
export async function findClaudeSession({ cwd, dir = path.join(os.homedir(), '.claude', 'sessions'), isAlive = alive } = {}) {
  let names;
  try { names = await fs.readdir(dir); } catch { return undefined; }
  const found = [];
  for (const name of names.filter(entry => /^\d+\.json$/u.test(entry))) {
    let record;
    try { record = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')); } catch { continue; }
    if (!Number.isInteger(record?.pid) || record.pid <= 0 || record.kind !== 'interactive') continue;
    if (!samePath(record.cwd, cwd) || !isAlive(record.pid)) continue;
    found.push({ pid: record.pid, sessionId: record.sessionId, startedAt: Number(record.startedAt) || 0 });
  }
  return found.sort((a, b) => b.startedAt - a.startedAt)[0];
}

/**
 * True while pid is still a live interactive Claude Code session in `cwd`: its own record in
 * ~/.claude/sessions names it and its process runs. A pid alone can be reused once Claude exits.
 */
export async function claudeSessionAlive(pid, { cwd, dir = path.join(os.homedir(), '.claude', 'sessions'), isAlive = alive } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  let record;
  try { record = JSON.parse(await fs.readFile(path.join(dir, `${pid}.json`), 'utf8')); } catch { return false; }
  return record?.pid === pid && record.kind === 'interactive' && samePath(record.cwd, cwd) && isAlive(pid);
}

/**
 * The most recently written top-level Codex thread for `cwd`, read from the first line of the
 * rollouts in ~/.codex/sessions/YYYY/MM/DD. Subagent threads record an object as their source and
 * are skipped, so a review the extension spawned never wins over the conversation that spawned it.
 */
export async function findCodexThread({ cwd, root = path.join(os.homedir(), '.codex', 'sessions'), days = 14, files = 400 } = {}) {
  const listed = async directory => {
    try { return (await fs.readdir(directory)).sort().reverse(); } catch { return []; }
  };
  const rollouts = [];
  outer: for (const year of await listed(root)) {
    for (const month of await listed(path.join(root, year))) {
      for (const day of await listed(path.join(root, year, month))) {
        if (days-- <= 0) break outer;
        const directory = path.join(root, year, month, day);
        for (const name of (await listed(directory)).filter(entry => /^rollout-.+\.jsonl$/u.test(entry))) {
          const file = path.join(directory, name);
          try { rollouts.push({ file, modified: (await fs.stat(file)).mtimeMs }); } catch { /* removed meanwhile */ }
          if (rollouts.length >= files) break outer;
        }
      }
    }
  }
  for (const { file } of rollouts.sort((a, b) => b.modified - a.modified)) {
    let meta;
    try { meta = JSON.parse(await firstLine(file))?.payload; } catch { continue; }
    if (typeof meta?.id !== 'string' || !/^[0-9a-f-]{36}$/iu.test(meta.id)) continue;
    if (typeof meta.source !== 'string' || meta.source === 'exec' || !samePath(meta.cwd, cwd)) continue;
    return { id: meta.id, source: meta.source, file };
  }
  return undefined;
}
