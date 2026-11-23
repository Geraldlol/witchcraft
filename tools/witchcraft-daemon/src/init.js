import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chunkName, assertOwnedChunk, isTransientWriteError } from './ring.js';
import { serializeChunk } from './lua.js';
import { acquireRingLock } from './bridge-lock.js';

// Each helper is built in a sibling folder with this name shape, which never matches a slot.
const TEMP_PATTERN = /^\.Witchcraft_Chunk_(?!0000)\d{4}\.tmp-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const writeNew = (file, contents) => fs.writeFile(file, contents, { flag: 'wx', mode: 0o600 });

export async function initializeRing({ addonsDir, ringSize = 3000, clean = false, write = writeNew }) {
  if (!Number.isInteger(ringSize) || ringSize < 3 || ringSize > 9999) throw new Error('Ring size must be 3..9999');
  const root = path.resolve(addonsDir);
  if ((await fs.lstat(root)).isSymbolicLink() || await fs.realpath(root) !== root) throw new Error('Refusing linked AddOns directory');
  const release = await acquireRingLock(root, clean ? 'clean' : 'init');
  try { return await initializeSlots(root, ringSize, clean, write); }
  finally { await release(); }
}

async function initializeSlots(root, ringSize, clean, write) {
  // Only initializeRing calls this, under the client ring lock, so a temp folder of this shape is
  // left over from an interrupted init, never another init's work in progress.
  for (const name of (await fs.readdir(root)).filter(name => TEMP_PATTERN.test(name))) {
    const leftover = path.join(root, name), info = await fs.lstat(leftover);
    if (info.isDirectory() && !info.isSymbolicLink()) await fs.rm(leftover, { recursive: true, force: true });
  }
  const existing = (await fs.readdir(root)).filter(name => /^Witchcraft_Chunk_\d{4}$/u.test(name));
  const owned = [];
  // Validate every existing reserved path before making any change.
  for (const name of existing) {
    const index = Number(name.slice(-4));
    const directory = await assertOwnedChunk(root, index);
    const files = await fs.readdir(directory);
    if (files.some(file => ![`${name}.toc`, 'Chunk.lua'].includes(file))) throw new Error(`Unexpected files in ${name}; preserving it`);
    for (const file of files) if ((await fs.lstat(path.join(directory, file))).isSymbolicLink()) throw new Error(`Linked file in ${name}`);
    owned.push({ index, directory });
  }
  if (clean) {
    for (const { directory } of owned) {
      const resolved = path.resolve(directory);
      if (path.dirname(resolved) !== root || !/^Witchcraft_Chunk_\d{4}$/u.test(path.basename(resolved))) throw new Error('Cleanup escaped owned root');
      await assertOwnedChunk(root, Number(path.basename(resolved).slice(-4)));
      await fs.rm(resolved, { recursive: true });
    }
  }
  let created = 0;
  for (let index = 1; index <= ringSize; index++) {
    if (!clean && owned.some(entry => entry.index === index)) continue;
    await buildSlot(root, index, ringSize, write);
    created++;
  }
  return { created, retained: clean ? 0 : owned.length, ringSize, restartRequired: created > 0 };
}

// The helper is complete, TOC last, before it is renamed into its slot, so an interruption never
// leaves a slot folder without its TOC. The rename retries the transient refusals atomicWrite does.
async function buildSlot(root, index, ringSize, write, { attempts = 12, delayMs = 25 } = {}) {
  const name = chunkName(index), directory = path.join(root, name);
  const temporary = path.join(root, `.${name}.tmp-${randomUUID()}`);
  try {
    await fs.mkdir(temporary);
    await write(path.join(temporary, 'Chunk.lua'), serializeChunk({ protocol: 1, ready: false, seq: index, ringSize }));
    await write(path.join(temporary, `${name}.toc`), `## Interface: 16001\n## Title: Witchcraft stream ${index}\n## LoadOnDemand: 1\n## Dependencies: Witchcraft\n## X-Witchcraft-Chunk: 1\n\nChunk.lua\n`);
    // A folder that appeared after the inventory is not ours. Checked here because a POSIX rename
    // would replace an empty directory; between this check and the rename only an empty directory
    // could still be replaced, never a file, and Node has no no-replace rename for directories.
    if (await fs.lstat(directory).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) {
      throw new Error(`${name} appeared during init; preserving it`);
    }
    for (let attempt = 1; ; attempt++) {
      try { await fs.rename(temporary, directory); return; }
      catch (error) {
        if (!isTransientWriteError(error) || attempt >= attempts) throw error;
        await new Promise(resolve => setTimeout(resolve, delayMs * attempt));
      }
    }
  } catch (error) {
    // A failed removal must not hide the original error; the next init sweeps the leftover.
    await fs.rm(temporary, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
