import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const DEFAULT_GUIDE_PATH = fileURLToPath(new URL('../data/guide-starter.json', import.meta.url));
export const MAX_GUIDE_BYTES = 1024 * 1024;
const id = z.number().int().positive().max(2_147_483_647);
const text = max => z.string().min(1).max(max).refine(value => !/[\u0000-\u001f\u007f-\u009f]/u.test(value));
const key = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/u);
const sourceIds = z.array(key).min(1).max(20);
const material = z.object({ itemId: id, count: z.number().int().positive().max(10000) }).strict();
const acquisition = z.object({ id: key, name: text(120), kind: z.enum(['dungeon', 'quest', 'craft', 'vendor', 'world']),
  sourceIds, encounter: text(120).optional(), prerequisiteQuestIds: z.array(id).max(100).optional(),
  materials: z.array(material).max(100).optional() }).strict();
export const guideSchema = z.object({
  schemaVersion: z.literal(1), id: key, title: text(160), sourceBuild: text(160), compatibility: z.literal('reference-only'),
  sources: z.array(z.object({ id: key, title: text(160),
    url: z.string().url().max(2048).refine(value => value.startsWith('https://')),
    revision: text(160) }).strict()).min(1).max(100),
  quests: z.array(z.object({ id, title: text(160), minLevel: z.number().int().min(1).max(1000).optional(),
    prerequisiteQuestIds: z.array(id).max(100).optional(), requiredItems: z.array(material).max(100).optional(),
    sourceIds, hints: z.object({ hint: text(1200), details: text(2400), solution: text(4000) }).strict(),
  }).strict()).max(2000),
  items: z.array(z.object({ id, name: text(160), sources: z.array(acquisition).max(20) }).strict()).max(2000),
}).strict().superRefine((catalog, ctx) => {
  for (const field of ['sources', 'quests', 'items']) {
    if (new Set(catalog[field].map(row => row.id)).size !== catalog[field].length) {
      ctx.addIssue({ code: 'custom', message: `Duplicate ${field} ID` });
    }
  }
  const known = new Set(catalog.sources.map(row => row.id));
  const rows = [...catalog.quests, ...catalog.items.flatMap(item => item.sources)];
  if (rows.some(row => row.sourceIds.some(value => !known.has(value)))) {
    ctx.addIssue({ code: 'custom', message: 'Unknown provenance source' });
  }
  const groups = new Map();
  for (const source of catalog.items.flatMap(item => item.sources)) {
    const descriptor = JSON.stringify([source.name, source.kind]);
    if (groups.has(source.id) && groups.get(source.id) !== descriptor) {
      ctx.addIssue({ code: 'custom', message: 'Conflicting acquisition source identity' });
    }
    groups.set(source.id, descriptor);
  }
});

/** Fixed local data only. Never evaluates Lua or fetches URLs carried in the catalog. */
export async function loadGuideCatalog(file = DEFAULT_GUIDE_PATH) {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_GUIDE_BYTES) throw new Error('Guide catalog exceeds its bound');
    const buffer = Buffer.alloc(MAX_GUIDE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_GUIDE_BYTES) throw new Error('Guide catalog exceeds its bound');
    return guideSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))));
  } finally { await handle.close(); }
}

export function findGuide(catalog, { query, kind = 'all', limit = 10 }) {
  const needle = query.trim().toLowerCase();
  const rows = [];
  if (kind !== 'item') for (const quest of catalog.quests) {
    if (String(quest.id) === needle || quest.title.toLowerCase().includes(needle)) {
      rows.push({ kind: 'quest', id: quest.id, name: quest.title });
    }
  }
  if (kind !== 'quest') for (const item of catalog.items) {
    if (String(item.id) === needle || item.name.toLowerCase().includes(needle)) {
      rows.push({ kind: 'item', id: item.id, name: item.name });
    }
  }
  rows.sort((a, b) => (String(b.id) === needle) - (String(a.id) === needle) || a.id - b.id);
  return { status: rows.length ? 'matches' : 'not-in-catalog', query, totalMatches: rows.length,
    results: rows.slice(0, limit), truncated: rows.length > limit,
    catalog: { id: catalog.id, title: catalog.title, sourceBuild: catalog.sourceBuild, compatibility: catalog.compatibility },
    note: 'This is a small reference catalog, not an exhaustive Forever database. Matching quest titles can represent different steps; use the quest ID. Search does not reveal solutions.' };
}
