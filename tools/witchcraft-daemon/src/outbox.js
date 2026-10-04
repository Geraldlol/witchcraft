import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { isUtf8 } from 'node:buffer';
import luaparse from 'luaparse';

const ACTIONS = Object.freeze({ enter: '\r', interrupt: '\x03', escape: '\x1b', up: '\x1b[A', down: '\x1b[B' });
// A multi-line prompt crosses every carrier as ordinary text messages: newlines travel as LINE
// SEPARATOR, and each part but the last starts with INVISIBLE SEPARATOR. The outbox joins the
// parts and delivers them as one bracketed paste, then Enter, so the CLI takes one input.
export const MORE = '\u2063', LINE = '\u2028', PASTE_LIMIT = 8192;
// A text message that starts with INVISIBLE TIMES is a request from the addon, never typed:
// `cols=N` asks for terminals as wide as the in-game pane (40-240 columns).
export const CONTROL = '\u2062';
const PASTE_START = '\x1b[200~', PASTE_END = '\x1b[201~';
export function validMessage(message) {
  return message && typeof message === 'object' && /^[0-9a-f]{8}$/u.test(message.epoch) && message.epoch !== '00000000'
    && Number.isInteger(message.id) && message.id > 0 && message.id <= 262143
    && ['claude', 'codex'].includes(message.tab) && ['text', ...Object.keys(ACTIONS)].includes(message.action)
    && typeof message.text === 'string' && message.text.isWellFormed() && Buffer.byteLength(message.text) <= 600
    && !/[\x00-\x1f\x7f-\x9f]/u.test(message.text) && (message.action === 'text' ? message.text.length > 0 : message.text === '');
}
// Parse one literal SavedVariables assignment. Nothing from the file is executed.
export function parseSavedVariables(source) {
  const bytes = Buffer.isBuffer(source) ? source : Buffer.from(source, 'utf8');
  if (bytes.length > 2 * 1024 * 1024) throw new Error('SavedVariables exceeds the parser byte budget');
  let nodes = 0;
  const ast = luaparse.parse(bytes.toString('latin1').replace(/^\xef\xbb\xbf/u, ''), {
    luaVersion: '5.1', encodingMode: 'pseudo-latin1', comments: false,
    onCreateNode() { if (++nodes > 20000) throw new Error('SavedVariables exceeds the parser node budget'); },
  });
  if (ast.body.length !== 1) throw new Error('Expected only WitchcraftDB assignment');
  const assignment = ast.body[0];
  if (assignment.type !== 'AssignmentStatement' || assignment.variables.length !== 1 || assignment.init.length !== 1
    || assignment.variables[0].type !== 'Identifier' || assignment.variables[0].name !== 'WitchcraftDB') {
    throw new Error('Expected WitchcraftDB literal assignment');
  }
  function literal(node, depth = 0) {
    if (depth > 16) throw new Error('SavedVariables exceeds the nesting budget');
    if (node.type === 'StringLiteral') {
      const value = Buffer.from(node.value, 'latin1');
      if (!isUtf8(value)) throw new Error('SavedVariables contains invalid UTF-8');
      return value.toString('utf8');
    }
    if (node.type === 'NumericLiteral' && Number.isFinite(node.value)) return node.value;
    if (node.type === 'BooleanLiteral') return node.value;
    if (node.type === 'NilLiteral') return null;
    if (node.type === 'UnaryExpression' && node.operator === '-' && node.argument.type === 'NumericLiteral') return -node.argument.value;
    if (node.type !== 'TableConstructorExpression') throw new Error('SavedVariables must contain literal data only');
    const value = Object.create(null);
    let arrayIndex = 1;
    for (const field of node.fields) {
      let key;
      if (field.type === 'TableValue') key = arrayIndex++;
      else if (field.type === 'TableKeyString') key = field.key.name;
      else if (field.type === 'TableKey') key = literal(field.key, depth + 1);
      else throw new Error('Unsupported table field');
      if (!(typeof key === 'string' || (Number.isSafeInteger(key) && key > 0))
        || ['__proto__', 'prototype', 'constructor'].includes(key) || Object.hasOwn(value, key)) throw new Error('Invalid or duplicate table key');
      value[key] = literal(field.value, depth + 1);
    }
    return value;
  }
  const root = literal(assignment.init[0]);
  if (!root || typeof root !== 'object' || Array.isArray(root)) throw new Error('WitchcraftDB must be a table');
  const global = root.global ?? {};
  if (!global || typeof global !== 'object' || (global.schema !== undefined && global.schema !== 1)) throw new Error('Unsupported Witchcraft schema');
  const outbox = global.outbox ?? {};
  if (!outbox || typeof outbox !== 'object') throw new Error('Invalid Witchcraft outbox');
  const entries = Object.entries(outbox);
  if (entries.length > 64 || entries.some(([key]) => !/^[1-9]\d*$/u.test(key) || Number(key) > entries.length)) {
    throw new Error('Outbox must be a dense array of at most 64 messages');
  }
  const messages = entries.sort((a, b) => Number(a[0]) - Number(b[0])).map(([, value]) => value);
  let previous = 0;
  for (const message of messages) {
    if (!validMessage(message) || message.id <= previous) throw new Error('Invalid outbox message or ordering');
    previous = message.id;
  }
  return { messages, epoch: global.epoch, ack: global.ack ?? 0 };
}

export class Outbox {
  constructor({ epoch, write, onControl = () => {} }) {
    this.epoch = epoch; this.write = write; this.onControl = onControl; this.ack = 0; this.busy = false; this.parts = {};
  }
  accept(message) {
    if (!validMessage(message) || message.epoch !== this.epoch) return { accepted: false, reason: 'invalid or stale session' };
    if (message.id <= this.ack) return { accepted: true, duplicate: true, ack: this.ack };
    if (this.busy) return { accepted: false, reason: 'delivery in progress' };
    this.busy = true;
    try {
      // write is synchronous node-pty input, explicitly addressed to one terminal.
      // The action travels beside the bytes: a PTY wants the bytes, while a mirrored console
      // wants the name, and recovering one from the other means parsing escapes back into keys.
      if (message.action === 'text' && message.text.startsWith(CONTROL)) {
        const cols = /^cols=(\d{2,3})$/u.exec(message.text.slice(CONTROL.length));
        const width = cols ? Number(cols[1]) : 0;
        this.ack = message.id;
        if (width < 40 || width > 240) return { accepted: true, dropped: true, reason: 'invalid control request', ack: this.ack };
        this.onControl({ cols: width });
        return { accepted: true, control: true, ack: this.ack };
      }
      if (message.action === 'text' && message.text.startsWith(MORE)) {
        // A prompt larger than any the addon composes is discarded whole: null holds that
        // verdict until its final part, so the rest of it never starts a fresh prompt.
        const held = this.parts[message.tab];
        const joined = held === null ? null : (held ?? '') + message.text.slice(MORE.length);
        this.parts[message.tab] = joined !== null && joined.length > PASTE_LIMIT ? null : joined;
        this.ack = message.id;
        return { accepted: true, ack: this.ack, buffered: true };
      }
      if (message.action === 'text' && this.parts[message.tab] === null) {
        delete this.parts[message.tab];
        this.ack = message.id;
        return { accepted: true, dropped: true, reason: 'multi-line prompt exceeds the paste limit', ack: this.ack };
      }
      const text = message.action === 'text' ? (this.parts[message.tab] ?? '') + message.text : '';
      if (message.action === 'text') delete this.parts[message.tab];
      if (text.includes(LINE)) {
        // Terminals paste newlines as carriage returns inside the markers.
        this.write(message.tab, PASTE_START + text.replaceAll(LINE, '\r') + PASTE_END + '\r', 'paste');
      } else {
        this.write(message.tab, message.action === 'text' ? text + '\r' : ACTIONS[message.action], message.action);
      }
      this.ack = message.id;
      return { accepted: true, ack: this.ack };
    } catch (error) {
      // A tab that is not running will never take this input; retrying it forever would hold
      // every later message on the in-order lanes, so it is consumed and reported as dropped.
      if (error?.code !== 'TAB_NOT_RUNNING') throw error;
      this.ack = message.id;
      return { accepted: true, dropped: true, reason: error.message, ack: this.ack };
    } finally { this.busy = false; }
  }
  recover(source) {
    const recovery = parseSavedVariables(source);
    return recovery.messages.map(message => this.accept(message));
  }
}

export function watchSavedVariables(filename, { onReset, onRecovery, onError = () => {} }) {
  let stopped = false, generation = 0;
  const listener = async (current, previous) => {
    if (current.mtimeMs === previous.mtimeMs && current.size === previous.size) return;
    if (current.mtimeMs === 0) return;
    const mine = ++generation;
    try {
      const source = await fsp.readFile(filename);
      const parsed = parseSavedVariables(source);
      if (stopped || generation !== mine) return;
      await onReset(parsed);
      if (!stopped && generation === mine) await onRecovery(parsed);
    } catch (error) { if (!stopped && generation === mine) onError(error); }
  };
  fs.watchFile(filename, { interval: 500, persistent: false }, listener);
  return () => { stopped = true; generation++; fs.unwatchFile(filename, listener); };
}
