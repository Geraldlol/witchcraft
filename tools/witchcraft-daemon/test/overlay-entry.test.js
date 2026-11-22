import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runElectronOverlayEntry } from '../src/overlay-entry.js';

const entryPath = fileURLToPath(new URL('../overlay/electron-entry.mjs', import.meta.url));

test('overlay entry: refuses to start without its owned-child marker', async () => {
  let starts = 0;
  await assert.rejects(
    runElectronOverlayEntry({ env: {}, send: () => {}, start: async () => { starts++; } }),
    /owned Electron child/u,
  );
  assert.equal(starts, 0);
});

test('overlay entry: refuses to start without inherited process IPC', async () => {
  let starts = 0;
  await assert.rejects(
    runElectronOverlayEntry({ env: { WITCHCRAFT_OVERLAY_CHILD: '1' }, send: undefined,
      start: async () => { starts++; } }),
    /inherited IPC/u,
  );
  assert.equal(starts, 0);
});

test('overlay entry: supplies absolute renderer and preload paths to Electron main', async () => {
  const calls = [];
  const result = { controller: true };
  assert.equal(await runElectronOverlayEntry({
    env: { WITCHCRAFT_OVERLAY_CHILD: '1' },
    send: () => {},
    start: async options => { calls.push(options); return result; },
  }), result);
  assert.equal(calls.length, 1);
  assert.equal(path.isAbsolute(calls[0].rendererPath), true);
  assert.equal(path.isAbsolute(calls[0].preloadPath), true);
  assert.equal(path.basename(calls[0].rendererPath), 'index.html');
  assert.equal(path.basename(calls[0].preloadPath), 'preload.cjs');
});

test('overlay entry: executable module fails closed under ordinary Node', () => {
  const env = { ...process.env };
  delete env.WITCHCRAFT_OVERLAY_CHILD;
  const result = spawnSync(process.execPath, [entryPath], { env, encoding: 'utf8', windowsHide: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /owned Electron child/u);
});
