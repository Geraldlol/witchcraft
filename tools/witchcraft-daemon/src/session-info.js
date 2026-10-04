import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findCodexThread } from './current-sessions.js';

// What an agent's own session files say about it: the model, how much context the conversation
// uses, and its last reply as plain lines. The screen shows none of these reliably, so they are
// read from the tail of the Claude Code transcript or the Codex rollout every few seconds.

const TAIL_BYTES = 1 << 20, REPLY_LINES = 200, REPLY_LINE_CHARS = 400, MODEL_BYTES = 64, EFFORT_BYTES = 16;

// At most maxBytes of well-formed UTF-8, cut on a code point: Ring.lua bounds model and effort in
// bytes, and the Lua serializer refuses half a surrogate pair.
function boundBytes(text, maxBytes) {
  let out = '', used = 0;
  for (const char of text.toWellFormed()) {
    used += Buffer.byteLength(char, 'utf8');
    if (used > maxBytes) break;
    out += char;
  }
  return out;
}

async function tailLines(file, bytes = TAIL_BYTES) {
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - bytes), length = size - start;
    const { buffer } = await handle.read(Buffer.alloc(length), 0, length, start);
    const lines = buffer.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    return lines;
  } finally { await handle.close(); }
}

const parse = line => { try { return JSON.parse(line); } catch { return undefined; } };
const count = value => Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;

/**
 * A reply's text as bounded display lines: no control characters, long lines cut, newest last.
 * Lines are cut by code point and made well-formed, since the Lua serializer refuses half a
 * surrogate pair; 400 code points also stay within the addon's 1600-byte reply line.
 */
export function replyLines(text) {
  if (typeof text !== 'string' || !text.trim()) return undefined;
  const lines = text.replace(/\r\n?/gu, '\n').split('\n')
    .map(line => Array.from(line.replace(/\t/gu, '    ').replace(/[\u0000-\u001f\u007f-\u009f]/gu, '').toWellFormed())
      .slice(0, REPLY_LINE_CHARS).join(''));
  return lines.length > REPLY_LINES ? [...lines.slice(0, REPLY_LINES - 1), '...'] : lines;
}

/** Claude Code: the last assistant message's model and context, and its last text reply. */
export async function readClaudeInfo(file) {
  const lines = await tailLines(file);
  let info, reply;
  for (let index = lines.length - 1; index >= 0 && !(info && reply); index--) {
    const entry = parse(lines[index]);
    if (entry?.type !== 'assistant' || typeof entry.message !== 'object') continue;
    const { model, usage, content } = entry.message;
    if (!info && typeof model === 'string' && usage) {
      info = { model: boundBytes(model, MODEL_BYTES),
        used: count(usage.input_tokens) + count(usage.cache_read_input_tokens) + count(usage.cache_creation_input_tokens) };
    }
    if (!reply && Array.isArray(content)) {
      const text = content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n');
      if (text.trim()) reply = replyLines(text);
    }
  }
  return { info, reply };
}

const partsText = (parts, kinds) => Array.isArray(parts)
  ? parts.filter(part => kinds.includes(part?.type) && typeof part.text === 'string').map(part => part.text).join('\n') : undefined;

// What the player reads, for phase 'final_answer' (the reply) or 'commentary' (progress). Legacy
// threads record both as agent_message events; one without a phase predates phases and is a reply.
// 'paginated' threads (the VS Code extension's) record each message as an assistant message item
// and an AgentMessage item (whose parts are typed "Text"), and a turn's reply once more in its
// task_complete summary. A response_item agent_message is traffic between agents in either format.
function codexText(entry, payload, phase) {
  if (entry.type === 'event_msg') {
    if (payload.type === 'agent_message') return (phase === 'commentary') === (payload.phase === 'commentary') ? payload.message : undefined;
    if (payload.type === 'task_complete') return phase === 'final_answer' && typeof payload.last_agent_message === 'string' ? payload.last_agent_message : undefined;
    if (payload.type === 'item_completed' && payload.item?.type === 'AgentMessage' && payload.item.phase === phase) {
      return partsText(payload.item.content, ['Text', 'text']);
    }
  }
  if (entry.type === 'response_item' && payload.type === 'message' && payload.role === 'assistant' && payload.phase === phase) {
    return partsText(payload.content, ['output_text']);
  }
  return undefined;
}

/** Codex: the turn's model and effort, the last token count against the window, the last reply. */
export async function readCodexInfo(file) {
  const lines = await tailLines(file);
  let model, effort, used, window, reply, progress;
  for (let index = lines.length - 1; index >= 0; index--) {
    const entry = parse(lines[index]), payload = entry?.payload;
    if (!payload) continue;
    if (!model && entry.type === 'turn_context' && typeof payload.model === 'string') {
      model = boundBytes(payload.model, MODEL_BYTES);
      if (typeof payload.effort === 'string') effort = boundBytes(payload.effort, EFFORT_BYTES);
    }
    if (used === undefined && payload.type === 'token_count' && payload.info?.last_token_usage) {
      used = count(payload.info.last_token_usage.input_tokens);
      if (Number.isFinite(payload.info.model_context_window)) window = count(payload.info.model_context_window);
    }
    if (!reply) reply = replyLines(codexText(entry, payload, 'final_answer'));
    // A long turn can push every reply out of the tail; then its newest progress is shown instead.
    if (!reply && !progress) progress = replyLines(codexText(entry, payload, 'commentary'));
    if (model && used !== undefined && reply) break;
  }
  reply ??= progress;
  const info = model || used !== undefined ? { ...(model ? { model } : {}), ...(effort ? { effort } : {}),
    ...(used !== undefined ? { used } : {}), ...(window ? { window } : {}) } : undefined;
  return { info, reply };
}

/** The transcript of the Claude Code process `pid`, through its ~/.claude/sessions record. */
export async function claudeTranscript(pid, { home = os.homedir() } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  let record;
  try { record = JSON.parse(await fs.readFile(path.join(home, '.claude', 'sessions', `${pid}.json`), 'utf8')); } catch { return undefined; }
  if (typeof record?.sessionId !== 'string' || !/^[0-9a-f-]{36}$/iu.test(record.sessionId) || typeof record.cwd !== 'string') return undefined;
  // Claude Code names a project's folder after its path with every other character a dash.
  return path.join(home, '.claude', 'projects', record.cwd.replace(/[^A-Za-z0-9]/gu, '-'), `${record.sessionId}.jsonl`);
}

/**
 * Polls both tabs. `pid(tab)` names the Claude process; `codexFile` is the resumed rollout, or the
 * newest thread in `cwd` is looked up each time. Failures leave the last good reading in place.
 */
export function createSessionInfo({ cwd, pid, codexFile, intervalMs = 5000, home = os.homedir(), onChange = () => {} } = {}) {
  const current = { claude: {}, codex: {} };
  let timer, stopped = false, running = false;
  async function poll() {
    if (running || stopped) return;
    running = true;
    try {
      const claudeFile = await claudeTranscript(pid?.('claude'), { home });
      const codex = codexFile ?? (await findCodexThread({ cwd, root: path.join(home, '.codex', 'sessions') }))?.file;
      const next = {
        claude: claudeFile ? await readClaudeInfo(claudeFile).catch(() => current.claude) : {},
        codex: codex ? await readCodexInfo(codex).catch(() => current.codex) : {},
      };
      const changed = JSON.stringify(next) !== JSON.stringify(current);
      Object.assign(current, next);
      if (changed && !stopped) onChange();
    } finally { running = false; }
  }
  return {
    start() { void poll(); timer = setInterval(() => void poll(), intervalMs); timer.unref?.(); return this; },
    stop() { stopped = true; clearInterval(timer); },
    poll,
    /** The fields a published session carries: `info` and `reply`, each only when known. */
    get(tab) {
      const { info, reply } = current[tab] ?? {};
      return { ...(info ? { info } : {}), ...(reply ? { reply } : {}) };
    },
  };
}
