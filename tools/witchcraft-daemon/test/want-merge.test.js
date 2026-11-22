import test from 'node:test';
import assert from 'node:assert/strict';
import { CONTEXT_DOMAIN_BITS, foldContextWants } from '../src/context-want.js';

const want = requestedAt => ({ protocol: 1, requestedAt });
const wants = (player = null, quests = null, progress = null) => ({ player, quests, progress });

test('two domains requested in one tick fold into one combined mask', () => {
  const folded = foldContextWants(wants(want(1_000_000), null, want(1_000_200)), {});
  assert.equal(folded.mask, 5);
  assert.deepEqual(folded.servedAt, { player: 1_000_000, progress: 1_000_200 });
});

test('re-reading unchanged files folds nothing and leaves the served stamps alone', () => {
  const first = foldContextWants(wants(want(1_000_000), want(1_000_000)), {});
  assert.equal(first.mask, 3);
  const again = foldContextWants(wants(want(1_000_000), want(1_000_000)), first.servedAt);
  assert.equal(again.mask, 0);
  assert.deepEqual(again.servedAt, first.servedAt);
  assert.equal(foldContextWants(wants(), first.servedAt).mask, 0, 'expired files fold nothing');
});

test('a later request for a different domain carries only that bit', () => {
  const first = foldContextWants(wants(want(1_000_000)), {});
  const next = foldContextWants(wants(want(1_000_000), null, want(1_000_500)), first.servedAt);
  assert.equal(next.mask, 4, 'the mask is incremental, not cumulative');
  assert.deepEqual(next.servedAt, { player: 1_000_000, progress: 1_000_500 });
});

test('a moved timestamp on an already-folded domain is a new request for that domain', () => {
  const first = foldContextWants(wants(null, want(1_000_000)), {});
  assert.equal(first.mask, 2);
  const next = foldContextWants(wants(null, want(1_000_900)), first.servedAt);
  assert.equal(next.mask, 2);
  assert.equal(next.servedAt.quests, 1_000_900);
  assert.equal(foldContextWants(wants(null, want(1_000_800)), next.servedAt).mask, 0, 'an older stamp is not a new request');
});

test('an errors want folds into bit 8 alongside the game domains', () => {
  const folded = foldContextWants({ player: { protocol: 1, requestedAt: 5 }, quests: null, progress: null, errors: { protocol: 1, requestedAt: 5 } });
  assert.equal(folded.mask, 9);
  assert.equal(CONTEXT_DOMAIN_BITS.errors, 8);
});
