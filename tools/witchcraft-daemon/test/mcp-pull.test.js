import test from 'node:test';
import assert from 'node:assert/strict';
import { CONTEXT_WAIT_MS, pullContext } from '../src/mcp-server.js';

const domain = (status, extra = {}) => ({ status, ageSeconds: 0, data: status === 'available' ? {} : null, ...extra });
const document = (overrides = {}) => ({
  savedAt: 1_000_000, status: 'ready', connection: { status: 'connected', ageSeconds: 0 },
  player: domain('available'), quests: domain('available'), progress: domain('available'), ...overrides,
});

function harness(documents, { start = 1_000_000 } = {}) {
  const calls = { requests: 0, reads: 0, domains: [] };
  let clock = start;
  const pull = domains => pullContext({
    now: () => clock, ...(domains ? { domains } : {}),
    read: async () => { calls.reads++; return documents[Math.min(calls.reads - 1, documents.length - 1)]; },
    request: async ({ domains: requested }) => { calls.requests++; calls.domains.push(requested); return { requestedAt: clock }; },
    sleep: async ms => { clock += ms; },
  });
  return { pull, calls };
}

test('a fresh document is returned without asking the game for anything', async () => {
  const { pull, calls } = harness([document()]);
  assert.equal((await pull()).status, 'ready');
  assert.equal(calls.requests, 0, 'nothing should be pulled when the cache is already fresh');
  assert.equal(calls.reads, 1);
});

test('a stale document raises one request and returns the answer once it lands', async () => {
  const stale = document({ player: domain('stale') });
  const answered = document({ savedAt: 1_000_900 });
  const { pull, calls } = harness([stale, stale, answered]);
  const result = await pull();
  assert.equal(calls.requests, 1, 'exactly one request per pull');
  assert.equal(result.savedAt, 1_000_900);
  assert.equal(result.player.status, 'available');
});

test('an unanswered request gives back the stale document rather than hanging', async () => {
  const stale = document({ quests: domain('missing') });
  const { pull, calls } = harness([stale]);
  const result = await pull();
  assert.equal(calls.requests, 1);
  assert.equal(result.quests.status, 'missing', 'the caller still sees clearly-labelled stale data');
  assert.ok(calls.reads > 1 && calls.reads < CONTEXT_WAIT_MS, 'it polls, but a bounded number of times');
});

test('a connected session with no data yet raises the first request', async () => {
  // On a fresh session the cache is connected but empty. Nothing else ever raises the first
  // want, so treating this as unanswerable would keep the cache empty for the whole session.
  const empty = document({ status: 'waiting', player: domain('missing'), quests: domain('missing') });
  const answered = document({ savedAt: 1_000_000 + 700 });
  const { pull, calls } = harness([empty, empty, answered]);
  assert.equal((await pull()).status, 'ready');
  assert.equal(calls.requests, 1, 'a connected but empty cache should raise exactly one want');
});

test('a pull requests only the domains the caller owns and judges freshness by them alone', async () => {
  const partial = document({ status: 'partial', progress: domain('missing') });
  const character = harness([partial]);
  assert.equal((await character.pull(['player'])).player.status, 'available');
  assert.equal(character.calls.requests, 0, 'a missing domain the caller does not own is not a reason to pull');
  const quests = harness([document({ status: 'partial', player: domain('stale'), progress: domain('missing') })]);
  await quests.pull(['quests']);
  assert.equal(quests.calls.requests, 0);
  const progress = harness([partial, partial, document({ savedAt: 1_000_450 })]);
  assert.equal((await progress.pull(['progress'])).progress.status, 'available');
  assert.deepEqual(progress.calls.domains, [['progress']], 'the request names exactly the owned domains');
  const whole = harness([partial]);
  await whole.pull();
  assert.deepEqual(whole.calls.domains, [['player', 'quests', 'progress']], 'no domain list means the whole document');
  // The answer is judged over the owned domains too: another domain still missing does not keep the wait open.
  const answered = document({ savedAt: 1_000_450, status: 'partial', player: domain('missing') });
  const only = harness([partial, answered]);
  assert.equal((await only.pull(['progress'])).savedAt, 1_000_450);
  assert.equal(only.calls.reads, 2);
});

test('the connected-but-empty gate raises a want for every domain list', async () => {
  const empty = document({ status: 'waiting', player: domain('missing'), quests: domain('missing'), progress: domain('missing') });
  for (const domains of [['player'], ['quests'], ['progress'], ['player', 'quests', 'progress']]) {
    const { pull, calls } = harness([empty, empty, document({ savedAt: 1_000_700 })]);
    assert.equal((await pull(domains)).status, 'ready');
    assert.deepEqual(calls.domains, [domains]);
  }
});

test('nothing is requested when the addon could not answer anyway', async () => {
  for (const unanswerable of [
    document({ status: 'disabled', player: domain('disabled'), quests: domain('disabled'), progress: domain('disabled') }),
    document({ status: 'disconnected', connection: { status: 'disconnected', ageSeconds: 99 }, player: domain('stale') }),
    document({ status: 'waiting', connection: { status: 'waiting', ageSeconds: null }, player: domain('missing') }),
  ]) {
    const { pull, calls } = harness([unanswerable]);
    await pull();
    assert.equal(calls.requests, 0, `a ${unanswerable.status} cache should not raise a want`);
  }
});

// The screen strip adds a conservative 30 s to every message's age, so a record captured an
// instant ago still reads at least 30 s old; only its arrival time says it answers this request.
test('a maximum age is met by a capture that lands after the request, whatever age the strip adds', async () => {
  let clock = 1_000_000, requests = 0, reads = 0;
  const aged = document({ errors: domain('available', { ageSeconds: 40, receivedAt: 990_000 }) });
  const landed = document({ savedAt: 1_000_450, errors: domain('available', { ageSeconds: 31, receivedAt: 1_000_450 }) });
  const docs = [aged, aged, aged, landed];
  const result = await pullContext({ now: () => clock, domains: ['errors'], maxAgeMs: 5000,
    read: async () => docs[Math.min(reads++, docs.length - 1)], request: async () => { requests++; }, sleep: async ms => { clock += ms; } });
  assert.equal(result.errors.receivedAt, 1_000_450);
  assert.equal(reads, 4, 'it returns on the read where the capture lands, not at the deadline');
  assert.equal(requests, 1);
});

test('a pull waits on a want that is still unanswered instead of queuing a second capture', async () => {
  let clock = 1_000_000, reads = 0;
  const requested = [];
  const aged = document({ errors: domain('available', { ageSeconds: 40, receivedAt: 990_000 }) });
  const landed = document({ savedAt: 1_000_300, errors: domain('available', { ageSeconds: 31, receivedAt: 1_000_300 }) });
  const docs = [aged, aged, landed];
  const result = await pullContext({ now: () => clock, domains: ['errors'], maxAgeMs: 5000,
    read: async () => docs[Math.min(reads++, docs.length - 1)],
    // Another assistant's errors pull is already on its way to the game.
    outstanding: async ({ domains }) => domains,
    request: async ({ domains }) => { requested.push(domains); }, sleep: async ms => { clock += ms; } });
  assert.deepEqual(requested, [], 'no second want while the first is unanswered');
  assert.equal(result.errors.receivedAt, 1_000_300);
});

test('a maximum age re-requests an available domain that is older than it', async () => {
  let clock = 1_000_000, requests = 0;
  const aged = document({ errors: domain('available', { ageSeconds: 30 }) });
  const fresh = document({ savedAt: 1_000_300, errors: domain('available', { ageSeconds: 0 }) });
  const reads = [aged, aged, fresh];
  let index = 0;
  const pull = maxAgeMs => pullContext({ now: () => clock, domains: ['errors'], maxAgeMs,
    read: async () => reads[Math.min(index++, reads.length - 1)],
    request: async () => { requests++; }, sleep: async ms => { clock += ms; } });
  assert.equal((await pull(5000)).savedAt, 1_000_300);
  assert.equal(requests, 1);
  index = 0;
  assert.equal((await pull()).savedAt, 1_000_000, 'without a maximum an available domain is simply returned');
  assert.equal(requests, 1);
});
