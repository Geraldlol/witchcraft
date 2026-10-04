import fs from 'node:fs/promises';
import path from 'node:path';
import { chunkName, assertOwnedChunk, atomicWrite } from './ring.js';
import { serializeChunk } from './lua.js';

export async function initializeRing({ addonsDir, ringSize = 3000, clean = false }) {
  if (!Number.isInteger(ringSize) || ringSize < 3 || ringSize > 9999) throw new Error('Ring size must be 3..9999');
  const root = path.resolve(addonsDir);
  if ((await fs.lstat(root)).isSymbolicLink() || await fs.realpath(root) !== root) throw new Error('Refusing linked AddOns directory');
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
    const name = chunkName(index), directory = path.join(root, name);
    if (!clean && owned.some(entry => entry.index === index)) continue;
    await fs.mkdir(directory);
    await atomicWrite(path.join(directory, 'Chunk.lua'), serializeChunk({ protocol: 1, ready: false, seq: index, ringSize }));
    await atomicWrite(path.join(directory, `${name}.toc`), `## Interface: 16001\n## Title: Witchcraft stream ${index}\n## LoadOnDemand: 1\n## Dependencies: Witchcraft\n## X-Witchcraft-Chunk: 1\n\nChunk.lua\n`);
    created++;
  }
  return { created, retained: clean ? 0 : owned.length, ringSize, restartRequired: created > 0 };
}
