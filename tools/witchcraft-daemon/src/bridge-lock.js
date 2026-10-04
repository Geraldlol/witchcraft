import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const same = (a, b) => Boolean(a && b && a.dev === b.dev && a.ino === b.ino);
const STALE_AFTER_MS = 60_000;

/** True while a process with this pid exists; a pid we may not signal still exists. */
export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

const stamp = ms => new Date(ms).toISOString().replace(/[-:]/gu, '').replace('T', '-').slice(0, 15);

// Why the lock at lockPath no longer belongs to a running bridge, or { live } while it may.
async function staleReason(lockPath, { now, bootTime, isAlive, fs }) {
  // One open, so the identity checked before the lock is set aside is that of the bytes judged here.
  const handle = await fs.open(lockPath, 'r');
  let text, stats;
  try { stats = await handle.stat({ bigint: true }); text = await handle.readFile('utf8'); }
  finally { await handle.close(); }
  let owner;
  try { owner = JSON.parse(text); } catch { owner = undefined; }
  const pid = Number.isSafeInteger(owner?.pid) && owner.pid > 0 ? owner.pid : undefined;
  const writtenAt = Number(stats.mtimeMs);
  const verdict = reason => ({ reason, identity: stats, pid, startedAt: owner?.startedAt, writtenAt });
  // A live pid always wins, even over the boot rule: a wall-clock step after the lock was written
  // can make a running bridge's lock look older than the boot. A pid reused by another process
  // after a crash is refused here and settled by the witchcraft-daemon skill's status action.
  if (pid !== undefined) return isAlive(pid) ? { live: `pid ${pid}, started ${owner.startedAt ?? 'at an unknown time'}` }
    : verdict(`its process ${pid} has exited`);
  if (writtenAt < bootTime) return verdict('it was written before the last boot');
  return now - writtenAt > STALE_AFTER_MS ? verdict('it is empty or unreadable') : { live: 'it is being written' };
}

/**
 * Takes lockPath for this run. The record is written and synced under a private name first and
 * then hard-linked into place, so the lock is never visible empty and the link fails atomically
 * when another lock exists. A lock left by a crashed or exited run is renamed aside to
 * bridge.lock.stale-<written>-<tag>.json and the link is tried once more; a live owner is refused.
 * Returns the open handle and the file identity that releaseOwnedLock later checks.
 */
export async function acquireLock({ lockPath, record, tag, now = Date.now(), bootTime = Date.now() - os.uptime() * 1000,
  isAlive = pidAlive, fs = fsp }) {
  const temporary = `${lockPath}.${tag}.tmp`;
  const handle = await fs.open(temporary, 'wx');
  const abandon = async () => { await handle.close().catch(() => {}); await fs.unlink(temporary).catch(() => {}); };
  const refuse = reason => Object.assign(new Error(`A Witchcraft bridge owns ${lockPath} (${reason}). Stop it first; `
    + 'the witchcraft-daemon skill\'s status action shows whether that process is still the bridge.'), { code: 'LOCK_HELD' });
  const reclaimed = [];
  try {
    await handle.writeFile(JSON.stringify(record));
    await handle.sync();
    const identity = await handle.stat({ bigint: true });
    for (let attempt = 0; ; attempt++) {
      try { await fs.link(temporary, lockPath); break; }
      catch (error) { if (error.code !== 'EEXIST' || attempt > 0) throw error.code === 'EEXIST' ? refuse('another start took it') : error; }
      const verdict = await staleReason(lockPath, { now, bootTime, isAlive, fs }).catch(error => {
        if (error.code === 'ENOENT') return { gone: true };
        throw error;
      });
      if (verdict.live) throw refuse(verdict.live);
      if (verdict.gone) continue;
      const aside = path.join(path.dirname(lockPath), `${path.basename(lockPath)}.stale-${stamp(verdict.writtenAt)}-${tag}.json`);
      try { await fs.rename(lockPath, aside); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      // Only the lock that was judged may be set aside. A racer's fresh lock taken by mistake goes
      // back; if the path was taken again meanwhile, it is kept where it is, not deleted, and named.
      if (!same(await fs.stat(aside, { bigint: true }), verdict.identity)) {
        const restored = await fs.link(aside, lockPath).then(() => true, () => false);
        if (!restored) throw refuse(`another start took it; a lock moved aside by mistake is kept at ${aside}`);
        await fs.unlink(aside).catch(() => {});
        throw refuse('another start took it');
      }
      reclaimed.push({ path: aside, reason: verdict.reason });
    }
    // The lock is held from the link on. A temporary name left behind (antivirus holding it) is
    // only a second name for the same file, not a reason to fail the start with the lock in place.
    await fs.unlink(temporary).catch(() => {});
    return { handle, identity, reclaimed };
  } catch (error) {
    await abandon();
    throw error;
  }
}

// Removes the bridge lock only when the file at lockPath is the one this run created (identity is
// its bigint stat). A foreign lock is detected through a second hard link, so it is never moved or
// left vacant. Only when the lock was ours at that check is the path claimed by an atomic rename;
// if a racer had swapped in its own lock by then, that lock is linked back, and when even that is
// blocked (a third acquirer holds the path) it is kept under its claimed name and reported.
export async function releaseOwnedLock({ lockPath, identity, tag, fs = fsp }) {
  const probe = `${lockPath}.${tag}.probe`, claimed = `${lockPath}.${tag}.claimed`;
  try { await fs.link(lockPath, probe); }
  catch (error) { if (error.code === 'ENOENT') return { released: false }; throw error; }
  let ours = false;
  try { ours = same(await fs.stat(probe, { bigint: true }), identity); }
  finally { if (!ours) await fs.unlink(probe); }
  if (!ours) return { released: false };
  try { await fs.rename(lockPath, claimed); }
  catch (error) {
    await fs.unlink(probe);   // our last name: ours is gone either way
    if (error.code === 'ENOENT') return { released: true };
    throw error;
  }
  if (same(await fs.stat(claimed, { bigint: true }), identity)) {
    await fs.unlink(claimed); await fs.unlink(probe);
    return { released: true };
  }
  await fs.unlink(probe);
  try { await fs.link(claimed, lockPath); }
  catch (error) {
    throw new Error(`Another bridge's lock could not be restored to ${lockPath} (${error.code ?? error.message}); it is kept at ${claimed}`);
  }
  await fs.unlink(claimed);
  return { released: false };
}
