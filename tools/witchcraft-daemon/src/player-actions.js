import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { pidAlive } from './bridge-lock.js';
import { HEARTBEAT_TTL_MS, readContextFile } from './context-cache.js';
import { atomicWrite } from './ring.js';

const sessionPart = /^(?!00000000)[0-9a-f]{8}$/u;
const proposalId = z.string().regex(/^[0-9a-f]{32}$/u);
const hidden = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ud800-\udfff]/u;
const text = (bytes, multiline = false) => z.string().min(1).max(bytes).refine(value =>
  Boolean(value.trim()) && Buffer.byteLength(value, 'utf8') <= bytes && !hidden.test(value) && (multiline || !value.includes('\n')),
{ message: `Expected visible text within ${bytes} UTF-8 bytes` });
const percent = z.number().min(0).max(100);
const point = z.object({ mapID: z.number().int().min(1).max(2_147_483_647), x: percent, y: percent, label: text(64) }).strict();
const schemas = {
  macro: z.object({ name: text(16), body: text(255, true) }).strict(),
  route: z.object({ name: text(64), points: z.array(point).min(1).max(12) }).strict(),
};
const records = Object.fromEntries(Object.entries(schemas).map(([kind, schema]) => [kind, schema.extend({ id: proposalId })]));
const kinds = Object.keys(schemas);
const activeSession = session => sessionPart.test(session?.epoch ?? '') && sessionPart.test(session?.uiNonce ?? '');
const sameSession = (a, b) => Boolean(a && b && a.epoch === b.epoch && a.uiNonce === b.uiNonce);

// Session-specific final names keep a delayed write from the previous UI from overwriting a
// newer proposal. The cache basename distinguishes independently configured caches in one folder.
function proposalPath(cachePath, session, kind) {
  return `${cachePath}.player-action.${session.epoch}.${session.uiNonce}.${kind}.json`;
}

async function readRecord(file) {
  let handle;
  try {
    const entry = await fs.lstat(file);
    if (!entry.isFile() || entry.size > 8192) return null;
    handle = await fs.open(file, 'r');
    const data = Buffer.alloc(8193);
    let size = 0;
    while (size < data.length) {
      const { bytesRead } = await handle.read(data, size, data.length - size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    return size < data.length ? JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, size))) : null;
  } catch { return null; }
  finally { await handle?.close(); }
}

async function liveSession(cachePath, now) {
  const at = now();
  const [context, lock] = await Promise.all([readContextFile(cachePath, { now: at }),
    readRecord(path.join(path.dirname(cachePath), 'bridge.lock'))]);
  const confirmed = context.playerActionSeenAt;
  return confirmed != null && confirmed <= at && at - confirmed <= HEARTBEAT_TTL_MS &&
    context.connection.status === 'connected' && activeSession(context.session) && lock?.epoch === context.session.epoch
    && Number.isSafeInteger(lock.pid) && lock.pid > 0 && pidAlive(lock.pid) ? context.session : null;
}

export async function suggestPlayerAction(cachePath, kind, args, now = Date.now) {
  const proposal = { ...schemas[kind].parse(args), id: randomBytes(16).toString('hex') };
  const session = await liveSession(cachePath, now);
  if (!session) throw new Error('Connect the Witchcraft daemon to the game before suggesting a player action.');
  const wrote = await atomicWrite(proposalPath(cachePath, session, kind), JSON.stringify({ ...session, proposal }), {
    proceed: async () => sameSession(session, await liveSession(cachePath, now)),
  });
  if (!wrote) throw new Error('The game session changed while saving the suggestion. Ask the player before sending it again.');
  return { status: 'queued', id: proposal.id, kind, note: 'The player can review this suggestion in game.' };
}

export function registerPlayerActionTools(server, { cachePath, now }) {
  const descriptions = {
    macro: 'Suggest a named macro for the player to preview and optionally create. The full body is shown before creation. Submitting a suggestion never executes it. Replaces the previous macro suggestion for this UI session.',
    route: 'Suggest a named route for the player to review and optionally display on the world map. Provide 1–12 ordered points with a WoW mapID, x/y percentages (0–100), and a short label. Replaces the previous route suggestion for this UI session.',
  };
  for (const kind of kinds) {
    server.registerTool(`wow_suggest_${kind}`, { title: `Suggest a ${kind}`, description: descriptions[kind], inputSchema: schemas[kind],
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } }, async args => {
      try {
        const result = await suggestPlayerAction(cachePath, kind, args, now);
        return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: error.code ? 'Could not save the suggestion locally.' : error.message }] };
      }
    });
  }
}

// Called while holding the bridge lock, before the first session and after shutdown. Only the
// two known record names are owned. Other files in the shared state directory belong to users.
export async function clearPlayerActionFiles(cachePath) {
  const directory = path.dirname(cachePath), prefix = path.basename(cachePath) + '.player-action.';
  const files = await fs.readdir(directory);
  for (const name of files) {
    if (name.startsWith(prefix) && /^[a-f0-9]{8}\.[a-f0-9]{8}\.(macro|route)\.json$/u.test(name.slice(prefix.length))) {
      await fs.unlink(path.join(directory, name)).catch(() => {});
    }
  }
}

export class PlayerActionInbox {
  constructor(cachePath) { this.cachePath = cachePath; }

  // Even during a burst of carrier callbacks we open at most two small files per second.
  async read(session, now = performance.now()) {
    if (!activeSession(session)) return undefined;
    if (sameSession(session, this.session) && now < this.nextRead) return this.actions;
    if (this.session && !sameSession(session, this.session)) {
      await Promise.all(kinds.map(kind => fs.unlink(proposalPath(this.cachePath, this.session, kind)).catch(() => {})));
    }
    this.session = session;
    this.nextRead = now + 1000;
    const entries = await Promise.all(kinds.map(async kind => {
      const record = await readRecord(proposalPath(this.cachePath, session, kind));
      if (!sameSession(record, session)) return null;
      const parsed = records[kind].safeParse(record.proposal);
      return parsed.success ? [kind, parsed.data] : null;
    }));
    const valid = entries.filter(Boolean);
    this.actions = valid.length ? Object.fromEntries(valid) : undefined;
    return this.actions;
  }
}
