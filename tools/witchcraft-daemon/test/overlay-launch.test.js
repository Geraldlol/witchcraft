import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { EventEmitter, once } from 'node:events';
import {
  createElectronOverlaySupervisor,
  resolveElectronExecutable,
  resolveOverlayPaths,
} from '../src/overlay-launch.js';

test('overlay launcher: resolves an absolute, existing runtime layout', () => {
  const paths = resolveOverlayPaths();

  assert.equal(path.isAbsolute(paths.daemonRoot), true);
  assert.equal(path.isAbsolute(paths.entryPath), true);
  assert.equal(path.isAbsolute(paths.rendererPath), true);
  assert.equal(path.isAbsolute(paths.preloadPath), true);
  assert.equal(path.basename(paths.entryPath), 'electron-entry.mjs');
  assert.equal(path.basename(paths.rendererPath), 'index.html');
  assert.equal(path.basename(paths.preloadPath), 'preload.cjs');
  assert.equal(fs.statSync(paths.entryPath).isFile(), true);
  assert.equal(fs.statSync(paths.rendererPath).isFile(), true);
  assert.equal(fs.statSync(paths.preloadPath).isFile(), true);
});

test('overlay launcher: accepts only an absolute Electron executable', () => {
  const executable = path.resolve('fixtures', 'electron.exe');
  assert.equal(resolveElectronExecutable({ loadElectronPath: () => executable }), executable);
  assert.throws(() => resolveElectronExecutable({ loadElectronPath: () => 'electron.exe' }), /absolute/u);
  assert.throws(() => resolveElectronExecutable({ loadElectronPath: () => ({ default: executable }) }), /path string/u);
});

test('overlay launcher: factory spawns Electron with inherited IPC and absolute assets', async () => {
  const terminal = { disposeCalls: 0, dispose() { this.disposeCalls++; } };
  const electronPath = path.resolve('fixtures', 'electron.exe');
  const spawnCalls = [];
  const child = new EventEmitter();
  child.pid = 8123;
  child.connected = true;
  child.send = () => true;
  child.kill = () => true;

  const supervisor = createElectronOverlaySupervisor({
    terminal,
    electronPath,
    env: { WITCHCRAFT_TEST: 'yes', ELECTRON_RUN_AS_NODE: '1' },
    spawn: (...args) => { spawnCalls.push(args); return child; },
    maxRestarts: 0,
  });

  assert.equal(supervisor.terminal, terminal);
  assert.equal(spawnCalls.length, 0, 'factory does not launch presentation eagerly');
  assert.equal(await supervisor.spawnChild(), child);
  assert.equal(spawnCalls.length, 1);

  const [file, args, options] = spawnCalls[0];
  const paths = resolveOverlayPaths();
  assert.equal(file, electronPath);
  assert.deepEqual(args, [paths.entryPath]);
  assert.equal(options.cwd, paths.daemonRoot);
  assert.deepEqual(options.stdio, ['ignore', 'inherit', 'inherit', 'ipc']);
  assert.equal(options.env.WITCHCRAFT_OVERLAY_CHILD, '1');
  assert.equal(options.env.WITCHCRAFT_TEST, 'yes');
  assert.equal(options.env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(options.shell, false);
  assert.equal(options.windowsHide, true);
});

test('overlay launcher: presentation startup failure leaves terminal ownership intact', async () => {
  const terminal = { disposeCalls: 0, dispose() { this.disposeCalls++; } };
  const supervisor = createElectronOverlaySupervisor({
    terminal,
    electronPath: path.resolve('fixtures', 'missing-electron.exe'),
    spawn: () => { throw new Error('presentation unavailable'); },
    maxRestarts: 0,
  });
  const startupError = once(supervisor, 'startup-error');
  const unavailable = once(supervisor, 'unavailable');

  assert.equal(await supervisor.start(), null);
  assert.match((await startupError)[0].message, /presentation unavailable/u);
  assert.deepEqual(await unavailable, [{ restarts: 0 }]);
  assert.equal(terminal.disposeCalls, 0);
});
