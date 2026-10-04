import { EventEmitter } from 'node:events';
import { OverlayHost } from './overlay-host.js';

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

/**
 * Optional bounded recovery for the presentation process. Losing every overlay
 * still leaves the daemon-owned PTYs running.
 */
export class OverlaySupervisor extends EventEmitter {
  constructor({ spawnChild, terminal, maxRestarts = 2, restartDelayMs = 250,
    hostFactory = options => new OverlayHost(options), hostOptions = {} } = {}) {
    super();
    if (typeof spawnChild !== 'function') throw new TypeError('spawnChild is required');
    if (!terminal) throw new TypeError('terminal owner is required');
    if (!Number.isInteger(maxRestarts) || maxRestarts < 0 || maxRestarts > 5) throw new TypeError('maxRestarts must be 0..5');
    if (!Number.isInteger(restartDelayMs) || restartDelayMs < 0 || restartDelayMs > 5000) throw new TypeError('restartDelayMs must be 0..5000');
    this.spawnChild = spawnChild;
    this.terminal = terminal;
    this.maxRestarts = maxRestarts;
    this.restartDelayMs = restartDelayMs;
    this.hostFactory = hostFactory;
    this.hostOptions = hostOptions;
    this.activeTab = 'claude';
    this.restarts = 0;
    this.stopping = false;
    this.recovering = null;
  }

  async start() {
    if (this.host || this.recovering) throw new Error('Overlay supervisor already started');
    this.stopping = false;
    try { return await this._launch(); }
    catch (error) {
      this.emit('startup-error', error);
      if (!this.recovering && !this.stopping) this._beginRecovery();
      return this.recovering ? this.recovering : null;
    }
  }

  async _launch() {
    const child = await this.spawnChild();
    if (this.stopping) { try { child.kill?.(); } catch {} return null; }
    const host = this.hostFactory({ child, terminal: this.terminal, initialTab: this.activeTab, ...this.hostOptions });
    this.host = host;
    const forward = (event, callback) => host.on(event, callback);
    forward('select', tab => { this.activeTab = tab; this.emit('select', tab); });
    forward('clipboard', text => this.emit('clipboard', text));
    forward('protocol-error', error => this.emit('protocol-error', error));
    forward('lifecycle', lifecycle => this.emit('lifecycle', lifecycle));
    forward('closed', details => {
      if (this.host === host) this.host = null;
      this.emit('closed', details);
      if (!this.stopping && details.unexpected) this._beginRecovery();
    });
    try {
      await host.start();
      this.emit('ready', { restart: this.restarts, sessionId: host.sessionId });
      return host;
    } catch (error) {
      if (this.host === host) this.host = null;
      throw error;
    }
  }

  _beginRecovery() {
    if (this.stopping) return this.recovering;
    if (this.recovering) { this.recoveryRequested = true; return this.recovering; }
    this.recoveryRequested = false;
    this.recovering = (async () => {
      while (!this.stopping && this.restarts < this.maxRestarts) {
        this.restarts++;
        this.emit('restarting', { attempt: this.restarts, maxRestarts: this.maxRestarts });
        if (this.restartDelayMs) await delay(this.restartDelayMs * this.restarts);
        try {
          const host = await this._launch();
          this.recoveryRequested = false;
          return host;
        } catch (error) {
          this.recoveryRequested = false;
          this.emit('restart-error', error);
        }
      }
      if (!this.stopping) this.emit('unavailable', { restarts: this.restarts });
      return null;
    })().finally(() => {
      this.recovering = null;
      if (this.recoveryRequested && !this.stopping) { this.recoveryRequested = false; this._beginRecovery(); }
    });
    return this.recovering;
  }

  publishOutput(tab, data) { return this.host?.publishOutput(tab, data) ?? false; }
  publishStatus(tab, status) { return this.host?.publishStatus(tab, status) ?? false; }
  publishState() { this.host?.publishState(); }

  async stop(reason = 'daemon stopping') {
    this.stopping = true;
    const host = this.host; this.host = null;
    if (host) await host.stop(reason);
    if (this.recovering) await this.recovering;
  }
}
