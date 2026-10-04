import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnElectronOverlay } from './overlay-host.js';
import { OverlaySupervisor } from './overlay-supervisor.js';

const requireFromDaemon = createRequire(import.meta.url);

/** Resolve the packaged overlay from this module, independent of process.cwd(). */
export function resolveOverlayPaths({ moduleUrl = import.meta.url } = {}) {
  const sourceDirectory = path.dirname(fileURLToPath(moduleUrl));
  const daemonRoot = path.resolve(sourceDirectory, '..');
  const overlayDirectory = path.join(daemonRoot, 'overlay');
  return Object.freeze({
    daemonRoot,
    entryPath: path.join(overlayDirectory, 'electron-entry.mjs'),
    rendererPath: path.join(overlayDirectory, 'index.html'),
    preloadPath: path.join(overlayDirectory, 'preload.cjs'),
  });
}

/** Resolve Electron's platform executable without importing Electron into the daemon. */
export function resolveElectronExecutable({ electronPath, loadElectronPath = () => requireFromDaemon('electron') } = {}) {
  const executable = electronPath ?? loadElectronPath();
  if (typeof executable !== 'string') throw new TypeError('Electron module must resolve to a path string');
  if (!path.isAbsolute(executable)) throw new TypeError('Electron executable path must be absolute');
  return path.normalize(executable);
}

/**
 * Build the optional presentation supervisor around a daemon-owned TerminalPair.
 * Spawning is lazy; a missing or crashed presentation never acquires PTY ownership.
 */
export function createElectronOverlaySupervisor({
  terminal,
  electronPath,
  loadElectronPath,
  env = process.env,
  spawn,
  maxRestarts,
  restartDelayMs,
  hostFactory,
  hostOptions,
  paths = resolveOverlayPaths(),
} = {}) {
  if (!terminal) throw new TypeError('terminal owner is required');
  const executable = resolveElectronExecutable({ electronPath, loadElectronPath });
  const spawnChild = () => spawnElectronOverlay({
    electronPath: executable,
    mainPath: paths.entryPath,
    cwd: paths.daemonRoot,
    env,
    spawn,
  });

  return new OverlaySupervisor({
    terminal,
    spawnChild,
    maxRestarts,
    restartDelayMs,
    hostFactory,
    hostOptions,
  });
}
