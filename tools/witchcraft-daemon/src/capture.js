import { spawn as nodeSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { win32 } from 'node:path';

const HELPER = fileURLToPath(new URL('../capture/capture-strip.ps1', import.meta.url));
const POWERSHELL = win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const WIDTH = 132;
const HEIGHT = 12;
const PROFILES = Object.freeze({ strip: { width: WIDTH, height: HEIGHT }, burst: { width: WIDTH, height: 144 } });
const MAX_PIXELS = 16_000_000;
const CALIBRATION_LIMIT = Math.ceil(MAX_PIXELS * 4 / 3) * 4 + 4096;

export function validateRegion(region, profile = 'strip') {
  if (!region || typeof region !== 'object' || Array.isArray(region)) throw new TypeError('A calibrated capture region is required');
  const geometry = PROFILES[profile];
  if (!geometry) throw new TypeError('Unknown capture profile');
  const { x, y } = region;
  if (!Number.isInteger(x) || !Number.isInteger(y) || Math.abs(x) > 32768 || Math.abs(y) > 32768) {
    throw new RangeError('Capture coordinates must be integers between -32768 and 32768');
  }
  if ((region.width !== undefined && region.width !== geometry.width) || (region.height !== undefined && region.height !== geometry.height)
    || (region.cellSize !== undefined && region.cellSize !== 6)) {
    throw new RangeError(`The ${profile} capture must be ${geometry.width} by ${geometry.height} pixels with 6-pixel cells`);
  }
  return { x, y, width: geometry.width, height: geometry.height };
}

function command(region, calibration, once) {
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HELPER,
    '-Mode', once ? 'Once' : 'Stream'];
  if (calibration) args.push('-Calibration');
  else args.push('-X', String(region.x), '-Y', String(region.y), '-Width', String(region.width), '-Height', String(region.height));
  return args;
}

function parseFrame(line, { region, calibration }) {
  let frame;
  try { frame = JSON.parse(line); } catch { throw new Error('Capture helper returned invalid JSON'); }
  if (!frame || typeof frame !== 'object' || Array.isArray(frame) || frame.protocol !== 1) {
    throw new Error('Capture helper returned an unknown protocol');
  }
  if (frame.type === 'error') throw new Error(`Capture helper: ${String(frame.message || 'capture failed').slice(0, 1024)}`);
  if (frame.type === 'idle' && frame.foreground === false && !calibration) return { idle: true };
  if (frame.type !== 'frame') throw new Error('Capture helper returned an unknown record');
  const { width, height, x, y, captureMs, foreground, rgba } = frame;
  if (![width, height, x, y].every(Number.isInteger) || width <= 0 || height <= 0 || width > 32768 || height > 32768
    || width * height > MAX_PIXELS || Math.abs(x) > 32768 || Math.abs(y) > 32768) {
    throw new Error('Capture helper returned invalid image dimensions or origin');
  }
  if (!calibration && (width !== region.width || height !== region.height || x !== region.x || y !== region.y)) {
    throw new Error('Capture helper returned a different strip region');
  }
  if (!Number.isFinite(captureMs) || captureMs < 0 || captureMs > 60_000 || typeof foreground !== 'boolean') {
    throw new Error('Capture helper returned invalid timing or foreground state');
  }
  const bytes = width * height * 4;
  const padding = (3 - bytes % 3) % 3;
  if (typeof rgba !== 'string' || rgba.length !== 4 * Math.ceil(bytes / 3)
    || (padding && !rgba.endsWith('='.repeat(padding)))
    || !/^[A-Za-z0-9+/]*$/.test(rgba.slice(0, rgba.length - padding))) {
    throw new Error('Capture helper returned invalid RGBA encoding');
  }
  const data = Buffer.from(rgba, 'base64');
  if (data.length !== bytes) throw new Error('Capture helper returned the wrong RGBA byte count');
  return { width, height, data, x, y, captureMs, foreground };
}

// Accumulate buffers once per complete record. Calibration can be large; this
// avoids repeatedly flattening an ever-growing string on every pipe fragment.
function lines(limit, receive) {
  let parts = [], length = 0, stopped = false;
  return {
    stop() { stopped = true; parts = []; length = 0; },
    push(chunk) {
      if (stopped) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      let offset = 0;
      while (offset < buffer.length && !stopped) {
        const end = buffer.indexOf(10, offset);
        const piece = buffer.subarray(offset, end === -1 ? buffer.length : end);
        length += piece.length;
        if (length > limit) throw new Error('Capture helper exceeded the bounded output record size');
        parts.push(piece);
        if (end === -1) return;
        let line = Buffer.concat(parts, length).toString('utf8');
        parts = []; length = 0;
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line !== '') receive(line);
        offset = end + 1;
      }
    },
  };
}

function detach(child, handlers) {
  child.stdout?.removeListener?.('data', handlers.data);
  child.stderr?.removeListener?.('data', handlers.stderr);
  child.removeListener?.('error', handlers.error);
  child.removeListener?.('exit', handlers.exit);
  // A cancelled spawn may emit its error after stop(). Consume that one late
  // lifecycle signal without retaining application callbacks or delivering it.
  const lateError = () => {};
  child.on?.('error', lateError);
  child.once?.('close', () => child.removeListener?.('error', lateError));
  if (!child.killed) child.kill?.();
}

function runHelper({ region, calibration, once, spawn, receive, idle = () => {}, fail }) {
  let child, parser, stopped = false, stderr = '', startup;
  const stop = () => {
    if (stopped) return;
    stopped = true; clearTimeout(startup); parser?.stop();
    if (child) detach(child, handlers);
  };
  const failure = error => { if (!stopped) { stop(); fail(error instanceof Error ? error : new Error(String(error))); } };
  const handlers = {
    data(chunk) {
      if (stopped) return;
      try { parser.push(chunk); } catch (error) { failure(error); }
    },
    stderr(chunk) { if (!stopped) stderr = (stderr + String(chunk)).slice(-4096); },
    error: failure,
    exit(code) { failure(new Error(`Capture helper exited before shutdown (${code ?? 'unknown'})${stderr ? ': ' + stderr.trim() : ''}`)); },
  };
  const streamLimit = region ? Math.ceil(region.width * region.height * 4 / 3) * 4 + 4096 : 0;
  parser = lines(calibration ? CALIBRATION_LIMIT : streamLimit, line => {
    if (stopped) return;
    const frame = parseFrame(line, { region, calibration });
    if (frame || !once) clearTimeout(startup);
    if (frame?.idle) idle();
    else if (frame) receive(frame, stop);
  });
  try {
    child = spawn(POWERSHELL, command(region, calibration, once), { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    if (!child?.stdout || !child.stderr || typeof child.on !== 'function') throw new Error('Capture helper did not expose piped output');
    child.stdout.on('data', handlers.data); child.stderr.on('data', handlers.stderr);
    child.on('error', handlers.error); child.on('exit', handlers.exit);
    startup = setTimeout(() => failure(new Error('Capture helper did not respond within 20 seconds')), 20_000);
    startup.unref?.();
  } catch (error) { failure(error); }
  return stop;
}

/** One hidden PowerShell process captures a calibrated strip at five frames/sec. */
export class Capture {
  constructor({ region, profile = 'strip', onFrame, onIdle = () => {}, onError = () => {}, spawn = nodeSpawn }) {
    this.region = validateRegion(region, profile);
    if (typeof onFrame !== 'function' || typeof onIdle !== 'function' || typeof onError !== 'function' || typeof spawn !== 'function') {
      throw new TypeError('Capture callbacks and spawn adapter must be functions');
    }
    this.onFrame = onFrame; this.onIdle = onIdle; this.onError = onError; this.spawn = spawn;
    this.running = false; this.stopHelper = null; this.generation = 0;
  }

  start() {
    if (this.running) return this;
    this.running = true;
    const generation = ++this.generation;
    const stop = runHelper({ region: this.region, calibration: false, once: false, spawn: this.spawn,
      idle: () => {
        if (this.running && generation === this.generation) this.onIdle();
      },
      receive: frame => {
        if (this.running && generation === this.generation && frame.foreground) this.onFrame(frame);
      },
      fail: error => {
        if (!this.running || generation !== this.generation) return;
        this.running = false; this.stopHelper = null;
        try { this.onError(error); } catch { /* A reporting callback cannot restart a failed capture. */ }
      },
    });
    if (this.running && generation === this.generation) this.stopHelper = stop;
    else stop();
    return this;
  }

  stop() {
    this.running = false; this.generation++;
    const stop = this.stopHelper; this.stopHelper = null; stop?.();
  }
}

/** Calibration captures the virtual desktop once (at most sixteen million pixels). */
export function captureOnce({ region, calibration = false, spawn = nodeSpawn } = {}) {
  return new Promise((resolve, reject) => {
    if (typeof calibration !== 'boolean' || typeof spawn !== 'function') { reject(new TypeError('Invalid capture options')); return; }
    let validated;
    try { validated = calibration ? null : validateRegion(region); } catch (error) { reject(error); return; }
    runHelper({ region: validated, calibration, once: true, spawn,
      receive(frame, stop) { stop(); resolve(frame); }, fail: reject });
  });
}
