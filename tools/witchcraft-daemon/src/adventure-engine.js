// Pure personal adventure planners. Catalog facts and user stamps are never live game evidence.
const ROLES = ['tank', 'healer', 'damage'];
const MODES = ['brief', 'quiz', 'answer', 'reveal'];
const INTERESTS = ['story', 'loot', 'exploration'];
const KINDS = ['dungeon', 'quest', 'exploration'];
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const normalize = value => value.trim().replace(/\s+/gu, ' ').toLowerCase();
const unique = values => [...new Set(values)];
const identity = row => JSON.stringify([row.kind, row.referenceId]);
const byName = (left, right) => compare(normalize(left.name), normalize(right.name)) || compare(left.id, right.id);
const catalogNote = 'Reference catalog facts are not verified for the current Forever build and do not establish live availability or eligibility.';
const passportNote = 'Passport stamps are user-confirmed personal milestones, not game-verified completions or official achievements.';
const validText = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
const validStamp = value => Number.isSafeInteger(value) && value >= 0;

function provenance(catalog, sourceIds = []) {
  const consulted = unique(sourceIds).sort(compare);
  return {
    catalogId: catalog.id, title: catalog.title, sourceBuild: catalog.sourceBuild,
    compatibility: 'reference-only', sourceIds: consulted,
    sources: (catalog.sources ?? []).filter(source => consulted.includes(source.id)).map(source => ({
      id: source.id, title: source.title, url: source.url, revision: source.revision,
    })).sort((left, right) => compare(left.id, right.id)),
  };
}

function passportEntries(passport = {}) {
  const entries = passport.entries ?? [];
  if (!Array.isArray(entries) || entries.length > 500 || entries.some(row => !KINDS.includes(row?.kind) ||
      !validText(row.referenceId, 160) || !validText(row.title, 160) || typeof row.note !== 'string' || row.note.length > 2000 ||
      !validStamp(row.completedAt) || !validStamp(row.updatedAt) || row.updatedAt < row.completedAt || row.evidence !== 'user-confirmed')) {
    throw new TypeError('passport entries must contain at most 500 valid user-confirmed stamps');
  }
  // Store rows are unique. If called with duplicates, latest edits win independently of input order.
  const sorted = entries.map(row => ({ kind: row.kind, referenceId: row.referenceId, title: row.title, note: row.note,
    completedAt: row.completedAt, updatedAt: row.updatedAt, evidence: 'user-confirmed' }))
    .sort((left, right) => right.updatedAt - left.updatedAt || right.completedAt - left.completedAt ||
      compare(JSON.stringify(left), JSON.stringify(right)));
  const deduplicated = new Map();
  for (const row of sorted) if (!deduplicated.has(identity(row))) deduplicated.set(identity(row), row);
  return [...deduplicated.values()].sort((left, right) => right.completedAt - left.completedAt || compare(identity(left), identity(right)));
}

function savedCampaignIds(passport = {}) {
  const values = passport.campaignIds ?? [];
  if (!Array.isArray(values) || values.length > 100 || values.some(value => !validText(value, 160))) {
    throw new TypeError('campaignIds must contain at most 100 nonempty IDs');
  }
  return unique(values).sort(compare);
}

function rehearsalGoals(guideCatalog, goals = [], dungeon, stage) {
  if (!Array.isArray(goals) || goals.length > 100 || goals.some(goal => !Number.isSafeInteger(goal?.itemId) || goal.itemId < 1 ||
      !['active', 'acquired'].includes(goal.status))) throw new TypeError('goals must contain at most 100 valid active or acquired item goals');
  const acquired = new Set(goals.filter(goal => goal.status === 'acquired').map(goal => goal.itemId));
  const active = unique(goals.filter(goal => goal.status === 'active' && !acquired.has(goal.itemId)).map(goal => goal.itemId)).sort((a, b) => a - b);
  if (!guideCatalog) return { status: 'catalog-unavailable', dungeonItems: [], encounterItems: [], unresolvedGoalIds: active };
  const items = new Map((guideCatalog.items ?? []).map(item => [item.id, item]));
  const dungeonItems = [], encounterItems = [], consulted = [], unresolvedGoalIds = [];
  for (const itemId of active) {
    const item = items.get(itemId);
    if (!item || !item.sources?.length) { unresolvedGoalIds.push(itemId); continue; }
    const sources = item.sources.filter(source => source.kind === 'dungeon' && source.id === dungeon.id);
    if (!sources.length) continue;
    consulted.push(...(item.sourceIds ?? []), ...sources.flatMap(source => source.sourceIds ?? []));
    dungeonItems.push({ itemId, name: item.name,
      encounters: unique(sources.map(source => source.encounter).filter(Boolean)).sort(compare) });
    if (sources.some(source => source.encounter && normalize(source.encounter) === normalize(stage.title))) {
      encounterItems.push({ itemId, name: item.name, encounter: stage.title });
    }
  }
  return { status: 'reference-only', dungeonGoalCount: dungeonItems.length, encounterGoalCount: encounterItems.length,
    dungeonItems, encounterItems, unresolvedGoalIds, provenance: provenance(guideCatalog, consulted) };
}

/** A stateless rehearsal: explicit stage indexes, role-specific advice and spoiler-separated quiz answers. */
export function rehearseDungeon({ catalog, guideCatalog, goals = [], dungeon, role = 'damage', step = 0, mode = 'brief', answerChoice }) {
  if (!validText(dungeon, 160)) throw new TypeError('dungeon must be a nonempty name or ID of at most 160 characters');
  if (!ROLES.includes(role)) throw new TypeError('role must be tank, healer or damage');
  if (!MODES.includes(mode)) throw new TypeError('mode must be brief, quiz, answer or reveal');
  if (!Number.isSafeInteger(step) || step < 0) throw new TypeError('step must be a nonnegative integer');
  if (answerChoice !== undefined && (!Number.isSafeInteger(answerChoice) || answerChoice < 0)) {
    throw new TypeError('answerChoice must be a nonnegative, zero-based choice index');
  }
  if (answerChoice !== undefined && mode !== 'answer') throw new TypeError('answerChoice requires answer mode');
  const needle = normalize(dungeon), all = catalog.dungeons ?? [];
  const matches = all.filter(row => [row.id, row.name, ...(row.aliases ?? [])].some(value => normalize(value) === needle));
  const base = { mode, role, provenance: provenance(catalog), limitations: [catalogNote,
    'Rehearsal advice is for manual preparation. It does not observe encounters, control gameplay, or verify readiness.',
    'Loot goals are user supplied. Listed sources are not drop probabilities or guaranteed rewards.'] };
  if (matches.length !== 1) {
    const nearby = all.filter(row => [row.id, row.name, ...(row.aliases ?? [])].some(value => normalize(value).includes(needle)));
    const candidates = [...(matches.length ? matches : nearby.length ? nearby : all)].sort(byName);
    return { ...base, status: matches.length ? 'ambiguous-dungeon' : 'unknown-dungeon', query: dungeon.trim(),
      candidates: candidates.slice(0, 25).map(row => ({ id: row.id, name: row.name, zone: row.zone })),
      totalCandidates: candidates.length, truncated: candidates.length > 25 };
  }
  const selected = matches[0], totalSteps = selected.steps.length;
  const result = { ...base, status: 'reference-rehearsal', dungeon: { id: selected.id, name: selected.name, zone: selected.zone },
    navigation: { totalSteps, previousStep: step > 0 && step < totalSteps ? step - 1 : null,
      nextStep: step < totalSteps - 1 ? step + 1 : null }, provenance: provenance(catalog, selected.sourceIds) };
  const stage = selected.steps[step];
  if (!stage) return { ...result, status: 'step-out-of-range', requestedStep: step,
    note: `This rehearsal has ${totalSteps} stages, indexed from 0. Choose an existing stage; progress does not wrap.` };
  result.step = { index: step, id: stage.id, title: stage.title };
  result.provenance = provenance(catalog, [...(selected.sourceIds ?? []), ...(stage.sourceIds ?? [])]);
  if (mode === 'brief') {
    result.step.briefing = stage.briefing;
    result.step.roleTip = stage.roleTips[role];
    result.lootGoals = rehearsalGoals(guideCatalog, goals, selected, stage);
  } else if (mode === 'quiz' || (mode === 'answer' && answerChoice === undefined)) {
    result.quiz = { question: stage.quiz.question, choices: [...stage.quiz.choices], choiceIndexBase: 0 };
    if (mode === 'answer') result.status = 'needs-answer';
  } else if (mode === 'reveal') {
    result.answer = { revealed: true, correctChoiceIndex: stage.quiz.answerIndex,
      correctChoice: stage.quiz.choices[stage.quiz.answerIndex], explanation: stage.quiz.explanation };
  } else {
    if (answerChoice >= stage.quiz.choices.length) throw new TypeError('answerChoice is outside this quiz\'s choices');
    result.answer = { choiceIndex: answerChoice, correct: answerChoice === stage.quiz.answerIndex,
      correctChoiceIndex: stage.quiz.answerIndex, correctChoice: stage.quiz.choices[stage.quiz.answerIndex], explanation: stage.quiz.explanation };
    result.lootGoals = rehearsalGoals(guideCatalog, goals, selected, stage);
  }
  return result;
}

function currentZone(context, requested) {
  if (requested !== undefined) {
    if (!validText(requested, 160)) throw new TypeError('zone must be a nonempty string of at most 160 characters');
    return { name: requested.trim(), source: 'user-selected' };
  }
  const player = context?.player, data = player?.data;
  if (context?.enabled === false || ['disabled', 'disconnected', 'waiting', 'unavailable'].includes(context?.status) ||
      context?.connection?.status !== 'connected' || player?.status !== 'available' || !validText(data?.location?.zone, 160) ||
      (data.unavailableFields ?? []).some(field => field === 'zone' || field.startsWith('zone:'))) return null;
  return { name: data.location.zone, source: 'current-player', sampledAt: player.sampledAt ?? null, ageSeconds: player.ageSeconds ?? null };
}

/** Suggest catalog entries in an explicitly chosen or currently observed zone, never inferred travel routes. */
export function suggestDetours({ catalog, context, passport, zone, interests = [], detail = 'hint', limit = 3 }) {
  if (!Array.isArray(interests) || interests.length > INTERESTS.length || interests.some(value => !INTERESTS.includes(value))) {
    throw new TypeError('interests must contain story, loot or exploration');
  }
  if (!['hint', 'details'].includes(detail)) throw new TypeError('detail must be hint or details');
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new TypeError('limit must be between 1 and 10');
  const selectedZone = currentZone(context, zone);
  const base = { detail, provenance: provenance(catalog), limitations: [catalogNote, passportNote,
    'Suggestions match a catalog zone, not distance, coordinates or travel time. Availability, access and faction eligibility are unknown.',
    'Tracked quest observations are not completion history and do not suppress suggestions.'] };
  if (!selectedZone) return { ...base, status: 'needs-zone', zone: null, results: [], totalMatches: 0, truncated: false,
    note: 'Choose a zone explicitly, or enable fresh player context with an intact zone name and a connected session.' };
  const stamped = new Set(passportEntries(passport).map(identity));
  const completed = row => stamped.has(identity({ kind: 'exploration', referenceId: row.id })) ||
    (row.questIds?.length > 0 ? row.questIds.every(id => stamped.has(identity({ kind: 'quest', referenceId: String(id) }))) :
      row.dungeonId && stamped.has(identity({ kind: 'dungeon', referenceId: row.dungeonId })));
  const matches = (catalog.detours ?? []).filter(row => normalize(row.zone) === normalize(selectedZone.name) &&
    (!interests.length || interests.some(interest => row.interests.includes(interest))) && !completed(row))
    .sort((left, right) => compare(normalize(left.title), normalize(right.title)) || compare(left.id, right.id));
  const selected = matches.slice(0, limit);
  return { ...base, status: 'reference-detours', zone: selectedZone, totalMatches: matches.length, truncated: matches.length > selected.length,
    results: selected.map(row => ({ id: row.id, title: row.title, zone: row.zone, interests: [...row.interests], summary: row.summary,
      ...(detail === 'details' ? { details: row.details, ...(row.dungeonId ? { dungeonId: row.dungeonId } : {}),
        ...(row.questIds?.length ? { questIds: [...row.questIds] } : {}) } : {}) })),
    provenance: provenance(catalog, selected.flatMap(row => row.sourceIds ?? [])) };
}

/** Reconcile personal stamps against the current catalog without dropping old or unknown saved references. */
export function summarizePassport({ catalog, guideCatalog, passport = {} }) {
  const timeline = passportEntries(passport), joined = savedCampaignIds(passport), stamped = new Set(timeline.map(identity));
  const known = new Set([
    ...(catalog.dungeons ?? []).map(row => identity({ kind: 'dungeon', referenceId: row.id })),
    ...(catalog.detours ?? []).map(row => identity({ kind: 'exploration', referenceId: row.id })),
    ...(catalog.detours ?? []).flatMap(row => (row.questIds ?? []).map(id => identity({ kind: 'quest', referenceId: String(id) }))),
    ...(catalog.campaigns ?? []).flatMap(row => row.milestones.map(identity)),
    ...(guideCatalog?.quests ?? []).map(row => identity({ kind: 'quest', referenceId: String(row.id) })),
  ]);
  const campaigns = (catalog.campaigns ?? []).map(campaign => {
    const uniqueMilestones = new Map();
    for (const milestone of campaign.milestones) if (!uniqueMilestones.has(identity(milestone))) uniqueMilestones.set(identity(milestone), milestone);
    const milestones = [...uniqueMilestones.values()].map(row => ({ id: row.id, title: row.title, description: row.description,
      kind: row.kind, referenceId: row.referenceId, status: stamped.has(identity(row)) ? 'user-confirmed' : 'not-stamped' }));
    const completedCount = milestones.filter(row => row.status === 'user-confirmed').length;
    return { id: campaign.id, title: campaign.title, description: campaign.description, joined: joined.includes(campaign.id),
      completedCount, totalCount: milestones.length, complete: milestones.length > 0 && completedCount === milestones.length, milestones };
  });
  const campaignIds = new Set(campaigns.map(row => row.id));
  return { status: 'personal-passport', profile: passport.profile ?? 'personal', evidence: 'user-confirmed', stampCount: timeline.length,
    timeline, campaigns, unknownCampaignIds: joined.filter(id => !campaignIds.has(id)),
    unresolvedEntries: timeline.filter(row => !known.has(identity(row))), provenance: provenance(catalog),
    limitations: [catalogNote, passportNote, 'Unknown saved references are retained. Removing or changing a catalog does not erase personal history.'] };
}
