import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { atomicWrite, isTransientWriteError } from './ring.js';

// A bounded record of what changed during a session. The daemon builds it by diffing the context
// documents it persisted, so it costs no wire traffic and needs nothing from the addon. Only the
// fields listed below are journaled: never errors, terminal text, prompts or other players.
export const journalPath = cachePath => path.join(path.dirname(cachePath), `${path.basename(cachePath, '.json')}.journal.json`);
// A clear leaves this marker beside the journal: the newest clear on record, which every append
// and read honours, so a writer in another process cannot bring cleared history back.
const markerOf = file => path.join(path.dirname(file), `${path.basename(file, '.json')}.cleared`);
export const clearMarkerPath = cachePath => markerOf(journalPath(cachePath));
// Clears take turns on a lock file beside the marker; one older than this was left by a clear that died holding it.
const LOCK_STALE_MS = 5000;

const text = limit => z.string().refine(value => Buffer.byteLength(value, 'utf8') <= limit &&
  !/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value));
const stamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const counter = z.number().int().min(0).max(2_147_483_647);
const identifier = counter.positive();
const level = z.number().int().min(1).max(1000);
const groupSize = z.number().int().min(0).max(1000);
const revision = z.number().int().min(1).max(2_147_483_647);
const quest = { questId: identifier, title: text(64) };

// Each kind, the domain it comes from, and the only fields it may carry.
const EVENT_FIELDS = {
  'level-up': ['player', { from: level, to: level }],
  'zone-change': ['player', { mapId: identifier.nullable(), zone: text(40).nullable(), subzone: text(40).nullable() }],
  'quest-tracked': ['quests', quest],
  'quest-untracked': ['quests', quest],
  'quest-completed': ['quests', quest],
  'objective-progress': ['quests', { ...quest, objective: text(64), have: counter, need: counter.nullable() }],
  'money-change': ['progress', { delta: z.number().int().min(-2_147_483_647).max(2_147_483_647), money: counter }],
  'instance-enter': ['progress', { instanceName: text(40).nullable(), instanceType: text(16).nullable(), difficulty: text(24).nullable() }],
  'instance-leave': ['progress', {}],
  'died': ['progress', {}],
  'ghost': ['progress', {}],
  'revived': ['progress', {}],
  'group-size': ['progress', { from: groupSize, to: groupSize }],
};
export const JOURNAL_KINDS = Object.freeze(Object.keys(EVENT_FIELDS));

const CAPS = Object.freeze({ segments: 8, events: 500, bytes: 256 * 1024, segmentMs: 24 * 60 * 60 * 1000 });
const eventSchema = z.discriminatedUnion('kind', JOURNAL_KINDS.map(kind => {
  const [domain, fields] = EVENT_FIELDS[kind];
  return z.object({ at: stamp, domain: z.literal(domain), revision, kind: z.literal(kind), ...fields }).strict();
}));
const sessionId = z.string().regex(/^[0-9a-f]{8}$/u).nullable();
const segmentSchema = z.object({ epoch: sessionId, uiNonce: sessionId, startedAt: stamp, endedAt: stamp.nullable(),
  character: z.object({ name: text(40).nullable(), class: text(40).nullable() }).strict().nullable(),
  events: z.array(eventSchema).max(CAPS.events) }).strict();
// clearedAt is the newest clear the document has honoured; a file written before the field reads as 0.
const documentSchema = z.object({ schemaVersion: z.literal(1), clearedAt: stamp.default(0),
  segments: z.array(segmentSchema).max(CAPS.segments) }).strict();
const emptyDocument = (clearedAt = 0) => ({ schemaVersion: 1, clearedAt, segments: [] });
const markerSchema = z.object({ clearedAt: stamp }).strict();
const encode = document => JSON.stringify(documentSchema.parse(document)) + '\n';
/** One version of the file: a rename or a rewrite changes at least one of these. */
const stampOf = stat => ({ ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs });
const sameStamp = (a, b) => a === b || Boolean(a && b && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs);

/** A record that can be compared: present, available and carrying data. */
const live = (raw, domain) => raw?.[domain]?.available === true && raw[domain].data ? raw[domain] : null;

/**
 * The events between two persisted context documents. Pure: only domains available on both
 * sides are compared, except that a quest batch replacing no record at all reports its quests
 * as tracked. A disabled or unavailable domain therefore never reads as "everything ended".
 */
export function observe(previous, raw, now) {
  const events = [];
  const add = (record, domain, kind, fields = {}) => events.push({ at: now, domain, revision: record.revision, kind, ...fields });
  const known = value => value !== null && value !== undefined;

  const [player0, player1] = [live(previous, 'player'), live(raw, 'player')];
  if (player0 && player1) {
    const before = player0.data, after = player1.data;
    if (known(before.level) && known(after.level) && after.level > before.level) add(player1, 'player', 'level-up', { from: before.level, to: after.level });
    // A location field the client could not read on one side says nothing about movement.
    const { mapId, zone, subzone } = after.location;
    const moved = ['mapId', 'zone', 'subzone'].some(field =>
      known(before.location[field]) && known(after.location[field]) && before.location[field] !== after.location[field]);
    if (moved) add(player1, 'player', 'zone-change', { mapId, zone, subzone });
  }

  const [quests0, quests1] = [live(previous, 'quests'), live(raw, 'quests')];
  if (quests1 && (quests0 || !previous?.quests)) {
    const old = new Map((quests0?.data.quests ?? []).map(row => [row.id, row]));
    const current = new Set(quests1.data.quests.map(row => row.id));
    // A truncated snapshot lists only some tracked quests, so which ones it lists is no membership change.
    const partial = Boolean(quests0?.data.truncated) || Boolean(quests1.data.truncated);
    for (const row of quests1.data.quests) {
      const fields = { questId: row.id, title: row.title }, was = old.get(row.id);
      if (!was) { if (!partial) add(quests1, 'quests', 'quest-tracked', fields); continue; }
      if (!was.complete && row.complete) add(quests1, 'quests', 'quest-completed', fields);
      // Objectives keep their order within a quest; their text may carry the count itself.
      row.objectives.forEach((objective, index) => {
        const prior = was.objectives[index];
        if (prior && known(prior.fulfilled) && known(objective.fulfilled) && objective.fulfilled > prior.fulfilled) {
          add(quests1, 'quests', 'objective-progress', { ...fields, objective: objective.text, have: objective.fulfilled, need: objective.required });
        }
      });
    }
    for (const row of quests0?.data.quests ?? []) {
      if (!partial && !current.has(row.id)) add(quests1, 'quests', 'quest-untracked', { questId: row.id, title: row.title });
    }
  }

  const [progress0, progress1] = [live(previous, 'progress'), live(raw, 'progress')];
  if (progress0 && progress1) {
    const before = progress0.data, after = progress1.data, was = before.situation, is = after.situation;
    if (known(before.money) && known(after.money) && before.money !== after.money) {
      add(progress1, 'progress', 'money-change', { delta: after.money - before.money, money: after.money });
    }
    if (was.inInstance === false && is.inInstance === true) {
      add(progress1, 'progress', 'instance-enter', { instanceName: is.instanceName, instanceType: is.instanceType, difficulty: is.difficulty });
    }
    if (was.inInstance === true && is.inInstance === false) add(progress1, 'progress', 'instance-leave');
    if (was.dead === false && is.dead === true) add(progress1, 'progress', 'died');
    if (was.ghost === false && is.ghost === true) add(progress1, 'progress', 'ghost');
    if (was.dead === true && is.dead === false) add(progress1, 'progress', 'revived');
    if (known(was.groupSize) && known(is.groupSize) && was.groupSize !== is.groupSize) {
      add(progress1, 'progress', 'group-size', { from: was.groupSize, to: is.groupSize });
    }
  }
  return events;
}

/**
 * What wow_get_session_log returns: segment summaries and the newest `limit` matching events,
 * oldest first, with ISO times, ages and segment origin (epoch, uiNonce, character) on every read.
 * By default (`includeHistory = false`), only the current session/character segment is included;
 * pass `includeHistory: true` to read across retained historical segments.
 */
export function presentJournal(document, { since, limit = 100, kinds, includeHistory = false, character, session, sharing } = {}, now = Date.now()) {
  const paused = sharing === false || sharing === 'disabled';
  const pauseNote = paused
    ? 'WoW context sharing is paused: no new events are recorded while paused, but retained local journal history remains readable until cleared with witchcraft journal --clear or /witch context clear-journal.'
    : undefined;
  if (!document) {
    return { status: 'missing', ...(paused ? { sharing: 'paused', note: pauseNote } : {}), segments: [], events: [] };
  }
  const iso = at => new Date(at).toISOString();
  const activeSegment = session?.epoch
    ? [...document.segments].reverse().find(seg => seg.epoch === session.epoch && (!session.uiNonce || seg.uiNonce === session.uiNonce))
    : document.segments.at(-1);
  const selectedSegments = document.segments.filter(seg => {
    if (character && (seg.character?.name ?? '').toLowerCase() !== character.toLowerCase()) return false;
    if (includeHistory) return true;
    return activeSegment !== undefined && seg === activeSegment;
  });
  const all = selectedSegments.flatMap(segment => segment.events.map(event => ({
    ...event,
    epoch: segment.epoch,
    uiNonce: segment.uiNonce,
    character: segment.character,
  })));
  const matching = all.filter(event => (since === undefined || event.at >= since) && (!kinds || kinds.includes(event.kind)));
  const hasAnyEvents = document.segments.some(segment => segment.events.length > 0);
  return {
    status: hasAnyEvents ? 'ready' : 'empty',
    scope: includeHistory ? 'all' : 'current',
    ...(paused ? { sharing: 'paused', note: pauseNote } : {}),
    segments: document.segments.map(({ epoch, uiNonce, startedAt, endedAt, character: segCharacter, events }) =>
      ({ epoch, uiNonce, startedAt: iso(startedAt), endedAt: endedAt === null ? null : iso(endedAt), character: segCharacter, eventCount: events.length })),
    events: matching.slice(-limit).map(event => ({ ...event, at: iso(event.at), ageSeconds: Math.max(0, Math.round((now - event.at) / 1000)) })),
  };
}

export class JournalStore {
  static caps = CAPS;
  #lockPath;

  // write and onLoaded are test seams: the file writer, which may ignore the { proceed } fence the
  // store passes it, and a hook an append awaits right after each read of the file. A clear waits
  // for another clear's lock at most lockTries times, lockWaitMs apart.
  constructor({ file, now = Date.now, onError = () => {}, write = null, onLoaded = async () => {}, lockTries = 60, lockWaitMs = 50 } = {}) {
    if (typeof file !== 'string' || !file) throw new TypeError('A journal file path is required');
    this.file = file;
    this.now = now;
    this.onError = onError;
    this.write = write ?? ((file, text, options = {}) => atomicWrite(file, text, options));
    this.onLoaded = onLoaded;
    this.marker = markerOf(file);
    this.#lockPath = `${this.marker}.lock`;
    this.lockTries = lockTries;
    this.lockWaitMs = lockWaitMs;
    this.reported = false;
    this.markerReported = false;
    this.closed = false;
    this.clearGeneration = 0;
    this.chain = Promise.resolve();
  }

  /**
   * The stored journal, or null when there is none. An invalid or oversized file reads as empty,
   * and so does one older than the newest clear: a stale file may still sit there for a moment.
   * Any file reads as empty while the clear marker cannot be read.
   */
  async read() {
    // The marker is read after the file, so a clear that lands in between still fences what was read.
    const { document } = await this.#load();
    const fence = await this.#readMarker();
    // A marker that cannot be read fails closed: no stored history while the newest clear is unknown.
    if (fence === null) return document ? emptyDocument(0) : null;
    return document && document.clearedAt < fence ? emptyDocument(fence) : document;
  }

  /** The stored journal and the stamp of the file it came from, both null when there is none. */
  async #load() {
    let handle, stamp = null;
    try {
      handle = await fs.open(this.file, 'r');
      const stat = await handle.stat();
      stamp = stampOf(stat);
      if (!stat.isFile() || stat.size > CAPS.bytes) throw new Error('journal file is too large');
      const buffer = await handle.readFile();
      if (buffer.length > CAPS.bytes) throw new Error('journal file is too large');
      const parsed = documentSchema.safeParse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)));
      if (!parsed.success) throw new Error('journal file is not a valid journal');
      return { document: parsed.data, stamp };
    } catch (error) {
      if (error.code === 'ENOENT') return { document: null, stamp: null };
      if (!this.reported) { this.reported = true; this.onError(new Error(`Session journal unreadable: ${error.message}`)); }
      return { document: emptyDocument(), stamp };
    } finally { await handle?.close(); }
  }

  /** The file's stamp now: null when it is missing, undefined (never a match) when it cannot be read. */
  async #stamp() {
    try { return stampOf(await fs.stat(this.file)); } catch (error) { return error.code === 'ENOENT' ? null : undefined; }
  }

  /** The newest clear on record: 0 when there is none, null when the marker cannot be read or parsed (reported once). */
  async #readMarker() {
    try {
      const parsed = markerSchema.safeParse(JSON.parse(await fs.readFile(this.marker, 'utf8')));
      if (!parsed.success) throw new Error('clear marker is not valid');
      return parsed.data.clearedAt;
    } catch (error) {
      if (error.code === 'ENOENT') return 0;
      if (!this.markerReported) { this.markerReported = true; this.onError(new Error(`Session journal clear marker unreadable: ${error.message}`)); }
      return null;
    }
  }

  /**
   * Add one batch of events and write the file once. Batches queue behind each other, and a
   * failure is reported through onError rather than thrown at the caller. A batch from another
   * daemon epoch or UI session (a reload, or another character) closes the open segment. After
   * close() it returns false and queues nothing.
   */
  append(events, { epoch = null, uiNonce = null, character = null } = {}) {
    if (this.closed) return Promise.resolve(false);
    const generation = this.clearGeneration;
    const startFencePromise = this.#readMarker();
    const run = this.chain.then(async () => {
      const startFence = await startFencePromise;
      return this.#write(events, epoch, uiNonce, character, generation, startFence);
    });
    this.chain = run;
    return run;
  }

  /**
   * Clear the journal: record a marker newer than any clear before it, then delete the file. True
   * when there was a journal to delete; the marker is written either way. Each clear advances the
   * store's clearGeneration so older queued or in-flight append batches are discarded instead of
   * re-applying pre-clear events. Lock ownership is verified before replacing the marker and again
   * before deleting the journal file.
   */
  clear() {
    this.clearGeneration += 1;
    const run = this.chain.then(() => this.#withClearLock(async ownsLock => {
      if (this.closed) return false;
      if (!(await ownsLock())) {
        this.onError(new Error('Session journal clear lock lost'));
        return false;
      }
      const previous = await this.#readMarker();
      // An unreadable marker (already reported) is not overwritten, and the journal it fences stays.
      if (previous === null || this.closed) return false;
      const beforeStamp = await this.#stamp();
      const value = Math.max(this.now(), previous + 1);
      const written = await this.write(this.marker, `${JSON.stringify({ clearedAt: value })}\n`, { proceed: ownsLock });
      if (written === false) {
        if (!this.closed) this.onError(new Error('Session journal clear lock lost'));
        return false;
      }
      if (this.closed) return false;
      if (!(await ownsLock())) {
        this.onError(new Error('Session journal clear lock lost'));
        return false;
      }
      if (beforeStamp === null || !sameStamp(beforeStamp, await this.#stamp())) return false;
      const removed = await fs.unlink(this.file).then(() => true, error => {
        if (error.code === 'ENOENT') return false;
        throw error;
      });
      return removed;
    }));
    this.chain = run.catch(() => {});
    return run;
  }

  /**
   * Run fn holding the clear lock, so clears in every process take turns. A busy lock is tried again
   * lockWaitMs later, lockTries tries in all; one older than LOCK_STALE_MS by the wall clock (its
   * mtime is the file system's, not this.now()) is removed and retried at once. Still busy after
   * the last try: reported, and false without running fn. A clear closed while it waits returns false silently.
   */
  async #withClearLock(fn) {
    const lock = this.#lockPath, token = randomUUID();
    const tokenOf = async file => {
      try { return JSON.parse(await fs.readFile(file, 'utf8')).token ?? null; } catch { return null; }
    };
    const ageOf = file => fs.stat(file).then(stat => Date.now() - stat.mtimeMs, error => (error.code === 'ENOENT' ? null : 0));
    for (let attempt = 1; attempt <= this.lockTries && !this.closed; attempt++) {
      const taken = await fs.writeFile(lock, JSON.stringify({ pid: process.pid, at: this.now(), token }), { flag: 'wx' })
        .then(() => true, error => { if (error.code === 'EEXIST' || isTransientWriteError(error)) return false; throw error; });
      if (taken) {
        const takenAt = Date.now();
        const ownsLock = async () => !this.closed
          && Date.now() - takenAt <= LOCK_STALE_MS
          && (await tokenOf(lock)) === token;
        // Release only what is still ours: a lock reclaimed as stale and taken again is its new holder's.
        try { return await fn(ownsLock); } finally { if (await tokenOf(lock) === token) await fs.rm(lock, { force: true }); }
      }
      // A lock gone since the attempt is retried at once; one that cannot be read counts as held.
      const age = await ageOf(lock);
      if (age === null) continue;
      if (age > LOCK_STALE_MS) {
        // Reclaim by ownership rather than by deleting the path: move the lock aside under a name only
        // this reclaimer knows (a rename is atomic, so of two reclaimers one loses it), then judge the
        // moved file itself by its own age. A fresh lock a new holder created between the stat and the
        // rename is young and goes back where it was instead of being deleted.
        const aside = `${lock}.stale-${token}`;
        const moved = await fs.rename(lock, aside).then(() => true, error => {
          if (error.code === 'ENOENT' || isTransientWriteError(error)) return false;
          throw error;
        });
        if (moved) {
          const movedAge = await ageOf(aside);
          if (movedAge === null || movedAge > LOCK_STALE_MS) await fs.rm(aside, { force: true });
          else await fs.rename(aside, lock).catch(() => fs.rm(aside, { force: true }));
        }
      } else if (attempt < this.lockTries) await new Promise(resolve => setTimeout(resolve, this.lockWaitMs));
    }
    if (this.closed) return false;
    this.onError(new Error('Session journal clear lock busy'));
    return false;
  }

  /**
   * Stop taking writes and wait for the queue to settle, at most timeoutMs: true when it settled.
   * From now on a batch or clear that has not reached its write is dropped without a report and
   * a new append is refused, so a write still pending past the bound cannot start another, and a
   * write already under way checks the fence again just before its rename.
   */
  async close({ timeoutMs = 2000 } = {}) {
    this.closed = true;
    let timer;
    // Unref'd: the bound never keeps the process alive on its own.
    const bound = new Promise(resolve => { timer = setTimeout(resolve, timeoutMs, false); timer.unref?.(); });
    try { return await Promise.race([this.chain.then(() => true, () => true), bound]); }
    finally { clearTimeout(timer); }
  }

  async #write(events, epoch, uiNonce, character, generation, startFence) {
    if (!events?.length) return false;
    if (startFence === null) return false;
    try {
      // Read every time, so a clear from another process is never undone by a stale copy. The file
      // is stamped when read and again just before the write; when it changed in between due to
      // another append in the same clear generation, this document is discarded and the file read
      // again, at most three times. If a clear landed after this batch was queued (clearGeneration
      // changed or the marker moved past startFence), the older batch is discarded.
      for (let attempt = 0; attempt <= 3; attempt++) {
        if (this.closed || generation !== this.clearGeneration) return false;
        const now = this.now();
        const fence = await this.#readMarker();
        if (fence === null || fence > startFence || generation !== this.clearGeneration) return false;
        const { document: stored, stamp } = await this.#load();
        await this.onLoaded();
        if (this.closed || generation !== this.clearGeneration) return false;
        const afterLoadFence = await this.#readMarker();
        if (afterLoadFence === null || afterLoadFence > fence) return false;
        const document = stored && stored.clearedAt >= fence ? stored : emptyDocument(fence);
        let open = document.segments.at(-1);
        if (open && open.endedAt === null && (open.epoch !== epoch || open.uiNonce !== uiNonce || now - open.startedAt > CAPS.segmentMs)) {
          open.endedAt = now;
        }
        if (!open || open.endedAt !== null) {
          open = { epoch, uiNonce, startedAt: now, endedAt: null, character, events: [] };
          document.segments.push(open);
        } else if (!open.character && character) open.character = character;
        open.events.push(...events);
        if (open.events.length > CAPS.events) open.events.splice(0, open.events.length - CAPS.events);
        if (document.segments.length > CAPS.segments) document.segments.splice(0, document.segments.length - CAPS.segments);
        let encoded = encode(document);
        while (Buffer.byteLength(encoded) > CAPS.bytes) {
          if (document.segments.length > 1) document.segments.shift();
          else open.events.splice(0, Math.max(1, Math.ceil(open.events.length / 10)));
          encoded = encode(document);
        }
        if (!sameStamp(stamp, await this.#stamp())) continue;
        if (this.closed || generation !== this.clearGeneration) return false;
        const proceed = async () => !this.closed && generation === this.clearGeneration && (await this.#readMarker()) === fence;
        if (await this.write(this.file, encoded, { proceed }) === false) return false;
        const after = await this.#readMarker();
        if (after === null || after > fence || generation !== this.clearGeneration) return false;
        return true;
      }
      this.onError(new Error('Session journal kept changing under an append; its batch was dropped'));
      return false;
    } catch (error) {
      this.onError(error);
      return false;
    }
  }
}
