import { z } from 'zod';
import { DEFAULT_GUIDE_PATH, findGuide, loadGuideCatalog } from './guide-catalog.js';
import { diagnoseQuest, searchLoot, planLoot } from './guide-engine.js';
import { GoalStoreError, ITEM_ID_SCHEMA, PROFILE_SCHEMA, readLootGoals, setLootGoal } from './loot-goals.js';

const query = z.string().trim().min(1).max(160).refine(value => !/[\u0000-\u001f\u007f-\u009f]/u.test(value));
const completions = z.array(ITEM_ID_SCHEMA).max(500).default([]);
const profile = PROFILE_SCHEMA.default('personal');
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const response = result => ({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result });

export function registerGuideTools(server, { readContext, goalsPath, guidePath = DEFAULT_GUIDE_PATH, now = Date.now, allowWrites = false }) {
  const wrap = handler => async args => {
    try { return response(await handler(args)); }
    catch (error) {
      const reason = error instanceof GoalStoreError ? error.code : 'guide-unavailable';
      return { ...response({ status: 'unavailable', reason,
        note: reason === 'invalid-goal-store' ? 'The saved goals could not be read. Existing data was preserved; do not reset it automatically.' :
          reason === 'goal-store-busy' ? 'Another goals writer holds the lock. Retry later; a crashed writer requires manual lock recovery.' :
          'The local guide or goals could not be read or saved. No gameplay action was taken.' }), isError: true };
    }
  };
  server.registerTool('wow_find_guide', {
    title: 'Find a quest or loot reference', description: 'Search the small bundled reference catalog by name or numeric ID. It is not an exhaustive Forever database. Search reveals no quest solutions. Duplicate quest titles are separate steps; choose by ID or ask the user to disambiguate.',
    inputSchema: z.object({ query, kind: z.enum(['quest', 'item', 'all']).default('all'), limit: z.number().int().min(1).max(25).default(10) }).strict(), annotations: readOnly,
  }, wrap(async args => findGuide(await loadGuideCatalog(guidePath), args)));
  server.registerTool('wow_explain_quest', {
    title: 'Quest blocker detective', description: 'Compare one reference quest with character and TRACKED quest observations. Default hint is spoiler-light; use details or solution only when requested. References are unverified for Forever. Absence from tracked quests does not mean incomplete or unavailable. completedQuestIds must be explicit user assertions of prior turn-ins, never inferred from an objective-complete flag. Missing evidence stays unknown.',
    inputSchema: z.object({ questId: ITEM_ID_SCHEMA, detail: z.enum(['hint', 'details', 'solution']).default('hint'), completedQuestIds: completions }).strict(), annotations: readOnly,
  }, wrap(async args => {
    const catalog = await loadGuideCatalog(guidePath);
    return diagnoseQuest({ ...args, catalog, context: await readContext(['player', 'quests']) });
  }));
  server.registerTool('wow_get_loot_sources', {
    title: 'Find loot sources', description: 'Find reference acquisition sources and encounters for items by name or ID. Does not save a goal. Classic references are not verified Forever drop tables; no drop probability or ownership is inferred.',
    inputSchema: z.object({ query, limit: z.number().int().min(1).max(25).default(10) }).strict(), annotations: readOnly,
  }, wrap(async args => searchLoot({ ...args, catalog: await loadGuideCatalog(guidePath) })));
  server.registerTool('wow_get_loot_plan', {
    title: 'Plan saved loot goals', description: 'Read local saved goals and rank sources by how many distinct active wishlist items each covers. This is coverage, not drop chance, travel time, or an upgrade score. The personal profile is shared; select an explicit profile for a character. Acquired state and completedQuestIds are user assertions, not game observations. Recipe quantities are not a bag-aware shopping list.',
    inputSchema: z.object({ profile, completedQuestIds: completions }).strict(), annotations: readOnly,
  }, wrap(async args => {
    const saved = await readLootGoals(goalsPath, args.profile);
    return { ...planLoot({ catalog: await loadGuideCatalog(guidePath), goals: saved.goals, completedQuestIds: args.completedQuestIds }),
      profile: saved.profile, goals: saved.goals, goalScope: saved.scope, goalNote: saved.note };
  }));
  // Local writes exist only when the launcher grants them (witchcraft-mcp --allow-local-writes).
  if (allowWrites) server.registerTool('wow_set_loot_goal', {
    title: 'Save or update a loot goal', description: 'Write a local wishlist only when the user asks to add, mark acquired, reopen, or remove an item. active adds/reopens, acquired is manually marked, remove deletes this goal. Does not change game inventory. Use wow_find_guide for name-to-ID lookup; never guess an item ID. Unknown IDs can be saved but remain unresolved. personal is shared; a separate profile must be chosen explicitly.',
    inputSchema: z.object({ profile, itemId: ITEM_ID_SCHEMA, status: z.enum(['active', 'acquired', 'remove']) }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, wrap(args => setLootGoal(goalsPath, args, { now })));
}
