import fs from 'node:fs/promises';
import { z } from 'zod';

export const CONTEXT_TTL_MS = 180_000;
export const HEARTBEAT_TTL_MS = 30_000;
export const MAX_CONTEXT_FILE_BYTES = 128 * 1024;
export const HEARTBEAT_REFRESH_MS = 10_000;

/**
 * The durable identity of a stored document. Presentation recomputes freshness on every
 * read, so only this has to reach disk; `savedAt` and a drifting heartbeat do not.
 */
export function contextWriteKey(raw) {
  const { savedAt, lastHeartbeatAt, ...durable } = raw;
  return JSON.stringify(durable);
}

/**
 * True when the stored document no longer speaks for the cache. Content changes always
 * qualify. A heartbeat only does once it has aged enough to matter for the connected
 * boundary, which keeps an idle session from rewriting an identical document every tick.
 */
export function shouldPersistContext(written, raw) {
  if (!written || written.key !== contextWriteKey(raw)) return true;
  const before = written.lastHeartbeatAt, after = raw.lastHeartbeatAt;
  if ((before === null) !== (after === null)) return true;
  return before !== null && after - before >= HEARTBEAT_REFRESH_MS;
}
const HEX = /^[0-9a-f]{8}$/u;
const text = limit => z.string().refine(value => Buffer.byteLength(value, 'utf8') <= limit &&
  !/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value));
const stamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const counter = z.number().int().min(0).max(2_147_483_647);
const identifier = counter.positive();
const level = z.number().int().min(1).max(1000);
const trackedCount = z.number().int().min(0).max(1000);
const revision = z.number().int().min(1).max(2_147_483_647);
const maybe = schema => z.union([schema, z.literal(false)]);
const objectiveWire = z.tuple([text(64), maybe(counter), maybe(counter), z.boolean()]);
const questWire = z.tuple([identifier, text(64), z.boolean(), z.array(objectiveWire).max(4), z.boolean()]);
const playerWire = z.tuple([maybe(text(40)), maybe(text(40)), maybe(level), maybe(identifier), maybe(text(40)), maybe(text(40)), z.array(text(64)).max(12)]);
const questsWire = z.tuple([z.boolean(), text(64), trackedCount, z.boolean(), z.array(questWire).max(1)]);
// [money, xp, xpMax, rested, inInstance, instanceType, instanceName, difficulty, groupSize, role, dead, ghost, combat, unavailableFields]
const progressWire = z.tuple([maybe(counter), maybe(counter), maybe(counter), maybe(counter), z.boolean(), maybe(text(16)), maybe(text(40)),
  maybe(text(24)), maybe(trackedCount), maybe(text(8)), z.boolean(), z.boolean(), z.boolean(), z.array(text(64)).max(14)]);
// [kind, message, stack, count, firstAgo, lastAgo, reloadsAgo]; ages are seconds before the sample.
const errorKind = z.enum(['error', 'warning', 'blocked', 'forbidden']);
const errorStack = z.array(text(200)).max(3).refine(frames => frames.reduce((total, frame) => total + Buffer.byteLength(frame, 'utf8'), 0) <= 200);
const errorCount = z.number().int().min(1).max(999999);
const storedCount = z.number().int().min(0).max(20);
const errorRowWire = z.tuple([errorKind, text(240), errorStack, errorCount, counter, counter, counter]);
const errorsWire = z.tuple([z.boolean(), text(64), storedCount, z.boolean(), z.array(errorRowWire).max(1)]);
export const CONTEXT_DOMAINS = Object.freeze(['player', 'quests', 'progress', 'errors']);
/** The game-state domains; errors are only ever pulled on their own. */
export const GAME_DOMAINS = Object.freeze(['player', 'quests', 'progress']);
// Both send one row per part under the same [available, reason, count, truncated, [row]] shape.
const MULTIPART = new Set(['quests', 'errors']);
const envelope = z.tuple([z.literal(1), z.enum([...CONTEXT_DOMAINS, 'state']), revision,
  z.number().int().min(1).max(10), z.number().int().min(1).max(10), z.number().int().min(0).max(86400), z.unknown()]);

const playerData = z.object({ name: text(40).nullable(), class: text(40).nullable(), level: level.nullable(),
  location: z.object({ mapId: identifier.nullable(), zone: text(40).nullable(), subzone: text(40).nullable() }),
  unavailableFields: z.array(text(64)).max(12) });
const questData = z.object({ trackedCount, truncated: z.boolean(), quests: z.array(z.object({
  id: identifier, title: text(64), complete: z.boolean(), truncated: z.boolean(),
  objectives: z.array(z.object({ text: text(64), fulfilled: counter.nullable(), required: counter.nullable(), finished: z.boolean() })).max(4),
})).max(10) });
const progressData = z.object({ money: counter.nullable(), xp: counter.nullable(), xpMax: counter.nullable(), rested: counter.nullable(),
  situation: z.object({ inInstance: z.boolean().nullable(), instanceType: text(16).nullable(), instanceName: text(40).nullable(), difficulty: text(24).nullable(),
    groupSize: trackedCount.nullable(), role: text(8).nullable(), dead: z.boolean().nullable(), ghost: z.boolean().nullable(), combat: z.boolean().nullable() }),
  unavailableFields: z.array(text(64)).max(14) });
const errorsData = z.object({ storedCount, truncated: z.boolean(), entries: z.array(z.object({ kind: errorKind, message: text(240),
  stack: errorStack, count: errorCount, firstSeenAt: stamp, lastSeenAt: stamp, reloadsAgo: counter })).max(8) });
const recordSchema = data => z.object({ revision, available: z.boolean(), reason: text(160),
  sampledAt: stamp, receivedAt: stamp, data: data.nullable() }).refine(row => row.sampledAt <= row.receivedAt && row.available === (row.data !== null));
const diskSchema = z.object({ schemaVersion: z.literal(1), source: z.literal('witchcraft-addon'),
  session: z.object({ epoch: z.string().regex(HEX), uiNonce: z.string().regex(HEX) }).nullable(),
  enabled: z.boolean().nullable(), lastHeartbeatAt: stamp.nullable(), savedAt: stamp,
  player: recordSchema(playerData).nullable(), quests: recordSchema(questData).nullable(),
  // Additive under schemaVersion 1: a document written before this domain existed still reads.
  progress: recordSchema(progressData).nullable().default(null),
  errors: recordSchema(errorsData).nullable().default(null),
});
const nullable = value => value === false ? null : value;
const age = (now, then) => then === null ? null : Math.max(0, Math.round((now - then) / 1000));

function unavailableReason(fields) {
  let reason = '';
  for (const character of fields.join(', ')) {
    if (Buffer.byteLength(reason + character, 'utf8') > 160) break;
    reason += character;
  }
  return reason || 'api-unavailable';
}

function empty() {
  return { schemaVersion: 1, source: 'witchcraft-addon', session: null, enabled: null, lastHeartbeatAt: null,
    savedAt: 0, player: null, quests: null, progress: null, errors: null };
}

function domainView(record, enabled, now) {
  if (enabled === false) return { status: 'disabled', ageSeconds: null, data: null };
  if (!record) return { status: 'missing', ageSeconds: null, data: null };
  return { ...record, ageSeconds: age(now, record.sampledAt),
    status: now - record.sampledAt > CONTEXT_TTL_MS ? 'stale' : record.available ? 'available' : 'unavailable' };
}

/** The document-level label for the domains a caller owns, once the session itself is answerable. */
function domainsStatus(context, domains) {
  const views = domains.map(domain => context[domain]);
  const available = views.filter(item => item.status === 'available').length;
  return available === views.length ? 'ready' : available ? 'partial' : views.some(item => item.status === 'stale') ? 'stale' :
    views.some(item => item.status === 'unavailable') ? 'unavailable' : 'waiting';
}

/** Recompute all freshness from trusted local timestamps, never a persisted status label. */
export function presentContext(value, now = Date.now()) {
  const parsed = diskSchema.safeParse(value);
  if (!parsed.success) return unavailableContext('invalid-cache', now);
  const raw = parsed.data;
  if (raw.savedAt > now + 5000 || (raw.lastHeartbeatAt ?? 0) > now + 5000 ||
      CONTEXT_DOMAINS.some(domain => raw[domain] && raw[domain].receivedAt > now + 5000)) return unavailableContext('invalid-cache', now);
  if (raw.enabled === false) for (const domain of CONTEXT_DOMAINS) raw[domain] = null;
  const connected = raw.lastHeartbeatAt !== null && now - raw.lastHeartbeatAt <= HEARTBEAT_TTL_MS;
  const views = Object.fromEntries(CONTEXT_DOMAINS.map(domain => [domain, domainView(raw[domain], raw.enabled, now)]));
  const status = raw.enabled === false ? 'disabled' : !raw.session ? 'waiting' : !connected ? 'disconnected' : domainsStatus(views, GAME_DOMAINS);
  // Relative ages are recomputed on every read, like every other freshness value.
  if (views.errors.data) views.errors = { ...views.errors, data: { ...views.errors.data, entries: views.errors.data.entries.map(entry =>
    ({ ...entry, firstSeenSecondsAgo: age(now, entry.firstSeenAt), lastSeenSecondsAgo: age(now, entry.lastSeenAt) })) } };
  return { ...raw, status, connection: { status: connected ? 'connected' : raw.session ? 'disconnected' : 'waiting',
    ageSeconds: age(now, raw.lastHeartbeatAt) }, ...views };
}

/**
 * The document as one tool sees it: only the domains it owns, with the top-level status
 * recomputed over them so a tool never reads 'partial' for a domain it never asked about.
 * Session-wide labels (disabled, disconnected, waiting for a session, unreadable cache) stand.
 */
export function scopeContext(context, domains) {
  const scored = context.session && context.enabled !== false && context.connection?.status === 'connected';
  const result = { ...context, status: scored ? domainsStatus(context, domains) : context.status };
  for (const domain of CONTEXT_DOMAINS) if (!domains.includes(domain)) delete result[domain];
  return result;
}

export function unavailableContext(reason, now = Date.now()) {
  return { ...empty(), savedAt: now, status: 'unavailable', reason, connection: { status: 'unknown', ageSeconds: null },
    ...Object.fromEntries(CONTEXT_DOMAINS.map(domain => [domain, { status: 'missing', ageSeconds: null, data: null }])) };
}

/** The daemon owns writes; the MCP process only reads this fixed, bounded JSON document. */
export async function readContextFile(file, { now = Date.now() } = {}) {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_CONTEXT_FILE_BYTES) return unavailableContext('invalid-cache', now);
    const buffer = Buffer.alloc(MAX_CONTEXT_FILE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await handle.read(buffer, length, buffer.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > MAX_CONTEXT_FILE_BYTES) return unavailableContext('invalid-cache', now);
    return presentContext(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))), now);
  } catch (error) {
    return unavailableContext(error.code === 'ENOENT' ? 'cache-missing' : error instanceof SyntaxError || error instanceof TypeError ? 'invalid-cache' : 'cache-unreadable', now);
  } finally { await handle?.close(); }
}

export class ContextCache {
  constructor({ epoch } = {}) {
    this.raw = empty();
    this.epoch = epoch;
    this.ack = 0;
    this.latest = { player: 0, quests: 0, progress: 0, errors: 0, state: 0 };
    this.pending = {};
  }

  setSession(epoch, uiNonce) {
    if (!HEX.test(epoch ?? '') || !HEX.test(uiNonce ?? '') || /^0{8}$/u.test(epoch) || /^0{8}$/u.test(uiNonce)) return false;
    if (this.raw.session?.epoch === epoch && this.raw.session.uiNonce === uiNonce) return false;
    this.raw = { ...empty(), session: { epoch, uiNonce } };
    this.epoch = epoch;
    this.ack = 0;
    this.latest = { player: 0, quests: 0, progress: 0, errors: 0, state: 0 };
    this.pending = {};
    return true;
  }

  heartbeat(now = Date.now()) { this.raw.lastHeartbeatAt = now; return true; }
  disconnect() { this.raw.lastHeartbeatAt = null; }

  accept(message, now = Date.now()) {
    const reject = reason => ({ accepted: false, ack: this.ack, reason });
    if (message?.kind !== 'context' || !this.raw.session || message.epoch !== this.raw.session.epoch || message.uiNonce !== this.raw.session.uiNonce) return reject('session');
    if (!Number.isInteger(message.id) || message.id < 1 || message.id > 262143 || typeof message.text !== 'string' || Buffer.byteLength(message.text, 'utf8') > 580) return reject('envelope');
    let value;
    try { value = envelope.parse(JSON.parse(message.text)); } catch { return reject('payload'); }
    const [, domain, rev, part, total, sampleAge, data] = value;
    if (part > total || (!MULTIPART.has(domain) && (part !== 1 || total !== 1))) return reject('parts');
    const wire = { player: playerWire, quests: questsWire, progress: progressWire, errors: errorsWire }[domain] ?? z.tuple([z.boolean()]);
    if (!wire.safeParse(data).success) return reject('domain');
    if (MULTIPART.has(domain) && ((!data[0] && (total !== 1 || data[4].length !== 0)) ||
        (total > 1 && data[4].length !== 1) || data[2] < data[4].length)) return reject(domain);
    if (domain !== 'state' && this.raw.enabled === false) return reject('disabled');
    // Stale revisions may be acknowledged to release a retransmitting sender, but cannot replace state.
    const accept = () => { this.ack = Math.max(this.ack, message.id); return { accepted: true, ack: this.ack }; };
    if (rev <= this.latest[domain]) return accept();
    if (domain === 'state') {
      this.latest.state = rev;
      this.raw.enabled = data[0];
      if (!data[0]) { for (const key of CONTEXT_DOMAINS) this.raw[key] = null; this.pending = {}; }
      return accept();
    }
    const transportAge = message.transportAgeSeconds ?? 0;
    if (!Number.isFinite(transportAge) || transportAge < 0 || transportAge > 60) return reject('transport-age');
    const sampledAt = Math.max(0, Math.floor(now - (sampleAge + transportAge) * 1000));
    this.raw.enabled = true;
    if (domain === 'player') {
      const [name, className, level, mapId, zone, subzone, unavailableFields] = data;
      const available = data.slice(0, 6).some(item => item !== false);
      this.raw.player = { revision: rev, available, reason: available ? '' : unavailableReason(unavailableFields), sampledAt, receivedAt: now,
        data: available ? { name: nullable(name), class: nullable(className), level: nullable(level),
          location: { mapId: nullable(mapId), zone: nullable(zone), subzone: nullable(subzone) }, unavailableFields } : null };
      this.latest.player = rev;
      return accept();
    }
    if (domain === 'progress') {
      const [money, xp, xpMax, rested, inInstance, instanceType, instanceName, difficulty, groupSize, role, dead, ghost, combat, unavailableFields] = data;
      // A boolean answers "no" with false; it is unavailable only when the addon says so.
      const missing = name => unavailableFields.some(item => item.startsWith(name + ':') && !item.endsWith(':truncated'));
      const flag = (value, name) => value === false && missing(name) ? null : value;
      const flags = ['inInstance', 'dead', 'ghost', 'combat'];
      const available = data.slice(0, 13).some(item => item !== false) || flags.some(name => !missing(name));
      this.raw.progress = { revision: rev, available, reason: available ? '' : unavailableReason(unavailableFields), sampledAt, receivedAt: now,
        data: available ? { money: nullable(money), xp: nullable(xp), xpMax: nullable(xpMax), rested: nullable(rested),
          situation: { inInstance: flag(inInstance, 'inInstance'), instanceType: nullable(instanceType), instanceName: nullable(instanceName), difficulty: nullable(difficulty),
            groupSize: nullable(groupSize), role: nullable(role), dead: flag(dead, 'dead'), ghost: flag(ghost, 'ghost'), combat: flag(combat, 'combat') }, unavailableFields } : null };
      this.latest.progress = rev;
      return accept();
    }
    // Multi-part domains assemble independently, so an errors batch never disturbs a quest batch.
    const held = this.pending[domain];
    if (held && rev < held.revision) return accept();
    if (!held || rev > held.revision) this.pending[domain] = { revision: rev, total, sampledAt, parts: new Map() };
    const pending = this.pending[domain];
    if (pending.total !== total) return reject('parts');
    const previous = pending.parts.get(part);
    if (previous && JSON.stringify(previous) !== JSON.stringify(data)) return reject('conflicting-part');
    if ([...pending.parts.values()].some(row => row[0] !== data[0] || row[1] !== data[1] || row[2] !== data[2] || row[3] !== data[3])) return reject('conflicting-metadata');
    pending.sampledAt = Math.min(pending.sampledAt, sampledAt);
    pending.parts.set(part, data);
    if (pending.parts.size === total && domain === 'errors') {
      const rows = [...pending.parts].sort((a, b) => a[0] - b[0]).flatMap(([, value]) => value[4]);
      delete this.pending.errors;
      if (rows.length > data[2]) return reject('conflicting-errors');
      const [available, reason, count, truncated] = data, at = seconds => Math.max(0, pending.sampledAt - seconds * 1000);
      this.raw.errors = { revision: rev, available, reason, sampledAt: pending.sampledAt, receivedAt: now,
        data: available ? { storedCount: count, truncated: truncated || count > rows.length,
          entries: rows.map(([kind, text, stack, hits, firstAgo, lastAgo, reloadsAgo]) => ({ kind, message: text, stack, count: hits,
            firstSeenAt: at(firstAgo), lastSeenAt: at(lastAgo), reloadsAgo })) } : null };
      this.latest.errors = rev;
    } else if (pending.parts.size === total) {
      const rows = [...pending.parts].sort((a, b) => a[0] - b[0]).flatMap(([, value]) => value[4]);
      if (new Set(rows.map(row => row[0])).size !== rows.length || rows.length > data[2]) { delete this.pending.quests; return reject('conflicting-quests'); }
      const [available, reason, trackedCount, truncated] = data;
      this.raw.quests = { revision: rev, available, reason, sampledAt: pending.sampledAt, receivedAt: now,
        data: available ? { trackedCount, truncated: truncated || trackedCount > rows.length,
          quests: rows.map(([id, title, complete, objectives, rowTruncated]) => ({ id, title, complete, truncated: rowTruncated,
            objectives: objectives.map(([text, fulfilled, required, finished]) => ({ text, fulfilled: nullable(fulfilled), required: nullable(required), finished })) })) } : null };
      this.latest.quests = rev;
      delete this.pending.quests;
    }
    return accept();
  }

  snapshot(now = Date.now()) {
    // Missing records remain null in the stored document; presentation adds their user-facing status.
    const raw = { ...this.raw, savedAt: now };
    const view = presentContext(raw, now);
    return { ...view, ...Object.fromEntries(CONTEXT_DOMAINS.map(domain => [domain, this.raw[domain] ? view[domain] : null])) };
  }
}
