import path from 'node:path';
import { OverlayChildTransport } from './overlay-child.js';
import { OVERLAY_PROTOCOL_VERSION, OVERLAY_TABS, OverlayProtocolError } from './overlay-protocol.js';

export const OVERLAY_RENDERER_CHANNELS = Object.freeze({
  getState: 'witchcraft:get-state',
  sendInput: 'witchcraft:send-input',
  resize: 'witchcraft:resize',
  setActiveTab: 'witchcraft:set-active-tab',
  setOpacity: 'witchcraft:set-opacity',
  setClickThrough: 'witchcraft:set-click-through',
  minimize: 'witchcraft:minimize',
  close: 'witchcraft:close',
  requestResync: 'witchcraft:request-resync',
  state: 'witchcraft:state',
});

function exactObject(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OverlayProtocolError('INVALID_RENDERER_MESSAGE', `${label} must be an object`);
  const own = Object.keys(value);
  if (own.length !== keys.length || own.some(key => !keys.includes(key))) throw new OverlayProtocolError('INVALID_RENDERER_MESSAGE', `${label} has invalid fields`);
  return value;
}
function boundedOpacity(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new OverlayProtocolError('INVALID_OPACITY', 'Overlay background opacity must be 0..1');
  }
  return value;
}
function safeBoolean(value, label) {
  if (typeof value !== 'boolean') throw new OverlayProtocolError('INVALID_RENDERER_MESSAGE', `${label} must be boolean`);
  return value;
}
function defaultSessions() {
  return OVERLAY_TABS.map(id => ({ id, title: id === 'claude' ? 'Claude' : 'Codex', status: 'connecting', lines: [] }));
}

/** Electron main-process controller. Electron is loaded only inside start(). */
export class ElectronOverlayMain {
  constructor({ electron, loadElectron = () => import('electron'), transport,
    rendererPath, preloadPath, windowOptions = {}, initialOpacity = 0.92,
    shortcutAccelerator = 'Ctrl+Shift+H' } = {}) {
    if (!path.isAbsolute(rendererPath ?? '')) throw new TypeError('rendererPath must be absolute');
    if (!path.isAbsolute(preloadPath ?? '')) throw new TypeError('preloadPath must be absolute');
    this.suppliedElectron = electron;
    this.loadElectron = loadElectron;
    this.transport = transport ?? new OverlayChildTransport();
    this.rendererPath = rendererPath;
    this.preloadPath = preloadPath;
    this.windowOptions = windowOptions;
    this.opacity = boundedOpacity(initialOpacity);
    this.clickThrough = false;
    this.shortcut = { accelerator: shortcutAccelerator, registered: false, conflict: false };
    this.lifecycle = 'stopped';
    this.handlers = [];
    this.transportListeners = [];
    this.rendererEventSeq = 0;
    this.stopping = null;
  }

  async start() {
    if (this.lifecycle !== 'stopped' || this.window) throw new Error('Electron overlay already started');
    this.lifecycle = 'starting';
    const electron = this.suppliedElectron ?? await this.loadElectron();
    const { app, BrowserWindow, ipcMain, globalShortcut } = electron;
    if (!app || !BrowserWindow || !ipcMain) throw new TypeError('Electron runtime is incomplete');
    this.electron = electron;
    this._listenTransport();
    const connecting = this.transport.start();
    void connecting.catch(() => {});
    try {
      await app.whenReady();
      this.window = new BrowserWindow({
        width: 1120, height: 720, minWidth: 560, minHeight: 320,
        transparent: true, frame: false, alwaysOnTop: true, backgroundColor: '#00000000',
        show: false, ...this.windowOptions,
        webPreferences: { ...(this.windowOptions.webPreferences ?? {}), preload: this.preloadPath,
          nodeIntegration: false, contextIsolation: true, sandbox: true },
      });
      this.window.once?.('ready-to-show', () => this.window?.show?.());
      this.window.once?.('closed', () => { if (!this.stopping) void this.stop('window closed'); });
      this._hardenWindow(this.window);
      try {
        this.shortcut.registered = globalShortcut?.register?.(this.shortcut.accelerator,
          () => this._setClickThrough(!this.clickThrough)) === true;
      } catch { this.shortcut.registered = false; }
      this.shortcut.conflict = !this.shortcut.registered;
      this._registerHandlers(ipcMain);
      await Promise.all([this.window.loadFile(this.rendererPath), connecting]);
      this.lifecycle = 'ready';
      this._emitState();
      return this;
    } catch (error) {
      await this.stop('overlay startup failed');
      throw error;
    }
  }

  state(extra = {}, kind = 'snapshot') {
    const state = this.transport.latestState ?? { authoritative: false, generation: 0,
      activeTab: 'claude', cols: 120, rows: 40, sessions: defaultSessions() };
    return { protocolVersion: OVERLAY_PROTOCOL_VERSION, eventSeq: this.rendererEventSeq, kind, ...state,
      lifecycle: this.lifecycle === 'ready' ? this.transport.lifecycle : this.lifecycle,
      opacity: this.opacity, clickThrough: this.clickThrough, shortcut: { ...this.shortcut }, ...extra };
  }

  _assertSender(event) {
    if (!this.window || event?.sender !== this.window.webContents) {
      throw new OverlayProtocolError('UNAUTHORIZED_RENDERER', 'Renderer IPC sender is not the overlay window');
    }
  }

  _handle(ipcMain, channel, callback) {
    ipcMain.handle(channel, async (event, ...args) => { this._assertSender(event); return callback(...args); });
    this.handlers.push(channel);
  }

  _registerHandlers(ipcMain) {
    this._handle(ipcMain, OVERLAY_RENDERER_CHANNELS.getState, () => this.state());
    this._handle(ipcMain, OVERLAY_RENDERER_CHANNELS.sendInput, value => {
      const payload = exactObject(value, ['tab', 'data'], 'send-input payload');
      this.transport.sendInput(payload.tab, payload.data); return { ok: true };
    });
    this._handle(ipcMain, OVERLAY_RENDERER_CHANNELS.resize, value => {
      const payload = exactObject(value, ['cols', 'rows'], 'resize payload');
      this.transport.resize(payload.cols, payload.rows); return { ok: true };
    });
    this._handle(ipcMain, OVERLAY_RENDERER_CHANNELS.setActiveTab, value => {
      const payload = exactObject(value, ['tab'], 'set-active-tab payload');
      this.transport.select(payload.tab); return { ok: true };
    });
    this._handle(ipcMain, OVERLAY_RENDERER_CHANNELS.setOpacity, value => {
      this.opacity = boundedOpacity(value); this._emitState(); return { ok: true };
    });
    this._handle(ipcMain, OVERLAY_RENDERER_CHANNELS.setClickThrough, value => {
      this._setClickThrough(safeBoolean(value, 'click-through')); return { ok: true };
    });
    this._handle(ipcMain, OVERLAY_RENDERER_CHANNELS.minimize, () => { this.window.minimize?.(); return { ok: true }; });
    this._handle(ipcMain, OVERLAY_RENDERER_CHANNELS.requestResync, () => ({ ok: this.transport.requestResync() }));
    this._handle(ipcMain, OVERLAY_RENDERER_CHANNELS.close, () => { void this.stop('renderer requested close'); return { ok: true }; });
  }

  _listenTransport() {
    const listen = (event, callback) => { this.transport.on(event, callback); this.transportListeners.push([event, callback]); };
    listen('state', () => this._emitState());
    listen('output', output => this._emitState({ output }, 'output'));
    listen('command-error', error => this._emitState({ error }, 'error'));
    listen('lifecycle', () => this._emitState({}, 'lifecycle'));
    listen('shutdown', reason => { void this.stop(reason); });
    listen('closed', details => { if (!this.stopping) void this.stop(details?.reason ?? 'overlay transport closed'); });
    listen('protocol-error', error => this._emitState({ error: { code: error.code ?? 'IPC_ERROR', message: error.message } }, 'error'));
  }

  _hardenWindow(window) {
    const contents = window.webContents;
    this.navigationGuard = event => event.preventDefault();
    contents.on?.('will-navigate', this.navigationGuard);
    contents.setWindowOpenHandler?.(() => ({ action: 'deny' }));
    this.permissionSession = contents.session;
    this.permissionSession?.setPermissionRequestHandler?.((webContents, permission, callback) => callback(false));
    this.permissionSession?.setPermissionCheckHandler?.(() => false);
    this.renderProcessGone = (_event, details = {}) => this._fatalPresentation(
      `renderer process gone${details.reason ? `: ${details.reason}` : ''}`);
    this.didFailLoad = (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
      if (isMainFrame !== false) this._fatalPresentation(`main frame failed to load (${errorCode ?? 'unknown'}): ${errorDescription ?? 'unknown error'}`);
    };
    this.windowUnresponsive = () => this._fatalPresentation('overlay window unresponsive');
    contents.on?.('render-process-gone', this.renderProcessGone);
    contents.on?.('did-fail-load', this.didFailLoad);
    window.on?.('unresponsive', this.windowUnresponsive);
  }

  _fatalPresentation(reason) {
    if (this.stopping) return;
    try { this.transport.abort?.(reason); } catch {}
    void this.stop(reason);
  }

  _setClickThrough(value) {
    if (value && !this.shortcut.registered) {
      throw new OverlayProtocolError('SHORTCUT_UNAVAILABLE',
        `${this.shortcut.accelerator} is unavailable; click-through cannot be enabled safely`);
    }
    this.clickThrough = value;
    if (value) {
      this.window?.setIgnoreMouseEvents?.(true, { forward: true });
      this.window?.setFocusable?.(false);
    } else {
      this.window?.setIgnoreMouseEvents?.(false);
      this.window?.setFocusable?.(true);
      this.window?.show?.();
      this.window?.focus?.();
    }
    this._emitState();
  }

  _emitState(extra = {}, kind = 'snapshot') {
    const contents = this.window?.webContents;
    if (!contents || contents.isDestroyed?.()) return;
    this.rendererEventSeq++;
    try { contents.send(OVERLAY_RENDERER_CHANNELS.state, this.state(extra, kind)); }
    catch { /* A dying renderer must not interrupt main-process teardown. */ }
  }

  stop(reason = 'overlay stopping') {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      this.lifecycle = 'stopping';
      if (this.shortcut.registered) this.electron?.globalShortcut?.unregister?.(this.shortcut.accelerator);
      this.shortcut.registered = false;
      const ipcMain = this.electron?.ipcMain;
      for (const channel of this.handlers.splice(0)) ipcMain?.removeHandler?.(channel);
      for (const [event, callback] of this.transportListeners.splice(0)) this.transport.off?.(event, callback);
      try { await this.transport.close(reason); } catch {}
      const window = this.window; this.window = null;
      window?.webContents?.off?.('will-navigate', this.navigationGuard);
      window?.webContents?.off?.('render-process-gone', this.renderProcessGone);
      window?.webContents?.off?.('did-fail-load', this.didFailLoad);
      window?.off?.('unresponsive', this.windowUnresponsive);
      this.permissionSession?.setPermissionRequestHandler?.(null);
      this.permissionSession?.setPermissionCheckHandler?.(null);
      try { if (window && !window.isDestroyed?.()) window.destroy?.(); } catch {}
      this.lifecycle = 'stopped';
      this.electron?.app?.quit?.();
    })();
    return this.stopping;
  }
}

export async function startElectronOverlay(options) {
  const controller = new ElectronOverlayMain(options);
  await controller.start();
  return controller;
}
