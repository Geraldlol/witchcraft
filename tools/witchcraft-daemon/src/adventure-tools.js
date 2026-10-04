import { z } from 'zod';
import { DEFAULT_ADVENTURE_PATH, ADVENTURE_KEY, ADVENTURE_KIND, REFERENCE_ID, loadAdventureCatalog, resolvePassportReference } from './adventure-catalog.js';
import { DEFAULT_GUIDE_PATH, loadGuideCatalog } from './guide-catalog.js';
import { GoalStoreError, PROFILE_SCHEMA, readLootGoals } from './loot-goals.js';
import { PASSPORT_NOTE, PassportError, readPassport, stampPassport, setPassportCampaign } from './passport-store.js';
import { rehearseDungeon, suggestDetours, summarizePassport } from './adventure-engine.js';

const profile = PROFILE_SCHEMA.default('personal');
const query = z.string().trim().min(1).max(160).refine(value => !/[\u0000-\u001f\u007f-\u009f]/u.test(value));
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const writeLocal = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
const response = result => ({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result });

export function registerAdventureTools(server, { readContext, goalsPath, passportPath, adventurePath = DEFAULT_ADVENTURE_PATH,
  guidePath = DEFAULT_GUIDE_PATH, now = Date.now, allowWrites = false }) {
  const wrap = handler => async args => {
    try { return response(await handler(args)); }
    catch (error) {
      const reason = error instanceof PassportError || error instanceof GoalStoreError ? error.code : 'adventure-unavailable';
      return { ...response({ status: 'unavailable', reason,
        note: 'The local adventure reference or personal data could not be read or saved. Existing invalid/newer data is preserved. Busy locks are not reclaimed automatically.' }), isError: true };
    }
  };
  server.registerTool('wow_rehearse_dungeon', {
    title: 'Dungeon rehearsal', description: 'List supported dungeons when dungeon is omitted. With a dungeon and explicitly chosen tank/healer/damage role, show one indexed reference boss card and relevant saved loot goals. Steps are selected cards, not a complete route. mode quiz hides the answer; mode answer grades only the supplied zero-based answerChoice; reveal shows an explicitly requested answer without grading. Ask for a role when missing; do not silently assume damage. Preparing or answering a quiz never awards a passport stamp. Classic mechanics remain unverified for Forever.',
    inputSchema: z.object({ dungeon: query.optional(), role: z.enum(['tank', 'healer', 'damage']).optional(),
      step: z.number().int().min(0).max(29).default(0), mode: z.enum(['brief', 'quiz', 'answer', 'reveal']).default('brief'),
      answerChoice: z.number().int().min(0).max(4).optional(), profile }).strict()
      .refine(value => value.answerChoice === undefined || value.mode === 'answer', { message: 'answerChoice requires answer mode' }), annotations: readOnly,
  }, wrap(async args => {
    const catalog = await loadAdventureCatalog(adventurePath);
    if (!args.dungeon) return { status: 'choose-dungeon', dungeons: catalog.dungeons.map(row => ({ id: row.id, name: row.name, zone: row.zone, steps: row.steps.length })),
      roles: ['tank', 'healer', 'damage'], compatibility: catalog.compatibility, sourceBuild: catalog.sourceBuild };
    if (!args.role) return { status: 'needs-role', dungeon: args.dungeon, roles: ['tank', 'healer', 'damage'], note: 'Choose your practice role before the briefing.' };
    // A damaged wishlist must not disable independent study, or masquerade as an empty wishlist.
    let saved, wishlistStatus = 'available';
    try { saved = await readLootGoals(goalsPath, args.profile); }
    catch (error) { if (!(error instanceof GoalStoreError)) throw error; saved = { goals: [] }; wishlistStatus = error.code; }
    const result = rehearseDungeon({ ...args, catalog, guideCatalog: await loadGuideCatalog(guidePath), goals: saved.goals });
    if (wishlistStatus !== 'available' && result.lootGoals) result.lootGoals = { status: 'unavailable', reason: wishlistStatus };
    return { ...result, profile: args.profile, wishlistStatus };
  }));
  server.registerTool('wow_suggest_detours', {
    title: 'While you are here', description: 'Suggest a few unfinished personal discoveries in an exact zone, filtered by story/loot/exploration interests. Omit zone to request current player context; a stale, disconnected or missing zone requires explicit selection. Explicit zone is user-selected, not a live observation. Match zone only, never claim nearby distance or ETA. hint omits detail locations and quest IDs; details requires the user choosing more detail. User-confirmed passport stamps suppress matching outings; tracked objectives never count as turn-ins.',
    inputSchema: z.object({ zone: query.optional(), interests: z.array(z.enum(['story', 'loot', 'exploration'])).max(3).default([]),
      detail: z.enum(['hint', 'details']).default('hint'), limit: z.number().int().min(1).max(10).default(3), profile }).strict(), annotations: readOnly,
  }, wrap(async args => {
    const catalog = await loadAdventureCatalog(adventurePath);
    const passport = await readPassport(passportPath, args.profile);
    const context = args.zone ? undefined : await readContext(['player']);
    return { ...suggestDetours({ ...args, catalog, context, passport }), profile: args.profile,
      supportedZones: [...new Set(catalog.detours.map(row => row.zone))].sort() };
  }));
  server.registerTool('wow_get_passport', {
    title: 'Adventure passport', description: 'Read user-confirmed personal milestones and scrapbook notes, campaign templates and progress. The personal profile is shared; choose a character profile explicitly. A stamp is a user report, never proof of an official achievement, kill, visit or quest turn-in. Unknown older entries are retained. Reading does not enroll or stamp anything.',
    inputSchema: z.object({ profile }).strict(), annotations: readOnly,
  }, wrap(async args => summarizePassport({ catalog: await loadAdventureCatalog(adventurePath), guideCatalog: await loadGuideCatalog(guidePath), passport: await readPassport(passportPath, args.profile) })));
  if (!allowWrites) return;   // the two passport writes below need witchcraft-mcp --allow-local-writes
  server.registerTool('wow_stamp_passport', {
    title: 'Record a personal milestone', description: 'Write only when the user explicitly confirms completing a dungeon/quest/exploration milestone or requests its removal. Do not stamp from entering a zone, finished quest objectives, a rehearsal or a correct quiz answer. referenceId must be a catalog dungeon/detour ID or known numeric quest ID as a string. complete records a user-confirmed stamp; optional note preserves a short memory. Omitted note keeps an existing note; empty note clears it. remove allows retiring a saved reference even if no longer cataloged.',
    inputSchema: z.object({ profile, kind: ADVENTURE_KIND, referenceId: REFERENCE_ID, status: z.enum(['complete', 'remove']), note: PASSPORT_NOTE.optional() }).strict(), annotations: writeLocal,
  }, wrap(async args => {
    const catalog = await loadAdventureCatalog(adventurePath);
    const guideCatalog = await loadGuideCatalog(guidePath);
    const title = args.status === 'complete' ? resolvePassportReference(catalog, guideCatalog, args.kind, args.referenceId) : undefined;
    if (args.status === 'complete' && !title) return { status: 'unknown-reference', kind: args.kind, referenceId: args.referenceId,
      note: 'No stamp was saved. Choose a supported reference from the passport, detour or dungeon catalog; do not guess an ID.' };
    const passport = await stampPassport(passportPath, { ...args, title }, { now });
    return { ...summarizePassport({ catalog, guideCatalog, passport }), status: 'saved', operation: args.status, saved: true };
  }));
  server.registerTool('wow_set_passport_campaign', {
    title: 'Choose a personal campaign', description: 'Save an active personal campaign when the user asks to start it, or remove its enrollment. Removing a campaign preserves all stamps and notes. Enrollment does not complete its milestones. Use wow_get_passport to choose a supported campaign ID; missing older campaigns may still be removed.',
    inputSchema: z.object({ profile, campaignId: ADVENTURE_KEY, status: z.enum(['active', 'remove']) }).strict(), annotations: writeLocal,
  }, wrap(async args => {
    const catalog = await loadAdventureCatalog(adventurePath);
    const guideCatalog = await loadGuideCatalog(guidePath);
    if (args.status === 'active' && !catalog.campaigns.some(row => row.id === args.campaignId)) return { status: 'unknown-campaign', campaignId: args.campaignId, note: 'No enrollment was saved.' };
    const passport = await setPassportCampaign(passportPath, args);
    return { ...summarizePassport({ catalog, guideCatalog, passport }), saved: true, operation: args.status };
  }));
}
