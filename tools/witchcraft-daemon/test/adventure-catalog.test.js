import test from 'node:test';
import assert from 'node:assert/strict';
import { adventureSchema, loadAdventureCatalog, resolvePassportReference } from '../src/adventure-catalog.js';
import { loadGuideCatalog } from '../src/guide-catalog.js';

test('adventure catalog has cited cards, bounded quizzes and resolvable campaign references', async () => {
  const catalog = await loadAdventureCatalog(), guide = await loadGuideCatalog();
  assert.equal(catalog.dungeons.length, 3);
  assert.equal(catalog.detours.length, 9);
  assert.equal(catalog.campaigns.length, 3);
  assert.equal(catalog.dungeons.flatMap(row => row.steps).length, 9);
  assert.equal(catalog.compatibility, 'reference-only');
  for (const campaign of catalog.campaigns) for (const milestone of campaign.milestones) {
    assert.ok(resolvePassportReference(catalog, guide, milestone.kind, milestone.referenceId));
  }
  assert.equal(resolvePassportReference(catalog, guide, 'quest', '132'), 'The Defias Brotherhood');
  assert.equal(resolvePassportReference(catalog, guide, 'quest', '0132'), null);
  assert.equal(resolvePassportReference(catalog, guide, 'quest', '2147483648'), null);
  assert.equal(resolvePassportReference(catalog, guide, 'dungeon', 'invented'), null);
  const lootSourceIds = new Set(guide.items.flatMap(item => item.sources.map(row => row.id)));
  assert.ok(catalog.dungeons.every(row => lootSourceIds.has(row.id)), 'rehearsal IDs join wishlist sources');
});

test('catalog rejects impossible quiz answers, dangling references and duplicate campaign credit', async () => {
  const catalog = await loadAdventureCatalog();
  for (const mutate of [
    value => { value.schemaVersion = 2; },
    value => { value.dungeons[0].steps[0].quiz.answerIndex = 4; value.dungeons[0].steps[0].quiz.choices = ['a', 'b']; },
    value => { value.dungeons[0].steps[0].sourceIds = ['missing']; },
    value => { value.detours[0].dungeonId = 'missing'; },
    value => { value.campaigns[0].milestones[0].referenceId = 'missing'; },
    value => { value.campaigns[0].milestones.push({ ...value.campaigns[0].milestones[0], id: 'duplicate-credit' }); },
    value => { value.sources[0].url = 'file:///local'; },
  ]) {
    const candidate = structuredClone(catalog); mutate(candidate);
    assert.equal(adventureSchema.safeParse(candidate).success, false);
  }
});
