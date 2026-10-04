import { startElectronOverlay } from './overlay-electron-main.js';
import { resolveOverlayPaths } from './overlay-launch.js';

/** Start only inside the Electron child created by Witchcraft's inherited-IPC launcher. */
export async function runElectronOverlayEntry({
  env = process.env,
  send = process.send,
  start = startElectronOverlay,
  paths = resolveOverlayPaths(),
} = {}) {
  if (env?.WITCHCRAFT_OVERLAY_CHILD !== '1') {
    throw new Error('Witchcraft overlay entry may run only as its owned Electron child');
  }
  if (typeof send !== 'function') {
    throw new Error('Witchcraft overlay entry requires inherited IPC');
  }
  return start({ rendererPath: paths.rendererPath, preloadPath: paths.preloadPath });
}
