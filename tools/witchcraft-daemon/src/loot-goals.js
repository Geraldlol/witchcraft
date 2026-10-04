import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { atomicWrite } from './ring.js';

export const PROFILE_SCHEMA = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/u);
export const ITEM_ID_SCHEMA = z.number().int().positive().max(2_147_483_647);
const stamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const goalSchema = z.object({ itemId: ITEM_ID_SCHEMA, status: z.enum(['active', 'acquired']), addedAt: stamp, updatedAt: stamp }).strict();
export const goalsSchema = z.object({ schemaVersion: z.literal(1), profiles: z.array(z.object({
  id: PROFILE_SCHEMA, goals: z.array(goalSchema).max(100),
}).strict()).max(20) }).strict().superRefine((value, ctx) => {
  if (new Set(value.profiles.map(profile => profile.id)).size !== value.profiles.length ||
    value.profiles.some(profile => new Set(profile.goals.map(goal => goal.itemId)).size !== profile.goals.length)) {
    ctx.addIssue({ code: 'custom', message: 'Duplicate profile or goal identity' });
  }
});
const MAX_BYTES = 256 * 1024;
export class GoalStoreError extends Error {
  constructor(code) { super(code); this.code = code; }
}
export function lootGoalsPath(cachePath) { return path.join(path.dirname(cachePath), `${path.basename(cachePath, '.json')}.loot-goals.json`); }

async function readDocument(file) {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new GoalStoreError('invalid-goal-store');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_BYTES) throw new GoalStoreError('invalid-goal-store');
    return goalsSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))));
  } catch (error) {
    if (error.code === 'ENOENT') return { schemaVersion: 1, profiles: [] };
    throw new GoalStoreError('invalid-goal-store');
  } finally { await handle?.close(); }
}

export async function readLootGoals(file, profile = 'personal') {
  PROFILE_SCHEMA.parse(profile);
  const document = await readDocument(file);
  return { profile, goals: document.profiles.find(row => row.id === profile)?.goals ?? [],
    scope: 'user-selected-profile', note: 'Goals are saved on this computer. The personal profile is shared; character profiles must be selected explicitly. Acquired state is user-marked, not an inventory observation.' };
}

/** Serialize both assistant processes, atomically replace valid documents, preserve corrupt/newer data. */
export async function setLootGoal(file, { profile = 'personal', itemId, status }, { now = Date.now } = {}) {
  PROFILE_SCHEMA.parse(profile); ITEM_ID_SCHEMA.parse(itemId); z.enum(['active', 'acquired', 'remove']).parse(status);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  let owned = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { await fs.mkdir(lock); owned = true; break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw new GoalStoreError('goal-store-unwritable');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  if (!owned) throw new GoalStoreError('goal-store-busy');
  try {
    const document = await readDocument(file);
    let group = document.profiles.find(row => row.id === profile);
    if (!group && status !== 'remove') {
      if (document.profiles.length >= 20) throw new GoalStoreError('profile-limit');
      group = { id: profile, goals: [] }; document.profiles.push(group);
    }
    const index = group?.goals.findIndex(goal => goal.itemId === itemId) ?? -1;
    if (status === 'remove') {
      if (index !== -1) group.goals.splice(index, 1);
      if (group && group.goals.length === 0) document.profiles = document.profiles.filter(row => row !== group);
    }
    else if (index !== -1) {
      if (group.goals[index].status !== status) {
        group.goals[index] = { ...group.goals[index], status, updatedAt: now() };
      }
    } else {
      if (group.goals.length >= 100) throw new GoalStoreError('goal-limit');
      const time = now(); group.goals.push({ itemId, status, addedAt: time, updatedAt: time });
    }
    goalsSchema.parse(document);
    const encoded = JSON.stringify(document, null, 2) + '\n';
    if (Buffer.byteLength(encoded) > MAX_BYTES) throw new GoalStoreError('goal-limit');
    // Bounded retry: Windows refuses a rename-over while something briefly holds the destination.
    await atomicWrite(file, encoded);
    return { profile, itemId, status, goals: group?.goals ?? [], scope: 'user-selected-profile',
      note: 'Saved locally. Acquired is user-marked; no game inventory was read or changed.' };
  } finally {
    await fs.rmdir(lock);
  }
}
