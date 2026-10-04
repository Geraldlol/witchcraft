import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const DEFAULT_ADVENTURE_PATH = fileURLToPath(new URL('../data/adventure-starter.json', import.meta.url));
export const ADVENTURE_KEY = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/u);
export const ADVENTURE_KIND = z.enum(['dungeon', 'quest', 'exploration']);
export const REFERENCE_ID = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/u);
const text = max => z.string().min(1).max(max).refine(value => !/[\u0000-\u001f\u007f-\u009f]/u.test(value));
const ids = z.array(ADVENTURE_KEY).min(1).max(20);
const positive = z.number().int().positive().max(2_147_483_647);
const quiz = z.object({ question: text(600), choices: z.array(text(600)).min(2).max(5), answerIndex: z.number().int().min(0).max(4),
  explanation: text(1200) }).strict().refine(value => value.answerIndex < value.choices.length);
const step = z.object({ id: ADVENTURE_KEY, title: text(160), briefing: text(1200),
  roleTips: z.object({ tank: text(800), healer: text(800), damage: text(800) }).strict(), quiz, sourceIds: ids }).strict();
export const adventureSchema = z.object({ schemaVersion: z.literal(1), id: ADVENTURE_KEY, title: text(160),
  sourceBuild: text(200), compatibility: z.literal('reference-only'),
  sources: z.array(z.object({ id: ADVENTURE_KEY, title: text(200), url: z.string().url().max(2048).refine(value => value.startsWith('https://')),
    revision: text(160) }).strict()).min(1).max(100),
  dungeons: z.array(z.object({ id: ADVENTURE_KEY, name: text(160), aliases: z.array(text(120)).max(20), zone: text(120),
    sourceIds: ids, steps: z.array(step).min(1).max(30) }).strict()).max(100),
  detours: z.array(z.object({ id: ADVENTURE_KEY, title: text(160), zone: text(120),
    interests: z.array(z.enum(['story', 'loot', 'exploration'])).min(1).max(3), summary: text(300), details: text(1200),
    dungeonId: ADVENTURE_KEY.optional(), questIds: z.array(positive).max(20).optional(), sourceIds: ids }).strict()).max(500),
  campaigns: z.array(z.object({ id: ADVENTURE_KEY, title: text(160), description: text(1200),
    milestones: z.array(z.object({ id: ADVENTURE_KEY, title: text(160), description: text(1200), kind: ADVENTURE_KIND,
      referenceId: REFERENCE_ID }).strict()).min(1).max(100) }).strict()).max(100),
}).strict().superRefine((catalog, ctx) => {
  const invalid = message => ctx.addIssue({ code: 'custom', message });
  for (const group of [catalog.sources, catalog.dungeons, catalog.detours, catalog.campaigns, ...catalog.dungeons.map(row => row.steps),
    ...catalog.campaigns.map(row => row.milestones)]) {
    if (new Set(group.map(row => row.id)).size !== group.length) invalid('Duplicate catalog identity');
  }
  const sources = new Set(catalog.sources.map(row => row.id));
  if ([...catalog.dungeons, ...catalog.detours, ...catalog.dungeons.flatMap(row => row.steps)]
    .some(row => row.sourceIds.some(id => !sources.has(id)))) invalid('Unknown catalog source');
  const dungeons = new Set(catalog.dungeons.map(row => row.id));
  const detours = new Set(catalog.detours.map(row => row.id));
  if (catalog.detours.some(row => row.dungeonId && !dungeons.has(row.dungeonId))) invalid('Unknown detour dungeon');
  for (const campaign of catalog.campaigns) {
    if (new Set(campaign.milestones.map(row => `${row.kind}:${row.referenceId}`)).size !== campaign.milestones.length) invalid('Duplicate campaign destination');
    for (const row of campaign.milestones) {
      if (row.kind === 'dungeon' && !dungeons.has(row.referenceId)) invalid('Unknown milestone dungeon');
      if (row.kind === 'exploration' && !detours.has(row.referenceId)) invalid('Unknown milestone detour');
      if (row.kind === 'quest' && (!/^[1-9]\d{0,9}$/u.test(row.referenceId) || Number(row.referenceId) > 2_147_483_647)) invalid('Invalid quest reference');
    }
  }
});

export async function loadAdventureCatalog(file = DEFAULT_ADVENTURE_PATH) {
  const handle = await fs.open(file, 'r');
  const maxBytes = 1024 * 1024;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error('Adventure catalog exceeds its bound');
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maxBytes) throw new Error('Adventure catalog exceeds its bound');
    return adventureSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))));
  } finally { await handle.close(); }
}

export function resolvePassportReference(catalog, guide, kind, referenceId) {
  if (kind === 'dungeon') return catalog.dungeons.find(row => row.id === referenceId)?.name ?? null;
  if (kind === 'exploration') return catalog.detours.find(row => row.id === referenceId)?.title ?? null;
  if (!/^[1-9]\d{0,9}$/u.test(referenceId) || Number(referenceId) > 2_147_483_647) return null;
  const quest = guide.quests.find(row => String(row.id) === referenceId);
  if (quest) return quest.title;
  const milestone = catalog.campaigns.flatMap(row => row.milestones).find(row => row.kind === 'quest' && row.referenceId === referenceId);
  if (milestone) return milestone.title;
  return catalog.detours.some(row => row.questIds?.includes(Number(referenceId))) ? `Quest ${referenceId}` : null;
}
