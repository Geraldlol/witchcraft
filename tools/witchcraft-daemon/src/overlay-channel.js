import { EventEmitter } from 'node:events';
import {
  MAX_OVERLAY_PENDING_BYTES,
  MAX_OVERLAY_PENDING_RECORDS,
  OverlayProtocolError,
  encodeOverlayRecord,
} from './overlay-protocol.js';

/**
 * A bounded wrapper around ChildProcess.send/process.send.
 * The callback is the only drain signal exposed by Node's process IPC API.
 */
export class BoundedOverlaySender extends EventEmitter {
  constructor({ channel, direction, maxPendingBytes = MAX_OVERLAY_PENDING_BYTES,
    maxPendingRecords = MAX_OVERLAY_PENDING_RECORDS, sendTimeoutMs = 3000,
    onFailure = () => {} }) {
    super();
    if (!channel || typeof channel.send !== 'function') throw new TypeError('Overlay IPC channel must provide send()');
    if (!['child', 'host'].includes(direction)) throw new TypeError('Overlay IPC direction must be child or host');
    this.channel = channel;
    this.direction = direction;
    this.maxPendingBytes = maxPendingBytes;
    this.maxPendingRecords = maxPendingRecords;
    this.sendTimeoutMs = sendTimeoutMs;
    this.onFailure = onFailure;
    this.pendingBytes = 0;
    this.pendingRecords = 0;
    this.entries = new Set();
    this.disposed = false;
  }

  measure(message) { return encodeOverlayRecord(message, this.direction); }
  canFit(bytes, { byteLimit = this.maxPendingBytes } = {}) {
    return !this.disposed && this.pendingRecords < this.maxPendingRecords && this.pendingBytes + bytes <= byteLimit;
  }

  send(value, { byteLimit = this.maxPendingBytes } = {}) {
    if (this.disposed) throw new OverlayProtocolError('CHANNEL_CLOSED', 'Overlay IPC sender is closed');
    const { message, bytes } = this.measure(value);
    if (!this.canFit(bytes, { byteLimit })) {
      throw new OverlayProtocolError('IPC_BACKPRESSURE', 'Overlay IPC pending queue exceeded its bound');
    }
    const entry = { bytes, settled: false, timer: null };
    const settle = error => {
      if (entry.settled) return;
      entry.settled = true;
      if (entry.timer) clearTimeout(entry.timer);
      this.entries.delete(entry);
      this.pendingBytes -= bytes;
      this.pendingRecords--;
      if (error) this.onFailure(error);
      this.emit('progress', { pendingBytes: this.pendingBytes, pendingRecords: this.pendingRecords });
      if (this.pendingRecords === 0) this.emit('drain');
    };
    this.entries.add(entry);
    this.pendingBytes += bytes;
    this.pendingRecords++;
    entry.timer = setTimeout(() => settle(new OverlayProtocolError('IPC_SEND_TIMEOUT', 'Overlay IPC send did not drain in time')),
      this.sendTimeoutMs);
    entry.timer.unref?.();
    try {
      const accepted = this.channel.send(message, error => settle(error || undefined));
      return { accepted: accepted !== false, bytes, message };
    } catch (error) {
      settle(error);
      throw error;
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.entries) {
      entry.settled = true;
      if (entry.timer) clearTimeout(entry.timer);
    }
    this.entries.clear();
    this.pendingBytes = 0;
    this.pendingRecords = 0;
    this.removeAllListeners();
  }
}
