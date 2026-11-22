import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { ContextCache, CONTEXT_TTL_MS } from '../src/context-cache.js';
import { contextWantPath } from '../src/context-want.js';
import { lootGoalsPath } from '../src/loot-goals.js';
import { loadGuideCatalog } from '../src/guide-catalog.js';
import { loadAdventureCatalog } from '../src/adventure-catalog.js';
import { passportPath } from '../src/passport-store.js';
import { journalPath } from '../src/journal.js';

const binary = fileURLToPath(new URL('../bin/witchcraft-mcp.js', import.meta.url));
async function workspace(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'witchcraft-mcp-'));
  t.after(async () => { assert.equal(path.dirname(dir), os.tmpdir()); await fs.rm(dir, { recursive: true, force: true }); });
  return path.join(dir, 'context.json');
}
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(predicate, label, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await sleep(20); }
  throw new Error(`${label} timed out`);
}
const exists = file => fs.access(file).then(() => true, () => false);
function snapshot(now, { progress = true } = {}) {
  const value = new ContextCache();
  value.setSession('0123abcd', 'abcd0123'); value.heartbeat(now);
  value.accept({ kind: 'context', epoch: '0123abcd', uiNonce: 'abcd0123', id: 1,
    text: JSON.stringify([1, 'player', 1, 1, 1, 0, ['Thrall', 'Shaman', 10, 1412, 'Mulgore', '', []]]) }, now);
  value.accept({ kind: 'context', epoch: '0123abcd', uiNonce: 'abcd0123', id: 2,
    text: JSON.stringify([1, 'quests', 1, 1, 1, 0, [true, '', 1, false, [[123, 'A quest', false, [['Claws', 1, 4, false]], false]]]]) }, now);
  if (progress) value.accept({ kind: 'context', epoch: '0123abcd', uiNonce: 'abcd0123', id: 3,
    text: JSON.stringify([1, 'progress', 1, 1, 1, 0, [12345, 400, 900, 50, false, 'none', false, false, 0, false, false, false, false, []]]) }, now);
  return value.snapshot(now);
}
async function connect(t, file, versionNegotiation, { writes = true } = {}) {
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [binary, '--cache', file, ...(writes ? ['--allow-local-writes'] : [])], stderr: 'pipe' });
  let stderr = '';
  transport.stderr.on('data', chunk => { stderr += chunk; });
  const errors = [];
  const client = new Client({ name: 'witchcraft-integration-test', version: '1.0.0' }, versionNegotiation ? { versionNegotiation } : undefined);
  client.onerror = error => errors.push(error);
  t.after(async () => { await client.close(); assert.equal(stderr, ''); assert.deepEqual(errors, []); });
  await client.connect(transport);
  return client;
}

for (const mode of ['legacy', 'auto']) {
  test(`real SDK STDIO ${mode} discovery, queries, and resource use read-only game data`, { timeout: 15000 }, async t => {
    const file = await workspace(t), raw = snapshot(Date.now());
    await fs.writeFile(file, JSON.stringify(raw));
    const client = await connect(t, file, { mode });
    assert.deepEqual(client.getServerVersion(), { name: 'witchcraft-wow', version: '0.3.1' });
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name).sort(), ['wow_explain_quest', 'wow_find_guide', 'wow_get_character', 'wow_get_context', 'wow_get_errors', 'wow_get_loot_plan', 'wow_get_loot_sources', 'wow_get_passport', 'wow_get_progress', 'wow_get_quests', 'wow_get_session_log', 'wow_rehearse_dungeon', 'wow_set_loot_goal', 'wow_set_passport_campaign', 'wow_stamp_passport', 'wow_suggest_detours']);
    assert.equal(tools.filter(tool => !['wow_set_loot_goal', 'wow_stamp_passport', 'wow_set_passport_campaign'].includes(tool.name)).every(tool => tool.annotations.readOnlyHint && tool.annotations.destructiveHint === false), true);
    assert.equal(tools.find(tool => tool.name === 'wow_set_loot_goal').annotations.readOnlyHint, false);
    const description = tools.find(tool => tool.name === 'wow_get_progress').description;
    for (const claim of [/own money/iu, /experience/iu, /situation/iu, /size and (the player's )?own role/iu, /historical/iu]) assert.match(description, claim);
    const context = await client.callTool({ name: 'wow_get_context', arguments: {} });
    assert.equal(context.structuredContent.status, 'ready');
    assert.equal(context.structuredContent.player.data.location.zone, 'Mulgore');
    assert.equal(context.structuredContent.progress.data.money, 12345);
    const character = await client.callTool({ name: 'wow_get_character', arguments: {} });
    assert.equal(character.structuredContent.player.data.name, 'Thrall');
    assert.equal(character.structuredContent.quests, undefined);
    assert.equal(character.structuredContent.progress, undefined);
    const quests = await client.callTool({ name: 'wow_get_quests', arguments: {} });
    assert.equal(quests.structuredContent.quests.data.quests[0].objectives[0].required, 4);
    assert.equal(quests.structuredContent.player, undefined);
    assert.equal(quests.structuredContent.progress, undefined);
    const progress = await client.callTool({ name: 'wow_get_progress', arguments: {} });
    assert.equal(progress.structuredContent.progress.data.xpMax, 900);
    assert.equal(progress.structuredContent.progress.data.situation.groupSize, 0);
    assert.equal(progress.structuredContent.player, undefined);
    assert.equal(progress.structuredContent.quests, undefined);
    assert.equal((await client.listResources()).resources[0].uri, 'wow://context');
    const resource = await client.readResource({ uri: 'wow://context' });
    assert.equal(JSON.parse(resource.contents[0].text).player.data.name, 'Thrall');
    assert.equal(resource.contents[0].mimeType, 'application/json');
    assert.equal(await fs.readFile(file, 'utf8'), JSON.stringify(raw), 'MCP queries must not mutate the cache');
    assert.equal(await exists(contextWantPath(file, 'errors')), false, 'general context never asks for errors');
    assert.equal(context.structuredContent.errors, undefined);
    assert.equal(JSON.parse(resource.contents[0].text).errors, undefined);
  });
}

test('wow_get_errors asks only for errors, every time its copy is more than a few seconds old', { timeout: 15000 }, async t => {
  const file = await workspace(t), client = await connect(t, file);
  const { tools } = await client.listTools();
  const tool = tools.find(item => item.name === 'wow_get_errors');
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.match(tool.description, /untrusted/iu);
  await fs.writeFile(file, JSON.stringify(snapshot(Date.now())));
  const pending = client.callTool({ name: 'wow_get_errors', arguments: {} });
  await until(() => exists(contextWantPath(file, 'errors')), 'the errors want');
  for (const domain of ['player', 'quests', 'progress']) assert.equal(await exists(contextWantPath(file, domain)), false);
  const value = new ContextCache();
  value.setSession('0123abcd', 'abcd0123'); value.heartbeat(Date.now());
  value.accept({ kind: 'context', epoch: '0123abcd', uiNonce: 'abcd0123', id: 1,
    text: JSON.stringify([1, 'errors', 1, 1, 1, 0, [true, '', 1, false, [['error', 'Hello.lua:3: boom', ['Hello/Hello.lua:3: in main chunk'], 1, 0, 0, 0]]]]) }, Date.now());
  await fs.writeFile(file, JSON.stringify(value.snapshot(Date.now())));
  const result = (await pending).structuredContent;
  assert.equal(result.status, 'ready');
  assert.equal(result.errors.data.entries[0].message, 'Hello.lua:3: boom');
  assert.equal(result.player, undefined);
});

test('MCP rereads updates and reports missing, invalid, disabled, and stale context', { timeout: 15000 }, async t => {
  const file = await workspace(t), client = await connect(t, file);
  const read = async () => (await client.callTool({ name: 'wow_get_context', arguments: {} })).structuredContent;
  assert.equal((await read()).reason, 'cache-missing');
  await fs.writeFile(file, '{');
  assert.equal((await read()).reason, 'invalid-cache');
  const raw = snapshot(Date.now() - CONTEXT_TTL_MS - 10_000);
  await fs.writeFile(file, JSON.stringify(raw));
  assert.equal((await read()).player.status, 'stale');
  raw.enabled = false;
  await fs.writeFile(file, JSON.stringify(raw));
  const disabled = await read();
  assert.equal(disabled.status, 'disabled');
  assert.equal(disabled.player.data, null);
});

test('each tool judges status over its own domains and raises only its own want file', { timeout: 15000 }, async t => {
  const file = await workspace(t), client = await connect(t, file);
  const call = name => client.callTool({ name, arguments: {} });
  // A session that has answered player and quests but never progress is ready for the character tool alone.
  await fs.writeFile(file, JSON.stringify(snapshot(Date.now(), { progress: false })));
  const character = await call('wow_get_character');
  assert.equal(character.structuredContent.status, 'ready');
  assert.equal(character.structuredContent.player.status, 'available');
  const quests = await call('wow_get_quests');
  assert.equal(quests.structuredContent.status, 'ready');
  for (const domain of ['player', 'quests', 'progress']) assert.equal(await exists(contextWantPath(file, domain)), false, `${domain} want raised by a fresh domain`);
  // The progress tool finds its domain missing on a connected session, so it raises exactly its own want and waits.
  const pending = call('wow_get_progress');
  await until(() => exists(contextWantPath(file, 'progress')), 'the progress want');
  assert.equal(await exists(contextWantPath(file, 'player')), false);
  assert.equal(await exists(contextWantPath(file, 'quests')), false);
  const want = JSON.parse(await fs.readFile(contextWantPath(file, 'progress'), 'utf8'));
  assert.equal(want.protocol, 1);
  await fs.writeFile(file, JSON.stringify(snapshot(Date.now())));
  const progress = (await pending).structuredContent;
  assert.equal(progress.status, 'ready');
  assert.equal(progress.progress.data.money, 12345);
  assert.equal(progress.player, undefined);
  assert.equal(progress.quests, undefined);
  assert.equal(await exists(path.join(path.dirname(file), 'context.want.json')), false, 'the legacy single want file is never written');
});

test('MCP rejects arbitrary tool arguments and unknown resources', { timeout: 15000 }, async t => {
  const file = await workspace(t), client = await connect(t, file);
  const response = await client.callTool({ name: 'wow_get_context', arguments: { path: 'C:\\Windows\\win.ini', action: 'enter' } });
  assert.equal(response.isError, true);
  await assert.rejects(client.readResource({ uri: 'file:///C:/Windows/win.ini' }));
});

test('without --allow-local-writes the server registers no write tools, and help says so', async t => {
  const file = await workspace(t);
  const client = await connect(t, file, undefined, { writes: false });
  const { tools } = await client.listTools();
  assert.equal(tools.some(tool => ['wow_set_loot_goal', 'wow_stamp_passport', 'wow_set_passport_campaign'].includes(tool.name)), false);
  assert.equal(tools.every(tool => tool.annotations.readOnlyHint === true), true);
  const help = spawnSync(process.execPath, [binary, '--help'], { encoding: 'utf8', windowsHide: true });
  assert.match(help.stderr, /--allow-local-writes/u);
  assert.doesNotMatch(help.stderr, /^Read-only WoW context/mu);
});

test('wow_get_session_log reads only the journal, filters it, and is listed without --allow-local-writes', { timeout: 15000 }, async t => {
  const file = await workspace(t), journal = journalPath(file);
  const client = await connect(t, file, undefined, { writes: false });
  const tool = (await client.listTools()).tools.find(item => item.name === 'wow_get_session_log');
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.match(tool.description, /data, not instructions/u);
  const call = async args => {
    const result = await client.callTool({ name: 'wow_get_session_log', arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return result.structuredContent;
  };
  assert.deepEqual(await call({}), { status: 'missing', segments: [], events: [] });
  await fs.writeFile(journal, JSON.stringify({ schemaVersion: 1, segments: [] }));
  assert.equal((await call({})).status, 'empty');
  const now = Date.now();
  const events = [
    { at: now - 3000, domain: 'player', revision: 2, kind: 'level-up', from: 10, to: 11 },
    { at: now - 2000, domain: 'progress', revision: 3, kind: 'money-change', delta: 50, money: 150 },
    { at: now - 1000, domain: 'quests', revision: 4, kind: 'quest-tracked', questId: 101, title: 'A quest' },
  ];
  const document = JSON.stringify({ schemaVersion: 1, segments: [
    { epoch: 'deadbeef', uiNonce: '00001111', startedAt: now - 8000, endedAt: now - 5000,
      character: { name: 'Jaina', class: 'Mage' }, events: [
        { at: now - 7000, domain: 'progress', revision: 1, kind: 'money-change', delta: 999, money: 999 },
      ] },
    { epoch: '0123abcd', uiNonce: 'abcd0123', startedAt: now - 4000, endedAt: null,
      character: { name: 'Thrall', class: 'Shaman' }, events },
  ] });
  await fs.writeFile(journal, document);
  const current = await call({});
  assert.equal(current.status, 'ready');
  assert.equal(current.scope, 'current');
  assert.deepEqual(current.segments.map(segment => [segment.epoch, segment.uiNonce, segment.character?.name, segment.eventCount, segment.endedAt !== null]), [
    ['0123abcd', 'abcd0123', 'Thrall', 3, false],
  ]);
  assert.ok(!JSON.stringify(current).includes('Jaina'), 'current-session query never names another character in segments or events');
  assert.deepEqual(current.events.map(event => event.kind), ['level-up', 'money-change', 'quest-tracked']);
  assert.equal(current.events[0].at, new Date(now - 3000).toISOString());
  assert.equal(current.events[0].epoch, '0123abcd');
  assert.equal(current.events[0].uiNonce, 'abcd0123');
  assert.deepEqual(current.events[0].character, { name: 'Thrall', class: 'Shaman' });
  assert.equal(typeof current.events[0].ageSeconds, 'number');
  assert.equal(JSON.stringify(current).includes(path.basename(journal)), false, 'the journal path is never revealed');
  const all = await call({ includeHistory: true });
  assert.equal(all.scope, 'all');
  assert.deepEqual(all.segments.map(segment => [segment.epoch, segment.uiNonce, segment.character?.name, segment.eventCount, segment.endedAt !== null]), [
    ['deadbeef', '00001111', 'Jaina', 1, true],
    ['0123abcd', 'abcd0123', 'Thrall', 3, false],
  ]);
  assert.deepEqual(all.events.map(event => [event.character?.name, event.kind]), [
    ['Jaina', 'money-change'],
    ['Thrall', 'level-up'],
    ['Thrall', 'money-change'],
    ['Thrall', 'quest-tracked'],
  ]);
  const jainaOnly = await call({ includeHistory: true, character: 'Jaina' });
  assert.deepEqual(jainaOnly.segments.map(segment => segment.character?.name), ['Jaina']);
  assert.deepEqual(jainaOnly.events.map(event => event.money), [999]);
  assert.deepEqual((await call({ since: now - 2000 })).events.map(event => event.kind), ['money-change', 'quest-tracked']);
  assert.deepEqual((await call({ kinds: ['money-change'] })).events.map(event => event.money), [150]);
  assert.deepEqual((await call({ limit: 1 })).events.map(event => event.kind), ['quest-tracked']);
  for (const bad of [{ path: journal }, { limit: 0 }, { limit: 501 }, { kinds: ['chat'] }, { since: -1 }, { character: '' }]) {
    assert.equal((await client.callTool({ name: 'wow_get_session_log', arguments: bad })).isError, true, JSON.stringify(bad));
  }
  assert.equal(await fs.readFile(journal, 'utf8'), document, 'the tool never changes the journal');
  assert.equal(await exists(file), false, 'the tool never creates the cache');
  assert.equal(await exists(contextWantPath(file, 'player')), false, 'nor asks the game for anything');

  // When context sharing is paused in the cache, the tool explains that history remains readable until cleared.
  const pausedCache = snapshot(now);
  pausedCache.enabled = false;
  await fs.writeFile(file, JSON.stringify(pausedCache));
  const whilePaused = await call({});
  assert.equal(whilePaused.sharing, 'paused');
  assert.match(whilePaused.note, /WoW context sharing is paused/u);
});

test('invalid launch arguments and help keep stdout clean', () => {
  for (const args of [['--cache', 'relative.json'], ['--unsafe'], ['--help']]) {
    const result = spawnSync(process.execPath, [binary, ...args], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, args[0] === '--help' ? 0 : 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Usage: witchcraft-mcp/u);
  }
});

test('real STDIO quest hints and persistent wishlist remain separate from game data', { timeout: 15000 }, async t => {
  const file = await workspace(t), raw = snapshot(Date.now()), catalog = await loadGuideCatalog();
  await fs.writeFile(file, JSON.stringify(raw));
  const client = await connect(t, file);
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return result.structuredContent;
  };
  const found = await call('wow_find_guide', { query: 'Defias', kind: 'quest' });
  assert.equal(found.totalMatches, 7);
  const hint = await call('wow_explain_quest', { questId: 166 });
  assert.equal(hint.detail, 'hint');
  assert.equal(hint.observation.trackedState, 'not-observed-in-tracked-batch');
  assert.equal(hint.provenance.compatibility, 'reference-only');
  assert.equal(hint.checks.prerequisites.unknownCount, 1);
  assert.equal(hint.checks.prerequisites.entries, undefined);
  const reference = catalog.quests.find(row => row.id === 166);
  assert.ok(!JSON.stringify(hint).includes(reference.hints.solution));
  const solution = await call('wow_explain_quest', { questId: 166, detail: 'solution', completedQuestIds: [155] });
  assert.equal(solution.guidance.text, reference.hints.solution);
  assert.equal(solution.checks.prerequisites.entries[0].status, 'user-asserted-completed');
  const loot = await call('wow_get_loot_sources', { query: 'Cruel Barb' });
  assert.equal(loot.results[0].itemId, 5191);
  assert.equal(loot.results[0].sources[0].encounter, 'Edwin VanCleef');
  await assert.rejects(fs.access(lootGoalsPath(file)), { code: 'ENOENT' });
  for (const itemId of [5191, 10399, 6324, 2147483647]) await call('wow_set_loot_goal', { itemId, status: 'active' });
  const plan = await call('wow_get_loot_plan');
  assert.equal(plan.plans[0].name, 'The Deadmines');
  assert.equal(plan.plans[0].goalCount, 2);
  assert.equal(plan.unresolvedGoals[0].itemId, 2147483647);
  const second = await connect(t, file);
  assert.equal((await second.callTool({ name: 'wow_get_loot_plan', arguments: {} })).structuredContent.goals.length, 4);
  await call('wow_set_loot_goal', { itemId: 5191, status: 'acquired' });
  assert.equal((await call('wow_get_loot_plan')).excludedAcquiredCount, 1);
  await call('wow_set_loot_goal', { itemId: 5191, status: 'remove' });
  assert.equal((await call('wow_get_loot_plan')).goals.length, 3);
  const rejected = await client.callTool({ name: 'wow_set_loot_goal', arguments: { itemId: 1, status: 'active', profile: '../elsewhere' } });
  assert.equal(rejected.isError, true);
  assert.equal(await fs.readFile(file, 'utf8'), JSON.stringify(raw));
});

test('real STDIO adventures connect rehearsal, quiz, detours and persistent user-confirmed campaigns', { timeout: 15000 }, async t => {
  const file = await workspace(t), raw = snapshot(Date.now());
  raw.player.data.location.zone = 'Westfall';
  await fs.writeFile(file, JSON.stringify(raw));
  const client = await connect(t, file), catalog = await loadAdventureCatalog();
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return result.structuredContent;
  };
  assert.equal((await call('wow_rehearse_dungeon')).dungeons.length, 3);
  assert.equal((await call('wow_rehearse_dungeon', { dungeon: 'deadmines' })).status, 'needs-role');
  await call('wow_set_loot_goal', { itemId: 5191, status: 'active' });
  const dungeon = catalog.dungeons.find(row => row.id === 'deadmines');
  const stageIndex = dungeon.steps.findIndex(row => row.title === 'Edwin VanCleef');
  const rehearsal = await call('wow_rehearse_dungeon', { dungeon: 'deadmines', role: 'healer', step: stageIndex });
  assert.equal(rehearsal.step.roleTip, dungeon.steps[stageIndex].roleTips.healer);
  assert.equal(rehearsal.lootGoals.encounterItems[0].itemId, 5191);
  const quiz = await call('wow_rehearse_dungeon', { dungeon: 'deadmines', role: 'healer', step: stageIndex, mode: 'quiz' });
  assert.equal(quiz.quiz.answerIndex, undefined);
  assert.equal(quiz.step.briefing, undefined); assert.equal(quiz.step.roleTip, undefined);
  assert.ok(!JSON.stringify(quiz).includes(dungeon.steps[stageIndex].quiz.explanation));
  const correct = await call('wow_rehearse_dungeon', { dungeon: 'deadmines', role: 'healer', step: stageIndex, mode: 'answer',
    answerChoice: dungeon.steps[stageIndex].quiz.answerIndex });
  assert.equal(correct.answer.correct, true);
  const reveal = await call('wow_rehearse_dungeon', { dungeon: 'deadmines', role: 'healer', step: stageIndex, mode: 'reveal' });
  assert.equal(reveal.answer.revealed, true); assert.equal(reveal.answer.correct, undefined); assert.equal(reveal.answer.choiceIndex, undefined);
  await assert.rejects(fs.access(passportPath(file)), { code: 'ENOENT' }, 'practice never stamps anything');
  const current = await call('wow_suggest_detours');
  assert.equal(current.zone.source, 'current-player'); assert.equal(current.results.length, 3);
  assert.ok(!JSON.stringify(current).includes('Thrall'), 'zone-only output excludes character identity');
  assert.ok(current.results.every(row => row.details === undefined && row.questIds === undefined));
  const planned = await call('wow_suggest_detours', { zone: 'Westfall', detail: 'details' });
  assert.ok(planned.results.every(row => row.details));
  const campaign = await call('wow_set_passport_campaign', { campaignId: 'early-dungeons', status: 'active' });
  assert.equal(campaign.campaigns.find(row => row.id === 'early-dungeons').joined, true);
  assert.equal(campaign.stampCount, 0);
  const stamp = await call('wow_stamp_passport', { kind: 'dungeon', referenceId: 'deadmines', status: 'complete', note: 'Our first clear' });
  assert.equal(stamp.status, 'saved'); assert.equal(stamp.stampCount, 1);
  assert.equal(stamp.campaigns.find(row => row.id === 'early-dungeons').completedCount, 1);
  assert.equal(stamp.timeline[0].evidence, 'user-confirmed');
  assert.equal((await call('wow_suggest_detours', { zone: 'Westfall' })).results.length, 3,
    'clearing a dungeon does not imply completing linked quests');
  const detour = current.results[0];
  await call('wow_stamp_passport', { kind: 'exploration', referenceId: detour.id, status: 'complete' });
  assert.ok(!(await call('wow_suggest_detours', { zone: 'Westfall' })).results.some(row => row.id === detour.id));
  const guideQuest = await call('wow_stamp_passport', { kind: 'quest', referenceId: '132', status: 'complete' });
  assert.ok(!guideQuest.unresolvedEntries.some(row => row.referenceId === '132'));
  const second = await connect(t, file);
  const resumed = (await second.callTool({ name: 'wow_get_passport', arguments: {} })).structuredContent;
  assert.equal(resumed.stampCount, 3); assert.ok(resumed.timeline.some(row => row.note === 'Our first clear'));
  await call('wow_set_passport_campaign', { campaignId: 'early-dungeons', status: 'remove' });
  assert.equal((await call('wow_get_passport')).stampCount, 3, 'unenrollment retains scrapbook');
  assert.equal((await call('wow_get_passport', { profile: 'alt' })).stampCount, 0);
  assert.equal((await call('wow_stamp_passport', { kind: 'dungeon', referenceId: 'invented', status: 'complete' })).status, 'unknown-reference');
  assert.equal((await call('wow_set_passport_campaign', { campaignId: 'invented', status: 'active' })).status, 'unknown-campaign');
  assert.equal((await call('wow_get_passport')).stampCount, 3);
  await call('wow_stamp_passport', { kind: 'exploration', referenceId: detour.id, status: 'remove' });
  assert.equal((await call('wow_get_passport')).stampCount, 2);
  assert.equal(await fs.readFile(file, 'utf8'), JSON.stringify(raw), 'adventures never mutate game context');
});

test('adventure requests respect paused sharing, explicit zones and unreadable personal records', { timeout: 15000 }, async t => {
  const file = await workspace(t), raw = snapshot(Date.now()); raw.enabled = false;
  await fs.writeFile(file, JSON.stringify(raw));
  const client = await connect(t, file);
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  const unavailable = await call('wow_suggest_detours');
  assert.equal(unavailable.structuredContent.status, 'needs-zone');
  assert.equal((await call('wow_suggest_detours', { zone: 'Silverpine Forest' })).structuredContent.zone.source, 'user-selected');
  for (const domain of ['player', 'quests', 'progress']) assert.equal(await exists(contextWantPath(file, domain)), false);
  assert.equal((await call('wow_rehearse_dungeon', { dungeon: 'deadmines', role: 'healer', mode: 'quiz', answerChoice: 0 })).isError, true);
  assert.equal((await call('wow_get_passport', { profile: '../elsewhere' })).isError, true);
  await fs.writeFile(lootGoalsPath(file), '{');
  const study = await call('wow_rehearse_dungeon', { dungeon: 'deadmines', role: 'healer' });
  assert.equal(study.structuredContent.status, 'reference-rehearsal');
  assert.equal(study.structuredContent.lootGoals.status, 'unavailable');
  const future = '{"schemaVersion":2,"profiles":[]}';
  await fs.writeFile(passportPath(file), future);
  assert.equal((await call('wow_get_passport')).isError, true);
  assert.equal((await call('wow_stamp_passport', { kind: 'dungeon', referenceId: 'deadmines', status: 'complete' })).isError, true);
  assert.equal(await fs.readFile(passportPath(file), 'utf8'), future);
});
