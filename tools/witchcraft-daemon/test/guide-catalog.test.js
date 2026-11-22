import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { findGuide, guideSchema, loadGuideCatalog, MAX_GUIDE_BYTES } from '../src/guide-catalog.js';

test('bundled references validate, preserve encounters, and disambiguate repeated quest titles', async () => {
  const catalog = await loadGuideCatalog();
  assert.equal(catalog.compatibility, 'reference-only');
  assert.equal(catalog.quests.length, 7);
  assert.equal(catalog.items.length, 12);
  assert.ok(catalog.items.every(item => item.sources.every(source => source.encounter)));
  const matches = findGuide(catalog, { query: 'defias', kind: 'quest', limit: 3 });
  assert.equal(matches.totalMatches, 7);
  assert.equal(matches.truncated, true);
  assert.equal(new Set(matches.results.map(row => row.id)).size, 3);
  assert.equal(JSON.stringify(matches).includes('solution'), true, 'search note explains solution absence');
  for (const quest of catalog.quests) assert.ok(!JSON.stringify(matches.results).includes(quest.hints.solution));
  assert.deepEqual(findGuide(catalog, { query: '5191', kind: 'item' }).results, [{ kind: 'item', id: 5191, name: 'Cruel Barb' }]);
  assert.equal(findGuide(catalog, { query: 'unknown item here' }).status, 'not-in-catalog');
});

test('catalog rejects broken citations, conflicting source identities and newer schema without interpretation', async () => {
  const catalog = await loadGuideCatalog();
  for (const mutate of [
    data => { data.schemaVersion = 2; },
    data => { data.quests.push(data.quests[0]); },
    data => { data.quests[0].sourceIds = ['unknown']; },
    data => { data.sources[0].url = 'file:///private'; },
    data => { data.items[1].sources[0].id = data.items[0].sources[0].id; data.items[1].sources[0].name = 'Conflicting name'; },
  ]) {
    const candidate = structuredClone(catalog); mutate(candidate);
    assert.equal(guideSchema.safeParse(candidate).success, false);
  }
});

test('catalog bounds local files and rejects malformed UTF-8', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'witchcraft-guide-data-'));
  t.after(async () => { assert.equal(path.dirname(dir), os.tmpdir()); await fs.rm(dir, { recursive: true, force: true }); });
  const file = path.join(dir, 'reference.json');
  await fs.writeFile(file, Buffer.alloc(MAX_GUIDE_BYTES + 1));
  await assert.rejects(loadGuideCatalog(file));
  await fs.writeFile(file, Buffer.from([0xff]));
  await assert.rejects(loadGuideCatalog(file));
});
