import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { atomicWrite } from './ring.js';
import { PROFILE_SCHEMA } from './loot-goals.js';
import { ADVENTURE_KEY, ADVENTURE_KIND, REFERENCE_ID } from './adventure-catalog.js';

export const PASSPORT_NOTE = z.string().max(600).refine(value => !/[\u0000-\u001f\u007f-\u009f]/u.test(value));
const title = z.string().min(1).max(160).refine(value => !/[\u0000-\u001f\u007f-\u009f]/u.test(value));
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const identity = z.object({ kind: ADVENTURE_KIND, referenceId: REFERENCE_ID }).refine(value => value.kind !== 'quest' ||
  (/^[1-9]\d{0,9}$/u.test(value.referenceId) && Number(value.referenceId) <= 2_147_483_647));
const entry = z.object({ kind: ADVENTURE_KIND, referenceId: REFERENCE_ID, title, note: PASSPORT_NOTE,
  completedAt: time, updatedAt: time, evidence: z.literal('user-confirmed') }).strict()
  .refine(value => value.updatedAt >= value.completedAt && identity.safeParse(value).success);
export const passportSchema = z.object({ schemaVersion: z.literal(1), profiles: z.array(z.object({ id: PROFILE_SCHEMA,
  campaignIds: z.array(ADVENTURE_KEY).max(20), entries: z.array(entry).max(100) }).strict()).max(20) }).strict()
  .superRefine((value, ctx) => {
    if (new Set(value.profiles.map(row => row.id)).size !== value.profiles.length || value.profiles.some(row =>
      new Set(row.campaignIds).size !== row.campaignIds.length || new Set(row.entries.map(item => `${item.kind}:${item.referenceId}`)).size !== row.entries.length)) {
      ctx.addIssue({ code: 'custom', message: 'Duplicate passport identity' });
    }
  });
const MAX_BYTES = 1024 * 1024;
export class PassportError extends Error {
  constructor(code) { super(code); this.code = code; }
}
export const passportPath = cachePath => path.join(path.dirname(cachePath), `${path.basename(cachePath, '.json')}.passport.json`);

async function readDocument(file) {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('size');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_BYTES) throw new Error('size');
    return passportSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))));
  } catch (error) {
    if (error.code === 'ENOENT') return { schemaVersion: 1, profiles: [] };
    throw new PassportError('invalid-passport-store');
  } finally { await handle?.close(); }
}

export async function readPassport(file, profile = 'personal') {
  PROFILE_SCHEMA.parse(profile);
  const document = await readDocument(file);
  const row = document.profiles.find(item => item.id === profile);
  return { profile, entries: row?.entries ?? [], campaignIds: row?.campaignIds ?? [] };
}

async function updatePassport(file, profile, mutate) {
  PROFILE_SCHEMA.parse(profile);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  let owned = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { await fs.mkdir(lock); owned = true; break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw new PassportError('passport-store-unwritable');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  if (!owned) throw new PassportError('passport-store-busy');
  try {
    const document = await readDocument(file);
    const index = document.profiles.findIndex(row => row.id === profile);
    const row = index < 0 ? { id: profile, entries: [], campaignIds: [] } : document.profiles[index];
    mutate(row);
    if (!row.entries.length && !row.campaignIds.length) {
      if (index >= 0) document.profiles.splice(index, 1);
    } else if (index < 0) {
      if (document.profiles.length >= 20) throw new PassportError('passport-profile-limit');
      document.profiles.push(row);
    }
    const validated = passportSchema.parse(document);
    const encoded = JSON.stringify(validated, null, 2) + '\n';
    if (Buffer.byteLength(encoded) > MAX_BYTES) throw new PassportError('passport-size-limit');
    // Bounded retry: Windows refuses a rename-over while something briefly holds the destination.
    await atomicWrite(file, encoded);
    return { profile, entries: row.entries, campaignIds: row.campaignIds };
  } finally {
    await fs.rmdir(lock);
  }
}

export async function stampPassport(file, { profile = 'personal', kind, referenceId, title: label, status, note }, { now = Date.now } = {}) {
  identity.parse({ kind, referenceId });
  z.enum(['complete', 'remove']).parse(status);
  if (status === 'complete') title.parse(label);
  if (note !== undefined) PASSPORT_NOTE.parse(note);
  return updatePassport(file, profile, row => {
    const index = row.entries.findIndex(item => item.kind === kind && item.referenceId === referenceId);
    if (status === 'remove') { if (index >= 0) row.entries.splice(index, 1); return; }
    const old = index >= 0 ? row.entries[index] : null;
    if (old && (note === undefined || note === old.note)) return;
    if (!old && row.entries.length >= 100) throw new PassportError('passport-stamp-limit');
    const clock = time.parse(now());
    const value = { kind, referenceId, title: old?.title ?? label, note: note ?? '', completedAt: old?.completedAt ?? clock,
      updatedAt: Math.max(clock, old?.updatedAt ?? 0), evidence: 'user-confirmed' };
    if (old) row.entries[index] = value; else row.entries.push(value);
  });
}

export async function setPassportCampaign(file, { profile = 'personal', campaignId, status }) {
  ADVENTURE_KEY.parse(campaignId); z.enum(['active', 'remove']).parse(status);
  return updatePassport(file, profile, row => {
    if (status === 'remove') row.campaignIds = row.campaignIds.filter(id => id !== campaignId);
    else if (!row.campaignIds.includes(campaignId)) {
      if (row.campaignIds.length >= 20) throw new PassportError('passport-campaign-limit');
      row.campaignIds.push(campaignId);
    }
  });
}
