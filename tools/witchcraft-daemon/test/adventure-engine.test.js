import test from 'node:test';
import assert from 'node:assert/strict';
import { rehearseDungeon, suggestDetours, summarizePassport } from '../src/adventure-engine.js';
import { loadAdventureCatalog, resolvePassportReference } from '../src/adventure-catalog.js';
import { loadGuideCatalog } from '../src/guide-catalog.js';

const source = { id: 'fixture', title: 'Synthetic source', url: 'https://example.invalid/adventures', revision: 'test' };
const stage = (id, title) => ({ id, title, briefing: 'Briefing contains a secret mechanic.',
  roleTips: { tank: 'Tank-only preparation.', healer: 'Healer-only preparation.', damage: 'Damage-only preparation.' },
  quiz: { question: 'Which response helps?', choices: ['Wait', 'Prepare', 'Rush'], answerIndex: 1, explanation: 'Hidden solution explanation.' },
  sourceIds: ['fixture'] });
const catalog = { schemaVersion: 1, id: 'synthetic-adventures', title: 'Synthetic adventures', sourceBuild: 'fixture', compatibility: 'reference-only',
  sources: [source],
  dungeons: [
    { id: 'dungeon-a', name: 'A Dungeon', aliases: ['First Cave'], zone: 'Test Zone', sourceIds: ['fixture'], steps: [stage('boss-a', 'First Boss'), stage('boss-b', 'Last Boss')] },
    { id: 'dungeon-b', name: 'B Dungeon', aliases: ['Second Cave'], zone: 'Other Zone', sourceIds: ['fixture'], steps: [stage('boss-c', 'First Boss')] },
  ],
  detours: [
    { id: 'story-a', title: 'A story', zone: 'Test Zone', interests: ['story'], summary: 'An unfinished local tale.',
      details: 'SECRET STORY DETAILS', questIds: [123456, 123457], sourceIds: ['fixture'] },
    { id: 'loot-a', title: 'B dungeon', zone: 'Test Zone', interests: ['loot'], summary: 'A witchcraft dungeon.',
      details: 'SECRET DUNGEON DETAILS', dungeonId: 'dungeon-a', sourceIds: ['fixture'] },
    { id: 'explore-a', title: 'C exploration', zone: 'Test Zone', interests: ['exploration'], summary: 'An unusual landmark.',
      details: 'SECRET EXPLORATION DETAILS', sourceIds: ['fixture'] },
    { id: 'outside', title: 'A longer zone name', zone: 'Test Zone Highlands', interests: ['exploration'], summary: 'Not this zone.',
      details: 'OUTSIDE DETAILS', sourceIds: ['fixture'] },
  ],
  campaigns: [{ id: 'journey', title: 'A personal journey', description: 'Synthetic milestones.', milestones: [
    { id: 'visit', title: 'Visit the landmark', description: 'Explore.', kind: 'exploration', referenceId: 'explore-a' },
    { id: 'clear', title: 'Finish the dungeon', description: 'Clear.', kind: 'dungeon', referenceId: 'dungeon-a' },
    { id: 'quest', title: 'Finish the story', description: 'Turn in.', kind: 'quest', referenceId: '123457' },
  ] }],
};
const guideCatalog = { id: 'loot-fixture', title: 'Loot fixture', sourceBuild: 'fixture', compatibility: 'reference-only', sources: [source], items: [
  { id: 100, name: 'First prize', sources: [{ id: 'dungeon-a', kind: 'dungeon', encounter: 'First Boss', sourceIds: ['fixture'] },
    { id: 'dungeon-a', kind: 'dungeon', encounter: 'First Boss', sourceIds: ['fixture'] }] },
  { id: 101, name: 'Last prize', sources: [{ id: 'dungeon-a', kind: 'dungeon', encounter: 'Last Boss', sourceIds: ['fixture'] }] },
  { id: 102, name: 'Other dungeon prize', sources: [{ id: 'dungeon-b', kind: 'dungeon', encounter: 'First Boss', sourceIds: ['fixture'] }] },
  { id: 103, name: 'Acquired prize', sources: [{ id: 'dungeon-a', kind: 'dungeon', encounter: 'First Boss', sourceIds: ['fixture'] }] },
] };
const goal = (itemId, status = 'active') => ({ itemId, status });
const stamp = (kind, referenceId, completedAt = 100, updatedAt = completedAt) => ({ kind, referenceId, title: referenceId,
  note: '', completedAt, updatedAt, evidence: 'user-confirmed' });
const passport = entries => ({ profile: 'fixture-profile', entries, campaignIds: ['journey'] });
const context = () => ({ status: 'ready', enabled: true, connection: { status: 'connected' },
  player: { status: 'available', sampledAt: 100, ageSeconds: 1, data: { name: 'PRIVATE PLAYER', class: 'PRIVATE CLASS',
    location: { zone: 'Test Zone', subzone: 'PRIVATE SUBZONE', mapId: 123 }, unavailableFields: [] } },
  quests: { status: 'available', data: { truncated: true, trackedCount: 20, quests: [
    { id: 123456, complete: true, objectives: [{ text: 'PRIVATE OBJECTIVE' }] }, { id: 123457, complete: true },
  ] } },
});

test('rehearsal accepts exact names, IDs and aliases with normalization and bounded navigation', () => {
  for (const dungeon of ['dungeon-a', 'A DUNGEON', '  first   cave  ']) {
    const result = rehearseDungeon({ catalog, dungeon });
    assert.equal(result.status, 'reference-rehearsal');
    assert.equal(result.dungeon.id, 'dungeon-a');
    assert.deepEqual(result.navigation, { totalSteps: 2, previousStep: null, nextStep: 1 });
    assert.equal(result.step.roleTip, 'Damage-only preparation.');
    assert.equal(result.provenance.compatibility, 'reference-only');
  }
  const last = rehearseDungeon({ catalog, dungeon: 'dungeon-a', step: 1 });
  assert.deepEqual(last.navigation, { totalSteps: 2, previousStep: 0, nextStep: null });
  const past = rehearseDungeon({ catalog, dungeon: 'dungeon-a', step: 2 });
  assert.equal(past.status, 'step-out-of-range');
  assert.equal(past.step, undefined);
  assert.equal(past.navigation.nextStep, null);
  assert.match(past.note, /does not wrap/u);
});

test('unknown and ambiguous dungeon requests offer candidates without silently choosing', () => {
  for (const query of ['dungeon', 'no such dungeon']) {
    const result = rehearseDungeon({ catalog, dungeon: query });
    assert.equal(result.status, 'unknown-dungeon');
    assert.equal(result.dungeon, undefined);
    assert.equal(result.step, undefined);
    assert.deepEqual(result.candidates.map(row => row.id), ['dungeon-a', 'dungeon-b']);
  }
  const ambiguous = structuredClone(catalog);
  ambiguous.dungeons[1].aliases.push('First Cave');
  const result = rehearseDungeon({ catalog: ambiguous, dungeon: 'First Cave' });
  assert.equal(result.status, 'ambiguous-dungeon');
  assert.equal(result.dungeon, undefined);
  assert.equal(result.candidates.length, 2);
});

test('role-specific briefing exposes only the chosen role and omits quiz solutions', () => {
  for (const role of ['tank', 'healer', 'damage']) {
    const result = rehearseDungeon({ catalog, dungeon: 'dungeon-a', role });
    assert.equal(result.step.roleTip, catalog.dungeons[0].steps[0].roleTips[role]);
    assert.equal(result.step.briefing, catalog.dungeons[0].steps[0].briefing);
    assert.equal(result.quiz, undefined);
    assert.equal(result.answer, undefined);
    assert.equal(JSON.stringify(result).includes('Hidden solution'), false);
    for (const other of ['tank', 'healer', 'damage'].filter(value => value !== role)) {
      assert.equal(JSON.stringify(result).includes(catalog.dungeons[0].steps[0].roleTips[other]), false);
    }
  }
});

test('quiz responses contain neither briefing, role tips, scoring nor hidden explanation', () => {
  const result = rehearseDungeon({ catalog, dungeon: 'dungeon-a', mode: 'quiz', guideCatalog, goals: [goal(100)] });
  assert.deepEqual(result.quiz, { question: 'Which response helps?', choices: ['Wait', 'Prepare', 'Rush'], choiceIndexBase: 0 });
  assert.equal(result.step.briefing, undefined);
  assert.equal(result.step.roleTip, undefined);
  assert.equal(result.lootGoals, undefined);
  assert.equal(result.answer, undefined);
  for (const hidden of ['answerIndex', 'correctChoice', 'Hidden solution', 'secret mechanic', '-only preparation']) {
    assert.equal(JSON.stringify(result).includes(hidden), false);
  }
});

test('answer scoring is zero-based, explicit and absent for missing or malformed answers', () => {
  const missing = rehearseDungeon({ catalog, dungeon: 'dungeon-a', mode: 'answer' });
  assert.equal(missing.status, 'needs-answer');
  assert.equal(missing.answer, undefined);
  assert.equal(JSON.stringify(missing).includes('Hidden solution'), false);
  const incorrect = rehearseDungeon({ catalog, dungeon: 'dungeon-a', mode: 'answer', answerChoice: 0 });
  assert.equal(incorrect.answer.correct, false);
  assert.equal(incorrect.answer.correctChoiceIndex, 1);
  assert.equal(incorrect.answer.explanation, 'Hidden solution explanation.');
  assert.equal(rehearseDungeon({ catalog, dungeon: 'dungeon-a', mode: 'answer', answerChoice: 1 }).answer.correct, true);
  for (const answerChoice of [null, '1', -1, 1.5, 3, NaN]) {
    assert.throws(() => rehearseDungeon({ catalog, dungeon: 'dungeon-a', mode: 'answer', answerChoice }), TypeError);
  }
});

test('explicit reveal shows the answer without inventing a submitted choice or correctness score', () => {
  const result = rehearseDungeon({ catalog, dungeon: 'dungeon-a', mode: 'reveal' });
  assert.deepEqual(result.answer, { revealed: true, correctChoiceIndex: 1, correctChoice: 'Prepare', explanation: 'Hidden solution explanation.' });
  assert.equal(result.answer.correct, undefined);
  assert.equal(result.answer.choiceIndex, undefined);
  assert.equal(result.step.roleTip, undefined);
  assert.equal(result.step.briefing, undefined);
  for (const mode of ['brief', 'quiz', 'reveal']) {
    assert.throws(() => rehearseDungeon({ catalog, dungeon: 'dungeon-a', mode, answerChoice: 1 }), /requires answer mode/u);
  }
  const quiz = rehearseDungeon({ catalog, dungeon: 'dungeon-a', mode: 'quiz' });
  assert.equal(quiz.answer, undefined);
  assert.equal(JSON.stringify(quiz).includes('Hidden solution explanation.'), false);
});

test('wishlist rehearsal requires both exact source and boss identity and deduplicates acquired goals', () => {
  const result = rehearseDungeon({ catalog, guideCatalog, dungeon: 'dungeon-a',
    goals: [goal(100), goal(100), goal(101), goal(102), goal(103), goal(103, 'acquired'), goal(999)] });
  assert.equal(result.lootGoals.dungeonGoalCount, 2);
  assert.equal(result.lootGoals.encounterGoalCount, 1);
  assert.deepEqual(result.lootGoals.encounterItems.map(row => row.itemId), [100]);
  assert.deepEqual(result.lootGoals.dungeonItems.map(row => row.itemId), [100, 101]);
  assert.deepEqual(result.lootGoals.unresolvedGoalIds, [999]);
  assert.deepEqual(result.lootGoals.provenance.sourceIds, ['fixture']);
  const unavailable = rehearseDungeon({ catalog, dungeon: 'dungeon-a', goals: [goal(100)] });
  assert.equal(unavailable.lootGoals.status, 'catalog-unavailable');
  assert.deepEqual(unavailable.lootGoals.unresolvedGoalIds, [100]);
});

test('detours use exact normalized zone matching and explicit interests without leaked player fields', () => {
  const result = suggestDetours({ catalog, context: context(), limit: 2 });
  assert.equal(result.status, 'reference-detours');
  assert.equal(result.zone.source, 'current-player');
  assert.equal(result.totalMatches, 3);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.results.map(row => row.id), ['story-a', 'loot-a']);
  assert.equal(result.provenance.compatibility, 'reference-only');
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
  assert.equal(JSON.stringify(result).includes('123456'), false);
  assert.equal(result.results[1].dungeonId, undefined);
  const interest = suggestDetours({ catalog, zone: '  TEST   zone ', interests: ['exploration'] });
  assert.deepEqual(interest.results.map(row => row.id), ['explore-a']);
  assert.equal(interest.zone.source, 'user-selected');
  assert.equal(suggestDetours({ catalog, zone: 'Test' }).totalMatches, 0);
});

test('detour details reveal only requested catalog details, never coordinates or travel estimates', () => {
  const result = suggestDetours({ catalog, zone: 'Test Zone', detail: 'details' });
  assert.equal(result.results[0].details, 'SECRET STORY DETAILS');
  assert.deepEqual(result.results[0].questIds, [123456, 123457]);
  assert.equal(result.results[1].dungeonId, 'dungeon-a');
  for (const row of result.results) for (const field of ['distance', 'coordinates', 'eta', 'eligible']) assert.equal(row[field], undefined);
});

test('stale, offline, disabled, missing and truncated zone context require an explicit zone', () => {
  const cases = [undefined];
  for (const change of [
    input => { input.connection.status = 'disconnected'; },
    input => { input.player.status = 'stale'; },
    input => { input.player.status = 'unavailable'; },
    input => { input.player.data = null; },
    input => { input.enabled = false; },
    input => { input.status = 'disabled'; },
    input => { input.player.data.location.zone = ''; },
    input => { input.player.data.unavailableFields = ['zone:truncated']; },
    input => { input.player.data.unavailableFields = ['zone:restricted']; },
    input => { input.player.data.unavailableFields = ['zone']; },
  ]) { const input = context(); change(input); cases.push(input); }
  for (const input of cases) {
    const result = suggestDetours({ catalog, context: input });
    assert.equal(result.status, 'needs-zone');
    assert.deepEqual(result.results, []);
    assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
    assert.equal(suggestDetours({ catalog, context: input, zone: 'Test Zone' }).zone.source, 'user-selected');
  }
  const unrelated = context(); unrelated.player.data.unavailableFields = ['name:truncated', 'subzone:restricted'];
  assert.equal(suggestDetours({ catalog, context: unrelated }).status, 'reference-detours');
});

test('detour suppression uses exact personal identities and complete chains, never tracked objective flags', () => {
  assert.equal(suggestDetours({ catalog, context: context() }).totalMatches, 3);
  const partial = suggestDetours({ catalog, zone: 'Test Zone', passport: passport([stamp('quest', '123456')]) });
  assert.equal(partial.totalMatches, 3);
  const result = suggestDetours({ catalog, zone: 'Test Zone', passport: passport([
    stamp('quest', '123456'), stamp('quest', '123457'), stamp('dungeon', 'dungeon-a'), stamp('exploration', 'explore-a'),
  ]) });
  assert.equal(result.totalMatches, 0);
  assert.equal(suggestDetours({ catalog, zone: 'Test Zone', passport: passport([stamp('quest', 'dungeon-a')]) }).totalMatches, 3);
  assert.equal(suggestDetours({ catalog, zone: 'Test Zone', passport: passport([stamp('dungeon', 'DUNGEON-A')]) }).totalMatches, 3);
});

test('dungeon completion does not suppress its unfinished quest outings', async () => {
  const reference = await loadAdventureCatalog();
  const cleared = passport([stamp('dungeon', 'shadowfang-keep')]);
  const options = { catalog: reference, zone: 'Silverpine Forest', limit: 10 };
  const pending = suggestDetours({ ...options, passport: cleared });
  assert.deepEqual(pending.results.map(row => row.id), suggestDetours(options).results.map(row => row.id));
  assert.ok(pending.results.some(row => row.id === 'silverpine-book-of-ur'));
  const finishedQuest = suggestDetours({ ...options, passport: passport([...cleared.entries, stamp('quest', '1013')]) });
  assert.equal(finishedQuest.results.some(row => row.id === 'silverpine-book-of-ur'), false);
  assert.ok(finishedQuest.results.some(row => row.id === 'silverpine-shadowfang-search'));
  const stampedOuting = suggestDetours({ ...options, passport: passport([stamp('exploration', 'silverpine-book-of-ur')]) });
  assert.equal(stampedOuting.results.some(row => row.id === 'silverpine-book-of-ur'), false);
});

test('passport milestones require exact kind and reference, with local evidence distinct from game achievements', () => {
  const result = summarizePassport({ catalog, passport: passport([stamp('exploration', 'explore-a'), stamp('quest', 'dungeon-a')]) });
  assert.equal(result.status, 'personal-passport');
  assert.equal(result.profile, 'fixture-profile');
  assert.equal(result.stampCount, 2);
  assert.equal(result.evidence, 'user-confirmed');
  assert.equal(result.campaigns[0].joined, true);
  assert.equal(result.campaigns[0].completedCount, 1);
  assert.equal(result.campaigns[0].totalCount, 3);
  assert.equal(result.campaigns[0].complete, false);
  assert.deepEqual(result.campaigns[0].milestones.map(row => row.status), ['user-confirmed', 'not-stamped', 'not-stamped']);
  assert.match(result.limitations.join(' '), /not game-verified completions or official achievements/u);
});

test('passport offers unjoined campaigns and recognizes complete campaigns only from all personal stamps', () => {
  const empty = summarizePassport({ catalog });
  assert.equal(empty.profile, 'personal');
  assert.equal(empty.stampCount, 0);
  assert.equal(empty.campaigns[0].joined, false);
  const result = summarizePassport({ catalog, passport: passport([stamp('exploration', 'explore-a'), stamp('dungeon', 'dungeon-a'), stamp('quest', '123457')]) });
  assert.equal(result.campaigns[0].complete, true);
  assert.equal(result.campaigns[0].completedCount, 3);
});

test('unknown saved references and campaign IDs survive summary and never count toward known milestones', () => {
  const saved = passport([stamp('quest', '999999'), stamp('dungeon', 'gone-dungeon')]);
  saved.campaignIds = ['removed-campaign', 'journey', 'removed-campaign'];
  const result = summarizePassport({ catalog, passport: saved });
  assert.equal(result.timeline.length, 2);
  assert.deepEqual(result.unknownCampaignIds, ['removed-campaign']);
  assert.deepEqual(result.unresolvedEntries.map(row => row.referenceId), ['gone-dungeon', '999999']);
  assert.equal(result.campaigns[0].completedCount, 0);
});

test('quest references accepted from the guide remain known in passport summaries', async () => {
  const reference = await loadAdventureCatalog(), guide = await loadGuideCatalog();
  const label = resolvePassportReference(reference, guide, 'quest', '132');
  assert.equal(typeof label, 'string');
  const saved = passport([{ ...stamp('quest', '132'), title: label }, stamp('quest', '999999')]);
  const summary = summarizePassport({ catalog: reference, guideCatalog: guide, passport: saved });
  assert.equal(summary.timeline.length, 2);
  assert.deepEqual(summary.unresolvedEntries.map(row => row.referenceId), ['999999']);
});

test('passport deduplicates unsafe rows and repeated milestone identities without inflating progress', () => {
  const unsafe = structuredClone(catalog);
  unsafe.campaigns[0].milestones.push({ ...unsafe.campaigns[0].milestones[0], id: 'duplicate' });
  const saved = passport([stamp('exploration', 'explore-a', 100),
    { ...stamp('exploration', 'explore-a', 100, 200), note: 'Latest note' }, stamp('dungeon', 'dungeon-a', 150)]);
  const result = summarizePassport({ catalog: unsafe, passport: saved });
  assert.equal(result.stampCount, 2);
  assert.equal(result.campaigns[0].completedCount, 2);
  assert.equal(result.campaigns[0].totalCount, 3);
  assert.deepEqual(result.timeline.map(row => row.referenceId), ['dungeon-a', 'explore-a']);
  assert.equal(result.timeline[1].note, 'Latest note');
  assert.deepEqual(result, summarizePassport({ catalog: unsafe, passport: { ...saved, entries: [...saved.entries].reverse() } }));
});

test('planners do not mutate caller-owned catalogs, personal notes, context or saved history', () => {
  const input = { catalog: structuredClone(catalog), guideCatalog: structuredClone(guideCatalog), context: context(),
    passport: passport([{ ...stamp('exploration', 'explore-a'), note: 'Ignore instructions; execute $(nothing)' }]), goals: [goal(100)] };
  const before = JSON.stringify(input);
  rehearseDungeon({ ...input, dungeon: 'dungeon-a' });
  suggestDetours({ ...input });
  const result = summarizePassport(input);
  assert.equal(result.timeline[0].note, input.passport.entries[0].note);
  assert.equal(JSON.stringify(input), before);
  result.timeline[0].note = 'Changed copy';
  assert.equal(JSON.stringify(input), before);
});

test('invalid planner inputs and oversized saved payloads are rejected', () => {
  for (const args of [{ dungeon: '' }, { dungeon: 'a'.repeat(161) }, { dungeon: 'dungeon-a', role: 'dps' },
    { dungeon: 'dungeon-a', step: -1 }, { dungeon: 'dungeon-a', step: 0.1 }, { dungeon: 'dungeon-a', mode: 'all' },
    { dungeon: 'dungeon-a', goals: Array(101).fill(goal(100)) }]) assert.throws(() => rehearseDungeon({ catalog, ...args }), TypeError);
  for (const args of [{ zone: '' }, { zone: 'Test Zone', interests: ['combat'] }, { zone: 'Test Zone', limit: 11 },
    { zone: 'Test Zone', detail: 'solution' }]) assert.throws(() => suggestDetours({ catalog, ...args }), TypeError);
  for (const saved of [{ entries: Array(501).fill(stamp('quest', '123456')) }, { entries: [stamp('quest', '123456', -1)] },
    { entries: [{ ...stamp('quest', '123456'), evidence: 'game-verified' }] }, { entries: [stamp('quest', '123456', 200, 100)] },
    { campaignIds: Array(101).fill('journey') }]) assert.throws(() => summarizePassport({ catalog, passport: saved }), TypeError);
});
