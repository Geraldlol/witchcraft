import { EventEmitter } from 'node:events';
import path from 'node:path';
import { spawn as spawnProcess } from 'node:child_process';
import { BoundedOverlaySender } from './overlay-channel.js';
import {
  MAX_OVERLAY_OUTPUT_BYTES,
  MAX_OVERLAY_PENDING_BYTES,
  MAX_OVERLAY_LINE_BYTES,
  MAX_OVERLAY_LINES,
  MAX_OVERLAY_SERIALIZED_BYTES,
  OVERLAY_PROTOCOL_VERSION,
  OVERLAY_TABS,
  OverlayProtocolError,
  createOverlaySessionId,
  splitOverlayOutput,
  validateChildMessage,
} from './overlay-protocol.js';

const OUTPUT_PENDING_LIMIT = Math.floor(MAX_OVERLAY_PENDING_BYTES / 2);
const MAX_SYNCED_OUTPUT_BYTES = 128 * 1024;

function deferred() {
  let resolve, reject;
  const promise = new Promise((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject, settled: false };
}
function safeStatus(value) { return typeof value === 'string' && value ? value : 'unknown'; }
const MAX_LINES_JSON_BYTES = 48 * 1024;
const MAX_ANSI_JSON_BYTES = 64 * 1024;
const graphemes = typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
function segments(value) {
  return graphemes ? [...graphemes.segment(value)].map(item => item.segment) : [...value];
}
function boundedLines(value) {
  const source = typeof value === 'string' ? value.split(/\r?\n/u) : Array.isArray(value) ? value : [];
  let jsonBytes = 0;
  return source.slice(0, MAX_OVERLAY_LINES).map(line => {
    const text = typeof line === 'string' ? line : '';
    let output = '', rawBytes = 0;
    for (const unit of segments(text)) {
      const rawCost = Buffer.byteLength(unit, 'utf8');
      const jsonCost = Buffer.byteLength(JSON.stringify(unit), 'utf8') - 2;
      if (rawBytes + rawCost > MAX_OVERLAY_LINE_BYTES || jsonBytes + jsonCost > MAX_LINES_JSON_BYTES) break;
      output += unit; rawBytes += rawCost; jsonBytes += jsonCost;
    }
    return output;
  });
}
function boundedAnsi(screen) {
  if (!screen || typeof screen.serialize !== 'function') return undefined;
  const ansi = screen.serialize();
  if (typeof ansi !== 'string' || Buffer.byteLength(ansi, 'utf8') > MAX_OVERLAY_SERIALIZED_BYTES) return undefined;
  return Buffer.byteLength(JSON.stringify(ansi), 'utf8') <= MAX_ANSI_JSON_BYTES ? ansi : undefined;
}

export async function settleTerminalScreens(terminal) {
  const pending = [];
  for (const session of terminal.sessions?.values?.() ?? []) {
    if (session.screen?.pending && typeof session.screen.pending.then === 'function') pending.push(session.screen.pending);
  }
  await Promise.all(pending);
}

/** Return the authoritative, plain-text screen model used for startup and recovery. */
export function snapshotOverlayTerminals(terminal, { activeTab = 'claude', generation = 1 } = {}) {
  const fallback = typeof terminal.snapshot === 'function' ? terminal.snapshot() : [];
  const sessions = OVERLAY_TABS.map(id => {
    const live = terminal.sessions?.get?.(id), previous = fallback.find?.(session => session.id === id);
    const plain = live?.screen && typeof live.screen.plain === 'function'
      ? live.screen.plain() : terminal.plain?.(id);
    const ansi = boundedAnsi(live?.screen);
    return { id, title: live?.title ?? previous?.title ?? (id === 'claude' ? 'Claude' : 'Codex'),
      status: safeStatus(live?.status ?? previous?.status), lines: boundedLines(plain ?? previous?.lines),
      ...(ansi === undefined ? {} : { ansi }) };
  });
  return { authoritative: true, generation, activeTab,
    cols: terminal.cols ?? 120, rows: terminal.rows ?? 40, sessions };
}

/**
 * Parent-side controller. It owns only the overlay child; terminal processes remain
 * owned by the daemon and are never stopped when this controller fails.
 */
export class OverlayHost extends EventEmitter {
  constructor({ child, terminal, sessionId = createOverlaySessionId(), initialTab = 'claude',
    handshakeTimeoutMs = 3000, sendTimeoutMs = 3000, shutdownTimeoutMs = 1500 } = {}) {
    super();
    if (!child || typeof child.on !== 'function' || typeof child.send !== 'function') throw new TypeError('Overlay child process is required');
    if (!terminal || typeof terminal.write !== 'function' || typeof terminal.resize !== 'function') throw new TypeError('Terminal owner is required');
    this.child = child;
    this.terminal = terminal;
    this.sessionId = sessionId;
    this.activeTab = OVERLAY_TABS.includes(initialTab) ? initialTab : 'claude';
    this.handshakeTimeoutMs = handshakeTimeoutMs;
    this.sendTimeoutMs = sendTimeoutMs;
    this.shutdownTimeoutMs = shutdownTimeoutMs;
    this.lifecycle = 'stopped';
    this.authenticated = false;
    this.lastChildSeq = -1;
    this.hostSeq = 0;
    this.generation = 0;
    this.outputOrdinal = 0;
    this.syncQueue = [];
    this.syncQueueBytes = 0;
    this.resyncRequested = false;
    this.syncPromise = null;
    this.deltasReady = false;
    this.ready = deferred();
    this.closed = deferred();
    this.bound = {
      message: message => this._receive(message),
      disconnect: () => {
        const unexpected = this.lifecycle !== 'stopping';
        if (unexpected) this._killOwnedChild();
        this._retire({ reason: 'ipc disconnected', unexpected });
      },
      exit: (code, signal) => this._retire({ reason: `overlay exited (${code ?? signal ?? 'unknown'})`, unexpected: this.lifecycle !== 'stopping', code, signal }),
      error: error => this._fail(error),
    };
  }

  _setLifecycle(value) {
    if (this.lifecycle === value) return;
    this.lifecycle = value;
    this.emit('lifecycle', value);
  }

  start() {
    if (this.sender || this.lifecycle !== 'stopped' || this.closed.settled) throw new Error('Overlay host already started');
    this._setLifecycle('starting');
    this.sender = new BoundedOverlaySender({ channel: this.child, direction: 'host', sendTimeoutMs: this.sendTimeoutMs,
      onFailure: error => this._fail(error) });
    this.sender.on('progress', () => {
      if (this.resyncRequested && this.sender.pendingBytes < OUTPUT_PENDING_LIMIT / 2) this._scheduleResync();
    });
    for (const [event, listener] of Object.entries(this.bound)) this.child.on(event, listener);
    this.handshakeTimer = setTimeout(() => this._fail(new OverlayProtocolError('HANDSHAKE_TIMEOUT', 'Overlay child did not identify itself in time')),
      this.handshakeTimeoutMs);
    this.handshakeTimer.unref?.();
    return this.ready.promise;
  }

  _send(type, payload, { output = false } = {}) {
    if (!this.sender || this.lifecycle === 'stopped') throw new OverlayProtocolError('CHANNEL_CLOSED', 'Overlay host is stopped');
    const envelope = { v: OVERLAY_PROTOCOL_VERSION, type, seq: this.hostSeq + 1, payload };
    const measured = this.sender.measure(envelope);
    if (output && !this.sender.canFit(measured.bytes, { byteLimit: OUTPUT_PENDING_LIMIT })) return false;
    this.sender.send(measured.message, { byteLimit: output ? OUTPUT_PENDING_LIMIT : MAX_OVERLAY_PENDING_BYTES });
    this.hostSeq++;
    return true;
  }

  _receive(raw) {
    try {
      const message = validateChildMessage(raw);
      if (!this.authenticated) {
        if (message.type !== 'hello') throw new OverlayProtocolError('HANDSHAKE_REQUIRED', 'Overlay child must send hello first');
        if (this.child.pid && message.payload.pid !== this.child.pid) throw new OverlayProtocolError('CHILD_MISMATCH', 'Overlay hello PID does not match the owned child');
        this.authenticated = true;
        this.lastChildSeq = 0;
        clearTimeout(this.handshakeTimer);
        this._setLifecycle('syncing');
        this._send('ready', { sessionId: this.sessionId, tabs: [...OVERLAY_TABS], activeTab: this.activeTab, lifecycle: 'syncing' });
        void this._synchronize();
        return;
      }
      if (message.type === 'hello') throw new OverlayProtocolError('DUPLICATE_HANDSHAKE', 'Overlay hello may only be sent once');
      if (message.seq !== this.lastChildSeq + 1) throw new OverlayProtocolError('INVALID_SEQUENCE', 'Overlay child sequence is not contiguous');
      this.lastChildSeq = message.seq;
      this._handle(message);
    } catch (error) { this._fail(error); }
  }

  _handle(message) {
    const { type, payload, seq } = message;
    try {
      if (type === 'input') this.terminal.write(payload.tab, payload.data);
      else if (type === 'clipboard') {
        if (!payload.text.startsWith('FAMCLIP1|')) throw new OverlayProtocolError('INVALID_CLIPBOARD_PREFIX', 'Clipboard payload prefix is not allowed');
        this.emit('clipboard', payload.text);
      }
      else if (type === 'resize') { this.terminal.resize(payload.cols, payload.rows); this.requestResync(); }
      else if (type === 'select') { this.activeTab = payload.tab; this.emit('select', payload.tab); this.requestResync(); }
      else if (type === 'ping') this._send('pong', { nonce: payload.nonce });
      else if (type === 'resync') this.requestResync();
      else if (type === 'disconnect') void this.stop(payload.reason ?? 'overlay requested disconnect');
    } catch (error) {
      this._send('error', { code: 'TERMINAL_COMMAND_FAILED', message: String(error.message ?? error).slice(0, 256), requestSeq: seq });
    }
  }

  async _synchronize() {
    if (this.syncPromise || !this.authenticated || this.lifecycle === 'stopping' || this.lifecycle === 'stopped') return this.syncPromise;
    this.resyncRequested = false;
    this.deltasReady = false;
    this._setLifecycle('syncing');
    this.syncPromise = (async () => {
      const cutoff = this.outputOrdinal;
      await settleTerminalScreens(this.terminal);
      const nextGeneration = this.generation + 1;
      const state = snapshotOverlayTerminals(this.terminal, { activeTab: this.activeTab, generation: nextGeneration });
      this._send('state', state);
      this.generation = nextGeneration;
      const queued = this.syncQueue.filter(item => item.ordinal > cutoff);
      this.syncQueue = [];
      this.syncQueueBytes = 0;
      this.deltasReady = true;
      for (const item of queued) {
        if (!this._publishPart(item.tab, item.data)) { this.resyncRequested = true; break; }
      }
      if (!this.ready.settled) { this.ready.settled = true; this.ready.resolve(this); }
      if (!this.resyncRequested) this._setLifecycle('ready');
    })().catch(error => this._fail(error)).finally(() => {
      this.syncPromise = null;
      if (this.resyncRequested) this._scheduleResync();
    });
    return this.syncPromise;
  }

  _scheduleResync() {
    if (this.syncPromise || this.resyncScheduled || !this.sender || this.sender.pendingBytes >= OUTPUT_PENDING_LIMIT / 2) return;
    this.resyncScheduled = true;
    queueMicrotask(() => { this.resyncScheduled = false; void this._synchronize(); });
  }

  requestResync() {
    if (!this.authenticated || ['stopping', 'stopped'].includes(this.lifecycle)) return;
    this.resyncRequested = true;
    this.deltasReady = false;
    this.syncQueue = [];
    this.syncQueueBytes = 0;
    this._scheduleResync();
  }

  _queueDuringSync(tab, data, ordinal) {
    const bytes = Buffer.byteLength(data, 'utf8');
    if (this.syncQueueBytes + bytes > MAX_SYNCED_OUTPUT_BYTES) {
      this.syncQueue = [];
      this.syncQueueBytes = 0;
      this.resyncRequested = true;
      return;
    }
    this.syncQueue.push({ tab, data, ordinal });
    this.syncQueueBytes += bytes;
  }

  _publishPart(tab, data) {
    if (!this._send('output', { tab, data, generation: this.generation }, { output: true })) {
      this.requestResync();
      return false;
    }
    return true;
  }

  publishOutput(tab, data) {
    if (!OVERLAY_TABS.includes(tab) || typeof data !== 'string' || !data) return false;
    let published = true;
    for (const part of splitOverlayOutput(data, MAX_OVERLAY_OUTPUT_BYTES)) {
      const ordinal = ++this.outputOrdinal;
      if (!this.authenticated || !this.deltasReady || this.syncPromise || this.resyncRequested) {
        if (this.authenticated) this._queueDuringSync(tab, part, ordinal);
        published = false;
      } else if (!this._publishPart(tab, part)) published = false;
    }
    return published;
  }

  publishStatus(tab, status) {
    if (!this.authenticated || !this.deltasReady || !OVERLAY_TABS.includes(tab)) { this.requestResync(); return false; }
    try { return this._send('status', { tab, status, generation: this.generation }); }
    catch (error) { this._fail(error); return false; }
  }

  publishState() { this.requestResync(); }

  _fail(reason) {
    if (this.lifecycle === 'stopped') return;
    const error = reason instanceof Error ? reason : new Error(String(reason));
    // Observers can include presentation code that is already failing. Never
    // let an error reporter prevent the owned child from being disconnected,
    // killed and retired.
    try { this.emit('protocol-error', error); } catch {}
    if (!this.ready.settled) { this.ready.settled = true; this.ready.reject(error); }
    try { if (this.child.connected) this.child.disconnect(); } catch {}
    this._killOwnedChild();
    this._retire({ reason: error.message, unexpected: this.lifecycle !== 'stopping', error });
  }

  _killOwnedChild() {
    try { if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill(); } catch {}
  }

  stop(reason = 'daemon stopping') {
    if (this.lifecycle === 'stopped') return this.closed.promise;
    if (this.lifecycle !== 'stopping') {
      this._setLifecycle('stopping');
      clearTimeout(this.handshakeTimer);
      if (!this.ready.settled) {
        const error = new OverlayProtocolError('STOPPED', 'Overlay host stopped before it became ready');
        this.ready.settled = true; this.ready.reject(error);
      }
      try { if (this.authenticated && this.child.connected) this._send('shutdown', { reason: String(reason).slice(0, 128) || 'daemon stopping' }); }
      catch (error) { this.emit('protocol-error', error); }
      this.shutdownTimer = setTimeout(() => {
        try { if (this.child.connected) this.child.disconnect(); } catch {}
        this._killOwnedChild();
        this._retire({ reason: 'overlay shutdown timeout', unexpected: false });
      }, this.shutdownTimeoutMs);
      this.shutdownTimer.unref?.();
    }
    return this.closed.promise;
  }

  _retire(details) {
    if (this.lifecycle === 'stopped' && this.closed.settled) return;
    clearTimeout(this.handshakeTimer); clearTimeout(this.shutdownTimer);
    this.sender?.dispose();
    for (const [event, listener] of Object.entries(this.bound)) this.child.off?.(event, listener);
    this.deltasReady = false;
    this._setLifecycle('stopped');
    if (!this.ready.settled) {
      const error = details.error ?? new OverlayProtocolError('CHILD_EXITED', details.reason);
      this.ready.settled = true; this.ready.reject(error);
    }
    if (!this.closed.settled) { this.closed.settled = true; this.closed.resolve(details); this.emit('closed', details); }
  }
}

/** Spawn Electron without a shell and with one inherited Node IPC descriptor. */
export function spawnElectronOverlay({ electronPath, mainPath, args = [], cwd, env = process.env,
  spawn = spawnProcess, stdio = ['ignore', 'inherit', 'inherit', 'ipc'] } = {}) {
  if (!path.isAbsolute(electronPath ?? '')) throw new TypeError('electronPath must be absolute');
  if (!path.isAbsolute(mainPath ?? '')) throw new TypeError('mainPath must be absolute');
  if (!Array.isArray(args) || args.some(value => typeof value !== 'string')) throw new TypeError('overlay args must be strings');
  const childEnv = { ...env, WITCHCRAFT_OVERLAY_CHILD: '1' };
  // This variable makes Electron execute its entry as plain Node. Developer
  // shells can carry it globally, so never let it disable the overlay runtime.
  delete childEnv.ELECTRON_RUN_AS_NODE;
  return spawn(electronPath, [mainPath, ...args], { cwd: cwd ?? path.dirname(mainPath), env: childEnv,
    stdio, windowsHide: true, shell: false });
}
