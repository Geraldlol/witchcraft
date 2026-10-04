import { EventEmitter } from 'node:events';
import { BoundedOverlaySender } from './overlay-channel.js';
import {
  OVERLAY_PROTOCOL_VERSION,
  OverlayProtocolError,
  validateHostMessage,
} from './overlay-protocol.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject, settled: false };
}

/** Child-side transport used by Electron's main process. */
export class OverlayChildTransport extends EventEmitter {
  constructor({ channel = process, pid = process.pid, handshakeTimeoutMs = 5000, sendTimeoutMs = 3000 } = {}) {
    super();
    if (!channel || typeof channel.on !== 'function' || typeof channel.send !== 'function') {
      throw new TypeError('Electron overlay requires an inherited process IPC channel');
    }
    this.channel = channel;
    this.pid = pid;
    this.handshakeTimeoutMs = handshakeTimeoutMs;
    this.sendTimeoutMs = sendTimeoutMs;
    this.lifecycle = 'stopped';
    this.childSeq = 0;
    this.lastHostSeq = 0;
    this.sessionId = null;
    this.latestState = null;
    this.ready = deferred();
    this.closed = deferred();
    this.bound = {
      message: message => this._receive(message),
      disconnect: () => this._retire({ reason: 'parent IPC disconnected', unexpected: this.lifecycle !== 'stopping' }),
    };
  }

  _setLifecycle(value) {
    if (this.lifecycle === value) return;
    this.lifecycle = value;
    this.emit('lifecycle', value);
  }

  start() {
    if (this.sender || this.closed.settled) throw new Error('Overlay child transport already started');
    if (this.channel.connected === false) throw new Error('Overlay child has no connected parent IPC channel');
    this._setLifecycle('starting');
    this.sender = new BoundedOverlaySender({ channel: this.channel, direction: 'child', sendTimeoutMs: this.sendTimeoutMs,
      onFailure: error => this._fail(error) });
    for (const [event, listener] of Object.entries(this.bound)) this.channel.on(event, listener);
    this.sender.send({ v: OVERLAY_PROTOCOL_VERSION, type: 'hello', seq: 0,
      payload: { role: 'electron-overlay', pid: this.pid } });
    this.handshakeTimer = setTimeout(() => this._fail(new OverlayProtocolError('HANDSHAKE_TIMEOUT', 'Overlay host did not synchronize in time')),
      this.handshakeTimeoutMs);
    this.handshakeTimer.unref?.();
    return this.ready.promise;
  }

  _send(type, payload) {
    if (!this.sender || ['stopping', 'stopped'].includes(this.lifecycle)) throw new OverlayProtocolError('CHANNEL_CLOSED', 'Overlay child IPC is closed');
    const envelope = { v: OVERLAY_PROTOCOL_VERSION, type, seq: this.childSeq + 1, payload };
    const result = this.sender.send(envelope);
    this.childSeq++;
    return result;
  }

  _receive(raw) {
    try {
      const message = validateHostMessage(raw);
      if (message.seq !== this.lastHostSeq + 1) throw new OverlayProtocolError('INVALID_SEQUENCE', 'Overlay host sequence is not contiguous');
      this.lastHostSeq = message.seq;
      if (!this.sessionId) {
        if (message.type !== 'ready') throw new OverlayProtocolError('HANDSHAKE_REQUIRED', 'Overlay host must send ready first');
        this.sessionId = message.payload.sessionId;
        this._setLifecycle('syncing');
        return;
      }
      this._handle(message);
    } catch (error) { this._fail(error); }
  }

  _handle(message) {
    const { type, payload } = message;
    if (type === 'ready') throw new OverlayProtocolError('DUPLICATE_HANDSHAKE', 'Overlay ready may only be sent once');
    if (type === 'state') {
      this.latestState = payload;
      this.resyncInFlight = false;
      clearTimeout(this.handshakeTimer);
      this._setLifecycle('ready');
      if (!this.ready.settled) { this.ready.settled = true; this.ready.resolve(this); }
      this.emit('state', payload);
      return;
    }
    if (type === 'output' || type === 'status') {
      if (!this.latestState || payload.generation !== this.latestState.generation) {
        this.requestResync();
        return;
      }
      if (type === 'status') {
        const session = this.latestState.sessions.find(item => item.id === payload.tab);
        if (session) session.status = payload.status;
        this.emit('state', this.latestState);
      } else this.emit('output', payload);
      return;
    }
    if (type === 'error') this.emit('command-error', payload);
    else if (type === 'pong') this.emit('pong', payload.nonce);
    else if (type === 'shutdown') {
      this._setLifecycle('stopping');
      this.emit('shutdown', payload.reason);
    }
  }

  _assertReady() {
    if (this.lifecycle !== 'ready' || !this.latestState) throw new OverlayProtocolError('NOT_READY', 'Overlay is not synchronized');
  }
  sendInput(tab, data) { this._assertReady(); return this._send('input', { tab, data }); }
  sendClipboard(text) { this._assertReady(); return this._send('clipboard', { text }); }
  resize(cols, rows) { this._assertReady(); return this._send('resize', { cols, rows }); }
  select(tab) {
    this._assertReady();
    const sent = this._send('select', { tab });
    this.latestState = { ...this.latestState, activeTab: tab };
    this.emit('state', this.latestState);
    return sent;
  }
  ping(nonce) { this._assertReady(); return this._send('ping', { nonce }); }
  requestResync() {
    if (!this.sender || !this.sessionId || ['stopping', 'stopped'].includes(this.lifecycle)) return false;
    if (this.resyncInFlight) return false;
    const generation = this.latestState?.generation ?? 0;
    this.resyncInFlight = true;
    this._setLifecycle('syncing');
    try { this._send('resync', { generation }); }
    catch (error) { this.resyncInFlight = false; throw error; }
    return true;
  }

  _fail(reason) {
    if (this.lifecycle === 'stopped') return;
    const error = reason instanceof Error ? reason : new Error(String(reason));
    // Error observers are presentation telemetry. A renderer that is already
    // gone can throw while handling this event, but transport retirement must
    // still reach the host so it can recover the presentation process.
    try { this.emit('protocol-error', error); } catch {}
    if (!this.ready.settled) { this.ready.settled = true; this.ready.reject(error); }
    try { if (this.channel.connected !== false && typeof this.channel.disconnect === 'function') this.channel.disconnect(); } catch {}
    this._retire({ reason: error.message, unexpected: this.lifecycle !== 'stopping', error });
  }

  close(reason = 'overlay closing') {
    if (this.lifecycle === 'stopped') return this.closed.promise;
    const alreadyStopping = this.lifecycle === 'stopping';
    clearTimeout(this.handshakeTimer);
    if (!this.ready.settled) {
      const error = new OverlayProtocolError('STOPPED', 'Overlay closed before it became ready');
      this.ready.settled = true; this.ready.reject(error);
    }
    if (!alreadyStopping) {
      try { if (this.sessionId && this.channel.connected !== false) this._send('disconnect', { reason: String(reason).slice(0, 128) }); }
      catch (error) { this.emit('protocol-error', error); }
    }
    this._setLifecycle('stopping');
    try { if (typeof this.channel.disconnect === 'function') this.channel.disconnect(); } catch {}
    this._retire({ reason, unexpected: false });
    return this.closed.promise;
  }

  abort(reason = 'overlay transport failed') {
    if (this.lifecycle === 'stopped') return this.closed.promise;
    this._fail(reason instanceof Error ? reason : new OverlayProtocolError('OVERLAY_FAILED', String(reason)));
    return this.closed.promise;
  }

  _retire(details) {
    if (this.lifecycle === 'stopped' && this.closed.settled) return;
    clearTimeout(this.handshakeTimer);
    this.sender?.dispose();
    for (const [event, listener] of Object.entries(this.bound)) this.channel.off?.(event, listener);
    this._setLifecycle('stopped');
    if (!this.ready.settled) {
      const error = details.error ?? new OverlayProtocolError('HOST_DISCONNECTED', details.reason);
      this.ready.settled = true; this.ready.reject(error);
    }
    if (!this.closed.settled) { this.closed.settled = true; this.closed.resolve(details); this.emit('closed', details); }
  }
}
