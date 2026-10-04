// Game context is pulled, never streamed. The MCP server runs in its own process and knows
// only the cache path, so a request for fresh context crosses to the daemon through small
// sibling files, one per domain so two adapters never rewrite each other's request. The
// daemon owns the cache; the MCP process owns the wants.
import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite } from './ring.js';
import { CONTEXT_DOMAINS, GAME_DOMAINS } from './context-cache.js';

export const CONTEXT_WANT_PROTOCOL = 1;
export const CONTEXT_WANT_TTL_MS = 60_000;
export const MAX_WANT_FILE_BYTES = 1024;
/** The chunk mask bit each domain occupies, in the addon's fixed capture order. */
export const CONTEXT_DOMAIN_BITS = Object.freeze({ player: 1, quests: 2, progress: 4, errors: 8 });
export { CONTEXT_DOMAINS, GAME_DOMAINS };

export function contextWantPath(cachePath, domain) {
  if (typeof cachePath !== 'string' || !path.isAbsolute(cachePath)) {
    throw new TypeError('Context want requires an absolute cache path');
  }
  if (!CONTEXT_DOMAINS.includes(domain)) throw new TypeError('Context want requires a known domain');
  const resolved = path.resolve(cachePath), extension = path.extname(resolved);
  return path.join(path.dirname(resolved), `${path.basename(resolved, extension)}.want.${domain}${extension || '.json'}`);
}

/** Ask the daemon for fresh context. Repeated requests simply move the timestamp forward. */
export async function requestContext(file, { now = Date.now() } = {}) {
  const want = { protocol: CONTEXT_WANT_PROTOCOL, requestedAt: now };
  await atomicWrite(file, JSON.stringify(want) + '\n');
  return want;
}

/**
 * The newest outstanding request, or null. A request that has expired, was stamped in the
 * future, or does not parse is ignored rather than trusted: a bad want would otherwise pin
 * the addon into capturing forever, which is the exact cost this design exists to avoid.
 */
export async function readContextWant(file, { now = Date.now() } = {}) {
  let source;
  try { source = await fs.readFile(file, { encoding: 'utf8' }); } catch { return null; }
  if (source.length > MAX_WANT_FILE_BYTES) return null;
  let value;
  try { value = JSON.parse(source); } catch { return null; }
  if (!value || value.protocol !== CONTEXT_WANT_PROTOCOL || !Number.isSafeInteger(value.requestedAt)) return null;
  if (value.requestedAt > now || now - value.requestedAt > CONTEXT_WANT_TTL_MS) return null;
  return { protocol: CONTEXT_WANT_PROTOCOL, requestedAt: value.requestedAt };
}

/**
 * The domains whose last want is newer than their last record and was raised within withinMs, so
 * the game is still answering it; a second want would only queue another capture. An older want
 * is not counted: the daemon may have folded it into a chunk the addon never read, or the capture
 * stalled, and nothing but a fresh want raises it again.
 */
export async function unansweredWants(cachePath, domains, context, { now = Date.now(), withinMs = CONTEXT_WANT_TTL_MS } = {}) {
  const asked = await Promise.all(domains.map(domain => readContextWant(contextWantPath(cachePath, domain), { now })));
  return domains.filter((domain, index) => asked[index] && now - asked[index].requestedAt < withinMs
    && asked[index].requestedAt > (context?.[domain]?.receivedAt ?? 0));
}

/** Every domain's outstanding request, keyed by domain, with null where there is none. */
export async function readContextWants(cachePath, { now = Date.now() } = {}) {
  const rows = await Promise.all(CONTEXT_DOMAINS.map(async domain => [domain, await readContextWant(contextWantPath(cachePath, domain), { now })]));
  return Object.fromEntries(rows);
}

/**
 * Fold one tick's reads into the chunk mask. A domain is newly requested when its want is
 * later than the stamp last folded for it; the mask names only those domains, so a chunk the
 * addon never reads loses its bits and the adapter's next call raises a fresh want.
 */
export function foldContextWants(wants, servedAt = {}) {
  let mask = 0;
  const next = { ...servedAt };
  for (const domain of CONTEXT_DOMAINS) {
    const want = wants[domain];
    if (!want || want.requestedAt <= (servedAt[domain] ?? 0)) continue;
    next[domain] = want.requestedAt;
    mask |= CONTEXT_DOMAIN_BITS[domain];
  }
  return { mask, servedAt: next };
}
