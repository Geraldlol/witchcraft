// Pure planners over a validated, bounded reference catalog. No gameplay or file I/O.
const MAX_GOALS = 100;
const MAX_COMPLETED = 500;
const DETAILS = ['hint', 'details', 'solution'];
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const byName = (left, right) => compare(left.name.toLowerCase(), right.name.toLowerCase()) || compare(left.id, right.id);
const unique = values => [...new Set(values)];
const catalogNote = 'Reference catalog facts are not verified for the current Forever build and do not establish live availability or eligibility.';
const questNote = 'Tracked quests are a partial view, not completion history. Finished objectives do not prove reward collection or turn-in.';
const validId = value => Number.isSafeInteger(value) && value > 0;
const itemSourceIds = item => [...(item?.sourceIds ?? []), ...(item?.sources ?? []).flatMap(source => source.sourceIds ?? [])];

function completedSet(values) {
  if (!Array.isArray(values) || values.length > MAX_COMPLETED || values.some(id => !validId(id))) {
    throw new TypeError(`completedQuestIds must contain at most ${MAX_COMPLETED} positive integer IDs`);
  }
  return new Set(values);
}

function provenance(catalog, sourceIds = []) {
  const consulted = unique(sourceIds).sort(compare);
  return {
    catalogId: catalog.id, title: catalog.title, sourceBuild: catalog.sourceBuild,
    compatibility: catalog.compatibility, sourceIds: consulted,
    sources: (catalog.sources ?? []).filter(source => consulted.includes(source.id)).map(source => ({
      id: source.id, title: source.title, url: source.url, revision: source.revision,
    })).sort((left, right) => compare(left.id, right.id)),
  };
}

function domainEvidence(context, name) {
  const domain = context?.[name];
  const hasData = domain?.data != null && ['available', 'stale'].includes(domain.status);
  return {
    status: !hasData ? 'unavailable' : context?.connection?.status === 'connected' && domain.status === 'available' ? 'current' : 'historical',
    domainStatus: domain?.status ?? 'missing',
    ageSeconds: domain?.ageSeconds ?? null,
    sampledAt: domain?.sampledAt ?? null,
    data: hasData ? domain.data : null,
  };
}

function observeQuest(context, questId, detail) {
  const { data, ...evidence } = domainEvidence(context, 'quests');
  const row = data?.quests?.find(quest => quest.id === questId);
  return {
    ...evidence, connection: context?.connection?.status ?? 'unknown',
    trackedState: row ? 'observed' : data ? 'not-observed-in-tracked-batch' : 'unavailable',
    trackedBatchTruncated: data?.truncated ?? null,
    trackedCount: data?.trackedCount ?? null,
    ...(row ? { objectivesComplete: row.complete === true, objectivesTruncated: row.truncated === true,
      ...(detail !== 'hint' ? { objectives: (row.objectives ?? []).map(objective => ({
        text: objective.text, fulfilled: objective.fulfilled, required: objective.required, finished: objective.finished,
      })) } : {}) } : {}),
  };
}

function requirements(ids, completed, quests) {
  return unique(ids ?? []).map(id => ({ questId: id, title: quests.get(id)?.title ?? null,
    status: completed.has(id) ? 'user-asserted-completed' : 'unknown',
  })).sort((left, right) => left.questId - right.questId);
}

function selectGuidance(quest, detail) {
  const allowed = DETAILS.slice(0, DETAILS.indexOf(detail) + 1).reverse();
  const available = allowed.find(level => typeof quest.hints?.[level] === 'string' && quest.hints[level].length > 0);
  return available ? { status: 'available', detail: available, text: quest.hints[available] } : { status: 'unavailable', detail, text: null };
}

/** User completion assertions and observations stay separate from catalog requirements. */
export function diagnoseQuest({ catalog, context, questId, detail = 'hint', completedQuestIds = [] }) {
  if (!validId(questId)) throw new TypeError('questId must be a positive integer');
  if (!DETAILS.includes(detail)) throw new TypeError('detail must be hint, details or solution');
  const completed = completedSet(completedQuestIds);
  const quests = new Map((catalog.quests ?? []).map(quest => [quest.id, quest]));
  const quest = quests.get(questId);
  const observation = observeQuest(context, questId, detail);
  const result = {
    status: quest ? 'reference-guidance' : 'unknown-quest',
    quest: { id: questId, title: quest?.title ?? null,
      completion: completed.has(questId) ? 'user-asserted-completed' : 'unknown' },
    detail, observation, guidance: quest ? selectGuidance(quest, detail) : null,
    provenance: provenance(catalog, quest?.sourceIds),
    limitations: [catalogNote, questNote, 'Inventory and historical quest completions are not observed by this tool.',
      'Faction, race, class and alternate quest conditions are not modeled. Live faction is unavailable; a listed chain may not apply to this character.'],
  };
  if (!quest) return result;
  const { data: player, ...levelEvidence } = domainEvidence(context, 'player');
  const observedLevel = validId(player?.level) ? player.level : null;
  const minimum = validId(quest.minLevel) ? quest.minLevel : null;
  const prereqs = requirements(quest.prerequisiteQuestIds, completed, quests);
  const listedItems = quest.requiredItems ?? [];
  result.checks = {
    level: { ...levelEvidence, observedLevel, referenceMinimum: minimum,
      status: minimum === null ? 'not-specified' : observedLevel === null ? 'unknown' :
        observedLevel < minimum ? 'below-reference-minimum' : 'meets-reference-minimum',
      observationStatus: levelEvidence.status },
    prerequisites: { listedCount: prereqs.length,
      userAssertedCompletedCount: prereqs.filter(row => row.status === 'user-asserted-completed').length,
      unknownCount: prereqs.filter(row => row.status === 'unknown').length,
      ...(detail !== 'hint' ? { entries: prereqs } : {}) },
    requiredItems: { listedCount: listedItems.length, inventoryStatus: 'unavailable',
      ...(detail !== 'hint' ? { entries: listedItems.map(item => ({ itemId: item.itemId, count: item.count, ownership: 'unknown' })) } : {}) },
  };
  // Prerequisite titles are additional reference facts, so include their provenance only when shown.
  if (detail !== 'hint') result.provenance = provenance(catalog, [...(quest.sourceIds ?? []),
    ...prereqs.flatMap(row => quests.get(row.questId)?.sourceIds ?? [])]);
  return result;
}

/** Search names, item IDs and acquisition-source names without interpreting catalog text. */
export function searchLoot({ catalog, query = '', limit = 10 }) {
  if (typeof query !== 'string' || query.length > 160) throw new TypeError('query must be a string of at most 160 characters');
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) throw new TypeError('limit must be between 1 and 25');
  const normalized = query.trim().toLowerCase();
  const terms = normalized.split(/\s+/u).filter(Boolean);
  const matches = (catalog.items ?? []).filter(item => {
    const haystack = [item.name, String(item.id), ...(item.sources ?? []).flatMap(source => [source.name, source.encounter ?? ''])].join(' ').toLowerCase();
    return terms.every(term => haystack.includes(term));
  }).sort(byName);
  const selected = matches.slice(0, limit);
  return {
    status: 'ok', query: query.trim(), totalMatches: matches.length, truncated: matches.length > selected.length,
    results: selected.map(item => ({ itemId: item.id, name: item.name,
      sources: (item.sources ?? []).map(source => ({ id: source.id, name: source.name, kind: source.kind,
        ...(source.encounter ? { encounter: source.encounter } : {}), sourceIds: [...(source.sourceIds ?? [])] })),
      sourceStatus: item.sources?.length ? 'reference-only' : 'unknown',
    })),
    provenance: provenance(catalog, selected.flatMap(itemSourceIds)),
    limitations: [catalogNote, 'Search covers only this bounded catalog; no match does not mean an item does not exist.'],
  };
}

/** Rank sources by distinct active goals covered, never by assumed drop chance or travel time. */
export function planLoot({ catalog, goals, completedQuestIds = [] }) {
  if (!Array.isArray(goals) || goals.length > MAX_GOALS || goals.some(goal => !validId(goal?.itemId) || !['active', 'acquired'].includes(goal.status))) {
    throw new TypeError(`goals must contain at most ${MAX_GOALS} item IDs with active or acquired status`);
  }
  const completed = completedSet(completedQuestIds);
  const items = new Map((catalog.items ?? []).map(item => [item.id, item]));
  const quests = new Map((catalog.quests ?? []).map(quest => [quest.id, quest]));
  // The persistent store has unique IDs. Defensively prefer acquired for contradictory inputs.
  const acquired = new Set(goals.filter(goal => goal.status === 'acquired').map(goal => goal.itemId));
  const activeIds = unique(goals.filter(goal => goal.status === 'active' && !acquired.has(goal.itemId)).map(goal => goal.itemId)).sort((left, right) => left - right);
  const sources = new Map();
  const unresolvedGoals = [];
  const consulted = [];
  for (const itemId of activeIds) {
    const item = items.get(itemId);
    consulted.push(...itemSourceIds(item));
    if (!item || !item.sources?.length) {
      unresolvedGoals.push({ itemId, name: item?.name ?? null, reason: item ? 'no-catalog-sources' : 'unknown-item' });
      continue;
    }
    for (const source of item.sources) {
      consulted.push(...(source.sourceIds ?? []));
      let plan = sources.get(source.id);
      if (!plan) {
        plan = { sourceId: source.id, name: source.name, kind: source.kind, items: new Map(), sourceIds: new Set() };
        sources.set(source.id, plan);
      }
      for (const id of source.sourceIds ?? []) plan.sourceIds.add(id);
      const prereqs = requirements(source.prerequisiteQuestIds, completed, quests);
      for (const prerequisite of prereqs) consulted.push(...(quests.get(prerequisite.questId)?.sourceIds ?? []));
      const materials = (source.materials ?? []).map(material => ({ itemId: material.itemId,
        name: items.get(material.itemId)?.name ?? null, count: material.count,
        quantityMeaning: 'recipe-quantity', inventoryStatus: 'unavailable',
      }));
      for (const material of materials) consulted.push(...itemSourceIds(items.get(material.itemId)));
      const option = { encounter: source.encounter ?? null, prerequisites: prereqs, materials };
      const existing = plan.items.get(itemId);
      if (existing) {
        // Repeated source rows, including multiple bosses, cannot inflate the coverage score.
        existing.encounters = unique([...existing.encounters, ...(source.encounter ? [source.encounter] : [])]).sort(compare);
        // Prerequisites and recipes belong to each alternative, never to a merged AND condition.
        if (!existing.acquisitionOptions.some(row => JSON.stringify(row) === JSON.stringify(option))) existing.acquisitionOptions.push(option);
      } else {
        plan.items.set(itemId, { itemId, name: item.name, encounters: source.encounter ? [source.encounter] : [],
          acquisitionOptions: [option] });
      }
    }
  }
  return {
    status: 'ok', activeGoalCount: activeIds.length, excludedAcquiredCount: acquired.size,
    ranking: 'distinct-active-goal-items-per-source',
    plans: [...sources.values()].map(plan => ({ sourceId: plan.sourceId, name: plan.name, kind: plan.kind,
      goalCount: plan.items.size, items: [...plan.items.values()].sort((left, right) => left.itemId - right.itemId),
      sourceIds: [...plan.sourceIds].sort(compare),
    })).sort((left, right) => right.goalCount - left.goalCount || compare(left.name.toLowerCase(), right.name.toLowerCase()) || compare(left.sourceId, right.sourceId)),
    unresolvedGoals, provenance: provenance(catalog, consulted),
    limitations: [catalogNote, 'Goals and completion assertions are user supplied; acquired status is not verified against inventory.',
      'Coverage counts are not drop probabilities, guaranteed rewards, travel estimates or a promise that a source is accessible.',
      'Prerequisites and recipe quantities apply to each acquisition option. Options are alternatives; quantities do not subtract owned supplies.'],
  };
}
