import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CONTEXT_DOMAINS, CONTEXT_WANT_TTL_MS, contextWantPath, readContextWant, readContextWants, requestContext, unansweredWants } from '../src/context-want.js';

async function scratch(t) {
  const temp = await fs.realpath(os.tmpdir());
  const dir = await fs.mkdtemp(path.join(temp, 'witchcraft-want-'));
  t.after(async () => { assert.equal(path.dirname(await fs.realpath(dir)), temp); await fs.rm(dir, { recursive: true, force: true }); });
  return path.join(dir, 'wow-context.json');
}

test('a want is unanswered until a record for its domain arrives after it, and only inside its TTL', async t => {
  const cache = await scratch(t), now = 2_000_000;
  await requestContext(contextWantPath(cache, 'errors'), { now: now - 2_000 });
  await requestContext(contextWantPath(cache, 'player'), { now: now - 2_000 });
  await requestContext(contextWantPath(cache, 'quests'), { now: now - CONTEXT_WANT_TTL_MS - 1 });
  const context = { errors: { receivedAt: now - 5_000 }, player: { receivedAt: now - 1_000 }, quests: { receivedAt: 0 }, progress: null };
  // errors: asked after its last record, still waiting. player: answered since. quests: expired. progress: never asked.
  assert.deepEqual(await unansweredWants(cache, ['player', 'quests', 'progress', 'errors'], context, { now }), ['errors']);
  assert.deepEqual(await unansweredWants(cache, ['errors'], { errors: null }, { now }), ['errors'], 'a domain with no record yet is still waiting');
});

test('a want older than the pull wait is no longer on its way, so a later pull asks again', async t => {
  // A want the daemon folded but the game never served (a chunk it skipped, a stalled capture)
  // would otherwise block every pull until its 60 s TTL ran out.
  const cache = await scratch(t), now = 2_000_000;
  await requestContext(contextWantPath(cache, 'errors'), { now: now - 20_000 });
  const context = { errors: { receivedAt: now - 30_000 } };
  assert.deepEqual(await unansweredWants(cache, ['errors'], context, { now, withinMs: 12_000 }), []);
  assert.deepEqual(await unansweredWants(cache, ['errors'], context, { now, withinMs: 30_000 }), ['errors']);
});

test('each domain has its own want file beside the cache and none collides with another', async t => {
  const cache = await scratch(t);
  const files = CONTEXT_DOMAINS.map(domain => contextWantPath(cache, domain));
  assert.deepEqual(files.map(file => path.basename(file)),
    ['wow-context.want.player.json', 'wow-context.want.quests.json', 'wow-context.want.progress.json', 'wow-context.want.errors.json']);
  for (const file of files) { assert.equal(path.dirname(file), path.dirname(cache)); assert.notEqual(file, cache); }
  assert.equal(new Set(files).size, files.length);
  assert.throws(() => contextWantPath('relative/cache.json', 'player'), /absolute/u);
  assert.throws(() => contextWantPath(cache), /domain/u);
  assert.throws(() => contextWantPath(cache, 'state'), /domain/u);
});

test('a request is readable by the daemon and a later request supersedes it', async t => {
  const cache = await scratch(t), want = contextWantPath(cache, 'player');
  assert.equal(await readContextWant(want), null, 'no request yet');

  const first = await requestContext(want, { now: 1_000_000 });
  assert.equal(first.requestedAt, 1_000_000);
  assert.deepEqual(await readContextWant(want, { now: 1_000_000 }), { protocol: 1, requestedAt: 1_000_000 });

  await requestContext(want, { now: 1_000_500 });
  assert.equal((await readContextWant(want, { now: 1_000_500 })).requestedAt, 1_000_500);
});

test('a stale or malformed request is ignored rather than trusted', async t => {
  const cache = await scratch(t), want = contextWantPath(cache, 'player');
  await requestContext(want, { now: 1_000_000 });
  assert.equal(await readContextWant(want, { now: 1_000_000 + CONTEXT_WANT_TTL_MS + 1 }), null, 'expired');

  // A request stamped in the future cannot be used to pin the want on forever.
  await requestContext(want, { now: 5_000_000 });
  assert.equal(await readContextWant(want, { now: 1_000_000 }), null, 'clock skew');

  await fs.writeFile(want, 'not json');
  assert.equal(await readContextWant(want, { now: 1_000_000 }), null);
  await fs.writeFile(want, JSON.stringify({ protocol: 9, requestedAt: 1_000_000 }));
  assert.equal(await readContextWant(want, { now: 1_000_000 }), null);
  await fs.writeFile(want, 'x'.repeat(4096));
  assert.equal(await readContextWant(want, { now: 1_000_000 }), null);
});

test('domains expire independently and the legacy single want file is never read', async t => {
  const cache = await scratch(t);
  await requestContext(contextWantPath(cache, 'player'), { now: 1_000_000 });
  await requestContext(contextWantPath(cache, 'progress'), { now: 1_000_000 + CONTEXT_WANT_TTL_MS });
  await fs.writeFile(path.join(path.dirname(cache), 'wow-context.want.json'), JSON.stringify({ protocol: 1, requestedAt: 1_000_000 + CONTEXT_WANT_TTL_MS }));
  const wants = await readContextWants(cache, { now: 1_000_000 + CONTEXT_WANT_TTL_MS + 1 });
  assert.deepEqual(wants, { player: null, quests: null, progress: { protocol: 1, requestedAt: 1_000_000 + CONTEXT_WANT_TTL_MS }, errors: null });
});
