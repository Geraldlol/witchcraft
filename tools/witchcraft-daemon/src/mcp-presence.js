import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pidAlive } from './bridge-lock.js';

// A Claude session reads its MCP servers when it starts, so neither its config nor the daemon can
// tell whether a running session has the WoW tools. Each server says so instead: while it runs it
// keeps one small record, named by its own pid, of the client process that started it.

/** The directory of presence records, beside the context cache the server reads. */
export const presenceDir = cachePath => path.join(path.dirname(cachePath), 'mcp-clients');

/** Writes this process's record and returns the synchronous withdrawal for its exit handler. */
const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY']);
const pause = milliseconds => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);

export function announcePresence(dir, { pid = process.pid, ppid = process.ppid, now = Date.now(), files = fs } = {}) {
  const file = path.join(dir, `${pid}.json`), temporary = `${file}.tmp`, text = JSON.stringify({ pid, ppid, startedAt: now });
  files.mkdirSync(dir, { recursive: true });
  files.writeFileSync(temporary, text);
  // Windows refuses to rename a file a scanner or indexer has just opened (as ring.js also finds).
  // The server announces only once, so retry briefly, then write the record in place: a reader
  // skips a record it cannot parse yet.
  let moved = false;
  for (let attempt = 0; attempt < 5 && !moved; attempt++) {
    try { files.renameSync(temporary, file); moved = true; }
    catch (error) { if (!TRANSIENT.has(error.code)) throw error; pause(20 * (attempt + 1)); }
  }
  if (!moved) {
    files.writeFileSync(file, text);
    try { files.unlinkSync(temporary); } catch { /* left for the next start */ }
  }
  return () => { try { files.unlinkSync(file); } catch { /* already gone */ } };
}

const valid = record => record && Number.isSafeInteger(record.pid) && record.pid > 0
  && Number.isSafeInteger(record.ppid) && record.ppid > 0;

/** Records of servers still running. A record whose server died without withdrawing is removed. */
export async function livePresences(dir, { isAlive = pidAlive, fs: files = fsp } = {}) {
  let names;
  try { names = await files.readdir(dir); } catch { return []; }
  const found = [];
  for (const name of names) {
    if (!/^[1-9][0-9]*\.json$/u.test(name)) continue;
    let record;
    try { record = JSON.parse(await files.readFile(path.join(dir, name), 'utf8')); } catch { continue; }
    if (!valid(record) || name !== `${record.pid}.json`) continue;
    if (isAlive(record.pid)) found.push(record);
    else await files.unlink(path.join(dir, name)).catch(() => {});
  }
  return found;
}

/** True when a live WoW MCP server was started by the client process clientPid. */
export async function hasWoWTools(dir, clientPid, options) {
  return (await livePresences(dir, options)).some(record => record.ppid === clientPid);
}
