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
const macroInput = z.object({ name: text(16), body: text(255, true) }).strict();
const macroRecord = macroInput.extend({ id: proposalId });
const activeSession = session => sessionPart.test(session?.epoch ?? '') && sessionPart.test(session?.uiNonce ?? '');
const sameSession = (a, b) => Boolean(a && b && a.epoch === b.epoch && a.uiNonce === b.uiNonce);

// Session-specific final names keep a delayed write from the previous UI from overwriting a
// newer proposal. The cache basename distinguishes independently configured caches in one folder.
function proposalPath(cachePath, session) {
  return `${cachePath}.macro-proposal.${session.epoch}.${session.uiNonce}.json`;
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
  const confirmed = context.confirmedCursorAt;
  return confirmed != null && confirmed <= at && at - confirmed <= HEARTBEAT_TTL_MS &&
    context.connection.status === 'connected' && activeSession(context.session) && lock?.epoch === context.session.epoch
    && Number.isSafeInteger(lock.pid) && lock.pid > 0 && pidAlive(lock.pid) ? context.session : null;
}

async function suggestMacro(cachePath, args, now = Date.now) {
  const proposal = { ...macroInput.parse(args), id: randomBytes(16).toString('hex') };
  const session = await liveSession(cachePath, now);
  if (!session) throw new Error('Connect the Witchcraft daemon to the game before suggesting a macro.');
  const wrote = await atomicWrite(proposalPath(cachePath, session), JSON.stringify({ ...session, proposal }), {
    proceed: async () => sameSession(session, await liveSession(cachePath, now)),
  });
  if (!wrote) throw new Error('The game session changed while saving the suggestion. Ask the player before sending it again.');
  return { status: 'queued', id: proposal.id, note: 'The player can review this macro in game.' };
}

export function registerMacroTool(server, { cachePath, now }) {
  server.registerTool('wow_suggest_macro', { title: 'Suggest a macro',
    description: 'Suggest a named macro for the player to preview and optionally create. The full body is shown before creation. Submitting a suggestion never executes it. Replaces the previous macro suggestion for this UI session.',
    inputSchema: macroInput, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } }, async args => {
    try {
      const result = await suggestMacro(cachePath, args, now);
      return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error.code ? 'Could not save the macro suggestion locally.' : error.message }] };
    }
  });
}

// The daemon holds the bridge lock while clearing past sessions' macro files.
export async function clearMacroProposals(cachePath) {
  const directory = path.dirname(cachePath), prefix = path.basename(cachePath) + '.macro-proposal.';
  const files = await fs.readdir(directory);
  for (const name of files) {
    if (name.startsWith(prefix) && /^[a-f0-9]{8}\.[a-f0-9]{8}\.json$/u.test(name.slice(prefix.length))) {
      await fs.unlink(path.join(directory, name)).catch(() => {});
    }
  }
}

export class MacroInbox {
  constructor(cachePath) { this.cachePath = cachePath; }

  // Carrier callbacks may arrive in bursts. Read the session's latest proposal at most once per second.
  async read(session, now = performance.now()) {
    if (!activeSession(session)) return undefined;
    if (sameSession(session, this.session) && now < this.nextRead) return this.proposal;
    if (this.session && !sameSession(session, this.session)) {
      await fs.unlink(proposalPath(this.cachePath, this.session)).catch(() => {});
    }
    this.session = session;
    this.nextRead = now + 1000;
    const record = await readRecord(proposalPath(this.cachePath, session));
    const parsed = sameSession(record, session) && macroRecord.safeParse(record.proposal);
    this.proposal = parsed?.success ? parsed.data : undefined;
    return this.proposal;
  }
}
