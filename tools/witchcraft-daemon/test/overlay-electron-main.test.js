import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { ElectronOverlayMain, OVERLAY_RENDERER_CHANNELS } from '../src/overlay-electron-main.js';

class FakeTransport extends EventEmitter {
  constructor() {
    super(); this.lifecycle = 'ready'; this.calls = [];
    this.latestState = { authoritative: true, generation: 1, activeTab: 'claude', cols: 120, rows: 40,
      sessions: [{ id: 'claude', title: 'Claude', status: 'running', lines: ['Claude'] },
        { id: 'codex', title: 'Codex', status: 'running', lines: ['Codex'] }] };
  }
  async start() { this.calls.push(['start']); return this; }
  async close(reason) { this.calls.push(['close', reason]); }
  abort(reason) {
    this.calls.push(['abort', reason]);
    this.emit('protocol-error', new Error(reason));
    this.abortedCleanly = true;
    this.emit('closed', { reason, unexpected: true });
  }
  sendInput(...args) { this.calls.push(['input', ...args]); }
  resize(...args) { this.calls.push(['resize', ...args]); }
  select(...args) { this.calls.push(['select', ...args]); }
  sendClipboard(...args) { this.calls.push(['clipboard', ...args]); }
  requestResync() { this.calls.push(['resync']); return true; }
}

function fakeElectron({ shortcutRegisters = true } = {}) {
  const handlers = new Map(), windows = [], shortcut = { callback: null, unregistered: [] };
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.destroyed = false; this.events = [];
      const contents = new EventEmitter();
      contents.messages = []; contents.send = (...args) => contents.messages.push(args); contents.isDestroyed = () => this.destroyed;
      contents.setWindowOpenHandler = handler => { contents.openHandler = handler; };
      contents.session = { setPermissionRequestHandler: handler => { contents.session.requestHandler = handler; },
        setPermissionCheckHandler: handler => { contents.session.checkHandler = handler; } };
      this.webContents = contents;
      windows.push(this);
    }
    async loadFile(filename) { this.loaded = filename; }
    setOpacity() { this.opacityCalls = (this.opacityCalls ?? 0) + 1; }
    setIgnoreMouseEvents(...args) { this.ignore = args; }
    setFocusable(value) { this.focusable = value; }
    focus() { this.focused = true; }
    show() { this.shown = true; }
    minimize() { this.minimized = true; }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  return { windows, handlers, shortcut,
    app: { async whenReady() {}, quit() { this.quitCalled = true; } }, BrowserWindow: Window,
    ipcMain: { handle(channel, callback) { handlers.set(channel, callback); }, removeHandler(channel) { handlers.delete(channel); } },
    globalShortcut: { register(accelerator, callback) { shortcut.accelerator = accelerator; shortcut.callback = callback; return shortcutRegisters; },
      unregister(accelerator) { shortcut.unregistered.push(accelerator); } } };
}

async function fixture() {
  const electron = fakeElectron(), transport = new FakeTransport(), rendererPath = path.resolve('overlay/index.html'), preloadPath = path.resolve('overlay/preload.cjs');
  const controller = new ElectronOverlayMain({ electron, loadElectron: async () => { throw new Error('must stay lazy'); },
    transport, rendererPath, preloadPath, windowOptions: { webPreferences: { nodeIntegration: true, contextIsolation: false } } });
  await controller.start();
  const window = electron.windows[0], event = { sender: window.webContents };
  const invoke = (channel, payload, customEvent = event) => electron.handlers.get(channel)(customEvent, payload);
  return { electron, transport, controller, window, event, invoke };
}

test('electron overlay: secure lazy window and strict renderer commands', async t => {
  const f = await fixture(); t.after(() => f.controller.stop());
  assert.equal(f.window.options.webPreferences.nodeIntegration, false);
  assert.equal(f.window.options.webPreferences.contextIsolation, true);
  assert.equal(f.window.options.webPreferences.sandbox, true);
  await f.invoke(OVERLAY_RENDERER_CHANNELS.sendInput, { tab: 'codex', data: 'hello' });
  await f.invoke(OVERLAY_RENDERER_CHANNELS.resize, { cols: 100, rows: 30 });
  await f.invoke(OVERLAY_RENDERER_CHANNELS.setActiveTab, { tab: 'codex' });
  await f.invoke(OVERLAY_RENDERER_CHANNELS.setOpacity, 0);
  await f.invoke(OVERLAY_RENDERER_CHANNELS.setClickThrough, true);
  await f.invoke(OVERLAY_RENDERER_CHANNELS.minimize);
  await f.invoke(OVERLAY_RENDERER_CHANNELS.requestResync);
  assert.deepEqual(f.transport.calls.slice(1), [['input', 'codex', 'hello'], ['resize', 100, 30], ['select', 'codex'], ['resync']]);
  assert.equal(f.window.opacityCalls, undefined); assert.equal(f.controller.state().opacity, 0);
  assert.deepEqual(f.window.ignore, [true, { forward: true }]); assert.equal(f.window.focusable, false); assert.equal(f.window.minimized, true);
  await assert.rejects(f.invoke(OVERLAY_RENDERER_CHANNELS.sendInput, { tab: 'codex', data: 'x', extra: true }), /invalid fields/u);
  await assert.rejects(f.invoke(OVERLAY_RENDERER_CHANNELS.getState, undefined, { sender: {} }), error => error.code === 'UNAUTHORIZED_RENDERER');
});

test('electron overlay: renderer events are monotonic and distinguish snapshot from output', async t => {
  const f = await fixture(); t.after(() => f.controller.stop());
  const before = f.window.webContents.messages.at(-1)[1].eventSeq;
  f.transport.emit('output', { tab: 'claude', data: '\u001b[31mred', generation: 1 });
  f.transport.emit('state', f.transport.latestState);
  const events = f.window.webContents.messages.slice(-2).map(([, value]) => value);
  assert.deepEqual(events.map(value => value.kind), ['output', 'snapshot']);
  assert.deepEqual(events.map(value => value.eventSeq), [before + 1, before + 2]);
  assert.equal(events[0].output.data, '\u001b[31mred');
});

test('electron overlay: navigation, windows, permissions and click-through escape are hardened', async t => {
  const f = await fixture(); t.after(() => f.controller.stop());
  let prevented = false; f.window.webContents.emit('will-navigate', { preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.deepEqual(f.window.webContents.openHandler(), { action: 'deny' });
  let permission; f.window.webContents.session.requestHandler(null, 'camera', value => { permission = value; });
  assert.equal(permission, false); assert.equal(f.window.webContents.session.checkHandler(), false);
  assert.deepEqual(f.controller.state().shortcut, { accelerator: 'Ctrl+Shift+H', registered: true, conflict: false });
  f.electron.shortcut.callback(); assert.equal(f.controller.clickThrough, true); assert.equal(f.window.focusable, false);
  f.electron.shortcut.callback(); assert.equal(f.controller.clickThrough, false); assert.equal(f.window.focusable, true); assert.equal(f.window.focused, true);
  await f.controller.stop();
  assert.equal(f.electron.handlers.size, 0);
  assert.deepEqual(f.electron.shortcut.unregistered, ['Ctrl+Shift+H']);
});

test('electron overlay: global shortcut conflict is explicit state', async t => {
  const electron = fakeElectron({ shortcutRegisters: false }), transport = new FakeTransport();
  const controller = new ElectronOverlayMain({ electron, transport,
    rendererPath: path.resolve('overlay/index.html'), preloadPath: path.resolve('overlay/preload.cjs') });
  await controller.start(); t.after(() => controller.stop());
  assert.deepEqual(controller.state().shortcut, { accelerator: 'Ctrl+Shift+H', registered: false, conflict: true });
  const window = electron.windows[0];
  const invoke = electron.handlers.get(OVERLAY_RENDERER_CHANNELS.setClickThrough);
  await assert.rejects(invoke({ sender: window.webContents }, true), error => error.code === 'SHORTCUT_UNAVAILABLE');
  assert.equal(controller.clickThrough, false);
  assert.equal(window.ignore, undefined);
  assert.equal(window.focusable, undefined);
});

test('electron overlay: unexpected transport closure tears down the window, shortcut and app', async () => {
  const f = await fixture();
  f.transport.emit('closed', { reason: 'parent IPC disconnected', unexpected: true });
  await f.controller.stopping;
  assert.equal(f.window.destroyed, true);
  assert.deepEqual(f.electron.shortcut.unregistered, ['Ctrl+Shift+H']);
  assert.equal(f.electron.app.quitCalled, true);
  assert.deepEqual(f.transport.calls.at(-1), ['close', 'parent IPC disconnected']);
});

test('electron overlay: fatal renderer failures abort transport and tear down presentation', async t => {
  const cases = [
    ['render process gone', f => f.window.webContents.emit('render-process-gone', {}, { reason: 'crashed' }), /renderer process gone: crashed/u],
    ['main frame load failure', f => f.window.webContents.emit('did-fail-load', {}, -105, 'NAME_NOT_RESOLVED', 'file://overlay', true), /main frame failed to load/u],
    ['unresponsive window', f => f.window.emit('unresponsive'), /window unresponsive/u],
  ];
  for (const [name, trigger, expected] of cases) {
    await t.test(name, async () => {
      const f = await fixture();
      if (name === 'render process gone') f.window.webContents.send = () => { throw new Error('render frame disposed'); };
      trigger(f);
      await f.controller.stopping;
      const abort = f.transport.calls.find(call => call[0] === 'abort');
      assert.match(abort[1], expected);
      assert.equal(f.window.destroyed, true);
      assert.equal(f.transport.abortedCleanly, true);
      assert.equal(f.electron.app.quitCalled, true);
      assert.deepEqual(f.electron.shortcut.unregistered, ['Ctrl+Shift+H']);
    });
  }
});

test('electron overlay: subframe load failure is not fatal', async t => {
  const f = await fixture(); t.after(() => f.controller.stop());
  f.window.webContents.emit('did-fail-load', {}, -3, 'ABORTED', 'file://subframe', false);
  assert.equal(f.controller.stopping, null);
  assert.equal(f.window.destroyed, false);
  assert.equal(f.transport.calls.some(call => call[0] === 'abort'), false);
});
