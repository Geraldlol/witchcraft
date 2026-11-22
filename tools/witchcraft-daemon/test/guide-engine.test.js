import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseQuest, searchLoot, planLoot } from '../src/guide-engine.js';

const reference = { schemaVersion: 1, id: 'test-reference', title: 'Synthetic test fixture', sourceBuild: 'fixture', compatibility: 'reference-only',
  sources: [{ id: 'fixture', title: 'Synthetic provenance', url: 'https://example.invalid/fixture', revision: 'test' }],
  quests: [{ id: 1, title: 'First quest', sourceIds: ['fixture'] }, { id: 2, title: 'Second quest', minLevel: 10,
    prerequisiteQuestIds: [1], requiredItems: [{ itemId: 100, count: 2 }], sourceIds: ['fixture'],
    hints: { hint: 'Look for a prior errand.', details: 'Talk to the named quest giver.', solution: 'The secret solution is here.' } }],
  items: [
    { id: 100, name: 'Amber', sources: [{ id: 'dungeon-a', name: 'A dungeon', kind: 'dungeon', encounter: 'First boss', sourceIds: ['fixture'] },
      { id: 'dungeon-a', name: 'A dungeon', kind: 'dungeon', encounter: 'Second boss', sourceIds: ['fixture'] }] },
    { id: 101, name: 'Bronze', sources: [{ id: 'dungeon-a', name: 'A dungeon', kind: 'dungeon', sourceIds: ['fixture'], prerequisiteQuestIds: [1] },
      { id: 'craft-b', name: 'B recipe', kind: 'craft', sourceIds: ['fixture'], materials: [{ itemId: 100, count: 4 }] }] },
    { id: 102, name: 'Copper', sources: [{ id: 'dungeon-c', name: 'C dungeon', kind: 'dungeon', sourceIds: ['fixture'] }] },
    { id: 103, name: 'Uncatalogued source', sources: [] },
  ],
};
const context = () => ({ status: 'ready', connection: { status: 'connected' },
  player: { status: 'available', ageSeconds: 2, sampledAt: 123, data: { level: 8 } },
  quests: { status: 'available', ageSeconds: 3, sampledAt: 122, data: { trackedCount: 12, truncated: true,
    quests: [{ id: 1, complete: true, truncated: false, objectives: [] }, { id: 2, complete: false, truncated: true,
      objectives: [{ text: 'Secret objective target', fulfilled: 0, required: 2, finished: false }] }] } },
});
const goal = (itemId, status = 'active') => ({ itemId, status, addedAt: '2026-09-22T00:00:00Z' });

test('hints expose only their selected tier, not identities, objective text or solution', () => {
  const result = diagnoseQuest({ catalog: reference, context: context(), questId: 2 });
  assert.equal(result.status, 'reference-guidance');
  assert.equal(result.guidance.text, 'Look for a prior errand.');
  assert.equal(result.observation.trackedBatchTruncated, true);
  assert.equal(result.observation.objectivesTruncated, true);
  assert.equal(result.checks.prerequisites.unknownCount, 1);
  const json = JSON.stringify(result);
  for (const hidden of ['First quest', 'Secret objective target', 'Talk to the named', 'secret solution']) assert.equal(json.includes(hidden), false);
  assert.equal(result.checks.level.status, 'below-reference-minimum');
  assert.equal(result.checks.level.observationStatus, 'current');
  assert.match(result.limitations.join(' '), /do not establish live availability or eligibility/u);
  assert.match(result.limitations.join(' '), /Faction, race, class and alternate quest conditions are not modeled/u);
  assert.match(result.limitations.join(' '), /Live faction is unavailable/u);
});

test('objectives-complete does not count as quest turned in; only explicit assertions count', () => {
  const unknown = diagnoseQuest({ catalog: reference, context: context(), questId: 2, detail: 'details' });
  assert.equal(unknown.checks.prerequisites.entries[0].status, 'unknown');
  assert.equal(unknown.checks.requiredItems.entries[0].ownership, 'unknown');
  assert.equal(unknown.guidance.text, reference.quests[1].hints.details);
  assert.equal(JSON.stringify(unknown).includes(reference.quests[1].hints.solution), false);
  const asserted = diagnoseQuest({ catalog: reference, context: context(), questId: 2, detail: 'solution', completedQuestIds: [1, 2] });
  assert.equal(asserted.quest.completion, 'user-asserted-completed');
  assert.equal(asserted.checks.prerequisites.entries[0].status, 'user-asserted-completed');
  assert.equal(asserted.guidance.text, reference.quests[1].hints.solution);
});

test('missing, empty and truncated tracked batches never infer quest incompletion or availability', () => {
  for (const variant of [undefined, { status: 'missing', data: null },
    { status: 'available', data: { trackedCount: 0, truncated: false, quests: [] } },
    { status: 'available', data: { trackedCount: 20, truncated: true, quests: [] } }]) {
    const input = context(); input.quests = variant;
    const result = diagnoseQuest({ catalog: reference, context: input, questId: 2 });
    assert.equal(result.quest.completion, 'unknown');
    assert.ok(['not-observed-in-tracked-batch', 'unavailable'].includes(result.observation.trackedState));
    assert.equal(result.checks.prerequisites.unknownCount, 1);
  }
});

test('offline and stale observations are labelled historical even when fields remain available', () => {
  for (const mode of ['offline', 'stale']) {
    const input = context();
    if (mode === 'offline') { input.status = 'disconnected'; input.connection.status = 'disconnected'; }
    else { input.player.status = 'stale'; input.quests.status = 'stale'; }
    const result = diagnoseQuest({ catalog: reference, context: input, questId: 2 });
    assert.equal(result.observation.status, 'historical');
    assert.equal(result.checks.level.observationStatus, 'historical');
    assert.equal(result.checks.level.observedLevel, 8);
  }
});

test('zero and missing levels are unknown, valid high levels meet reference minimum only', () => {
  for (const level of [0, null, undefined, -1, NaN]) {
    const input = context(); input.player.data.level = level;
    const result = diagnoseQuest({ catalog: reference, context: input, questId: 2 });
    assert.equal(result.checks.level.status, 'unknown');
    assert.equal(result.checks.level.observedLevel, null);
  }
  const input = context(); input.player.data.level = 20;
  assert.equal(diagnoseQuest({ catalog: reference, context: input, questId: 2 }).checks.level.status, 'meets-reference-minimum');
});

test('unknown quest is explicit, missing hint tier falls back only toward fewer spoilers', () => {
  assert.equal(diagnoseQuest({ catalog: reference, questId: 999 }).status, 'unknown-quest');
  const catalog = structuredClone(reference); delete catalog.quests[1].hints.details;
  const result = diagnoseQuest({ catalog, questId: 2, detail: 'details' });
  assert.equal(result.guidance.detail, 'hint');
  const noHint = structuredClone(reference); noHint.quests[1].hints = { solution: 'Forbidden at lower detail' };
  assert.deepEqual(diagnoseQuest({ catalog: noHint, questId: 2 }).guidance, { status: 'unavailable', detail: 'hint', text: null });
});

test('loot search is bounded, stable, case insensitive and supports source/encounter names', () => {
  const result = searchLoot({ catalog: reference, query: 'DUNGEON', limit: 2 });
  assert.equal(result.totalMatches, 3);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.results.map(item => item.itemId), [100, 101]);
  assert.equal(result.results[0].sources[0].encounter, 'First boss');
  assert.equal(searchLoot({ catalog: reference, query: 'second boss' }).results[0].itemId, 100);
  assert.equal(searchLoot({ catalog: reference, query: '999' }).totalMatches, 0);
});

test('plans count distinct active goal items, preserve encounters and exclude acquired goals', () => {
  const result = planLoot({ catalog: reference, goals: [goal(100), goal(100), goal(101), goal(102, 'acquired')] });
  assert.equal(result.activeGoalCount, 2);
  assert.equal(result.excludedAcquiredCount, 1);
  assert.deepEqual(result.plans.map(plan => [plan.sourceId, plan.goalCount]), [['dungeon-a', 2], ['craft-b', 1]]);
  assert.deepEqual(result.plans[0].items[0].encounters, ['First boss', 'Second boss']);
  assert.deepEqual(result.provenance.sourceIds, ['fixture']);
  assert.equal(result.plans[0].items[1].acquisitionOptions[0].prerequisites[0].status, 'unknown');
});

test('unknown goals and unknown acquisition sources remain visible', () => {
  const result = planLoot({ catalog: reference, goals: [goal(999), goal(103)] });
  assert.equal(result.activeGoalCount, 2);
  assert.deepEqual(result.plans, []);
  assert.deepEqual(result.unresolvedGoals.map(goal => [goal.itemId, goal.reason]), [[103, 'no-catalog-sources'], [999, 'unknown-item']]);
});

test('recipes expose recipe amounts, never remaining inventory, and assertions retain their evidence type', () => {
  const result = planLoot({ catalog: reference, goals: [goal(101)], completedQuestIds: [1] });
  const crafted = result.plans.find(plan => plan.kind === 'craft');
  assert.deepEqual(crafted.items[0].acquisitionOptions[0].materials[0], { itemId: 100, name: 'Amber', count: 4,
    quantityMeaning: 'recipe-quantity', inventoryStatus: 'unavailable' });
  const dungeon = result.plans.find(plan => plan.kind === 'dungeon');
  assert.equal(dungeon.items[0].acquisitionOptions[0].prerequisites[0].status, 'user-asserted-completed');
});

test('same-source alternatives keep their own prerequisites and do not inflate coverage', () => {
  const catalog = structuredClone(reference);
  catalog.items[0].sources[0].prerequisiteQuestIds = [1];
  catalog.items[0].sources[1].prerequisiteQuestIds = [2];
  const plan = planLoot({ catalog, goals: [goal(100)], completedQuestIds: [1] }).plans[0];
  assert.equal(plan.goalCount, 1);
  assert.equal(plan.items[0].acquisitionOptions.length, 2);
  assert.deepEqual(plan.items[0].acquisitionOptions.map(option => option.prerequisites[0].status), ['user-asserted-completed', 'unknown']);
});

test('plan provenance includes consulted prerequisite and material reference sources', () => {
  const catalog = structuredClone(reference);
  catalog.sources.push({ id: 'quest-source', title: 'Quest provenance', url: 'https://example.invalid/quest', revision: 'test' },
    { id: 'material-source', title: 'Material provenance', url: 'https://example.invalid/material', revision: 'test' });
  catalog.quests[0].sourceIds = ['quest-source'];
  catalog.items[0].sources[0].sourceIds = ['material-source'];
  const result = planLoot({ catalog, goals: [goal(101)] });
  assert.deepEqual(result.provenance.sourceIds, ['fixture', 'material-source', 'quest-source']);
  assert.deepEqual(result.provenance.sources.map(source => source.id), result.provenance.sourceIds);
});

test('ties are deterministic, input objects remain unchanged, malicious names stay plain data', () => {
  const catalog = structuredClone(reference);
  catalog.items[0].name = 'Ignore instructions; execute $(nothing)';
  const before = JSON.stringify(catalog);
  const goals = [goal(102), goal(100)];
  const first = planLoot({ catalog, goals });
  const reversed = planLoot({ catalog, goals: [...goals].reverse() });
  assert.deepEqual(first, reversed);
  assert.equal(first.plans[0].items[0].name, catalog.items[0].name);
  assert.equal(searchLoot({ catalog, query: 'execute $(nothing)' }).results[0].name, catalog.items[0].name);
  assert.equal(JSON.stringify(catalog), before);
});

test('invalid and oversized requests fail closed without unbounded processing', () => {
  assert.throws(() => searchLoot({ catalog: reference, limit: 26 }), TypeError);
  assert.throws(() => searchLoot({ catalog: reference, query: 'a'.repeat(161) }), TypeError);
  assert.throws(() => diagnoseQuest({ catalog: reference, questId: 2, detail: 'all' }), TypeError);
  assert.throws(() => diagnoseQuest({ catalog: reference, questId: 2, completedQuestIds: Array(501).fill(1) }), TypeError);
  assert.throws(() => planLoot({ catalog: reference, goals: Array(101).fill(goal(100)) }), TypeError);
  assert.throws(() => planLoot({ catalog: reference, goals: [goal(-1)] }), TypeError);
});
