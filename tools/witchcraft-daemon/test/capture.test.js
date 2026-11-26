import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { Capture, captureOnce, validateRegion } from '../src/capture.js';

function mockSpawn() {
  const children = [], calls = [];
  const spawn = (...args) => {
    calls.push(args);
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.killCount = 0; child.killed = false;
    child.kill = () => { child.killed = true; child.killCount++; };
    children.push(child); return child;
  };
  return { spawn, children, calls };
}
function record(overrides = {}) {
  return { protocol: 1, type: 'frame', x: -1920, y: 0, width: 132, height: 12,
    foreground: true, captureMs: 15, rgba: Buffer.alloc(132 * 12 * 4, 85).toString('base64'), ...overrides };
}
function output(child, data, split = 0) {
  const line = JSON.stringify(data) + '\r\n';
  if (split) {
    child.stdout.emit('data', Buffer.from(line.slice(0, split)));
    child.stdout.emit('data', Buffer.from(line.slice(split)));
  } else child.stdout.emit('data', Buffer.from(line));
}

test('capture validates exact strip dimensions and bounded negative desktop coordinates', () => {
  assert.deepEqual(validateRegion({ x: -1920, y: -1080 }), { x: -1920, y: -1080, width: 132, height: 12 });
  assert.deepEqual(validateRegion({ x: -1920, y: -1080 }, 'burst'),
    { x: -1920, y: -1080, width: 132, height: 144 });
  assert.throws(() => validateRegion({ x: 0, y: 0, height: 12 }, 'burst'));
  for (const invalid of [null, {}, { x: NaN, y: 0 }, { x: .5, y: 0 }, { x: 32769, y: 0 },
    { x: 0, y: 0, width: 131 }, { x: 0, y: 0, height: 6 }, { x: 0, y: 0, cellSize: 4 }]) {
    assert.throws(() => validateRegion(invalid));
  }
});

test('burst profile requests and accepts only the strict 132x144 record', () => {
  const mock = mockSpawn(), frames = [], errors = [];
  const capture = new Capture({ region: { x: 4, y: 8 }, profile: 'burst', spawn: mock.spawn,
    onFrame: frame => frames.push(frame), onError: error => errors.push(error) });
  capture.start();
  const args = mock.calls[0][1];
  assert.equal(args[args.indexOf('-Width') + 1], '132');
  assert.equal(args[args.indexOf('-Height') + 1], '144');
  output(mock.children[0], record({ x: 4, y: 8, height: 144,
    rgba: Buffer.alloc(132 * 144 * 4, 85).toString('base64') }));
  assert.equal(frames.length, 1); assert.equal(frames[0].data.length, 132 * 144 * 4);
  assert.deepEqual(errors, []); capture.stop();
});

test('one persistent hidden helper delivers only foreground WowB frames until explicit stop', () => {
  const mock = mockSpawn(), received = [], errors = []; let idle = 0;
  const capture = new Capture({ region: { x: -1920, y: 0 }, onFrame: frame => received.push(frame),
    onIdle: () => idle++, onError: error => errors.push(error), spawn: mock.spawn });
  capture.start(); capture.start();
  assert.equal(mock.children.length, 1);
  const [exe, args, options] = mock.calls[0];
  assert.ok(exe.endsWith(process.platform === 'win32' ? 'powershell.exe' : 'python3'));
  assert.equal(args[args.indexOf('-Mode') + 1], 'Stream');
  assert.equal(args[args.indexOf('-X') + 1], '-1920');
  assert.deepEqual(options, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  output(mock.children[0], { protocol: 1, type: 'idle', foreground: false });
  assert.equal(idle, 1);
  output(mock.children[0], record({ foreground: false }));
  output(mock.children[0], record(), 17);
  output(mock.children[0], record({ captureMs: 14 }));
  assert.equal(received.length, 2);
  assert.equal(received[0].data.length, 6336);
  assert.equal(received[0].data[0], 85);
  assert.equal(received[0].captureMs, 15);
  assert.equal(received[0].x, -1920);
  capture.stop(); capture.stop();
  assert.equal(mock.children[0].killCount, 1);
  assert.equal(mock.children[0].stdout.listenerCount('data'), 0);
  assert.equal(mock.children[0].stderr.listenerCount('data'), 0);
  output(mock.children[0], record());
  mock.children[0].emit('error', new Error('late cancelled spawn'));
  assert.equal(received.length, 2); assert.equal(errors.length, 0);
  capture.start(); output(mock.children[1], record());
  assert.equal(received.length, 3); capture.stop();
});

test('an idle record passes its outside reason to onIdle and a plain idle passes none', () => {
  const mock = mockSpawn(), reasons = [];
  const capture = new Capture({ region: { x: 0, y: 0 }, spawn: mock.spawn, onFrame() {},
    onIdle: (...args) => reasons.push(args), onError: error => assert.fail(error) });
  capture.start();
  output(mock.children[0], { protocol: 1, type: 'idle', foreground: false, reason: 'outside' });
  output(mock.children[0], { protocol: 1, type: 'idle', foreground: false });
  output(mock.children[0], { protocol: 1, type: 'idle', foreground: false, reason: 'other' });
  assert.deepEqual(reasons, [['outside'], [undefined], [undefined]]);
  capture.stop();
});

test('stop inside a frame callback discards additional records from the same pipe fragment', () => {
  const mock = mockSpawn(); let received = 0;
  const capture = new Capture({ region: { x: -1920, y: 0 }, spawn: mock.spawn,
    onFrame: () => { received++; capture.stop(); } });
  capture.start();
  const line = JSON.stringify(record()) + '\n';
  mock.children[0].stdout.emit('data', Buffer.from(line + line));
  assert.equal(received, 1); assert.equal(mock.children[0].killCount, 1);
});

test('invalid frame shape, region, metadata and RGBA close the helper exactly once', () => {
  const invalid = [
    { protocol: 2 }, { type: 'unknown' }, { width: 1 }, { height: 6 }, { x: 0 },
    { height: 16000001 }, { width: 132.5 }, { captureMs: -1 }, { captureMs: '15' },
    { foreground: 'true' }, { rgba: '?' }, { rgba: Buffer.alloc(6335).toString('base64') },
    { rgba: ' '.repeat(8448) }, { rgba: '='.repeat(8448) },
  ];
  for (const overrides of invalid) {
    const mock = mockSpawn(), errors = [], frames = [];
    const capture = new Capture({ region: { x: -1920, y: 0 }, spawn: mock.spawn,
      onFrame: value => frames.push(value), onError: error => errors.push(error) });
    capture.start(); output(mock.children[0], record(overrides));
    output(mock.children[0], record());
    assert.equal(errors.length, 1, JSON.stringify(overrides));
    assert.equal(frames.length, 0); assert.equal(mock.children[0].killCount, 1);
    assert.equal(capture.running, false);
  }
});

test('unterminated oversized output and invalid JSON fail with bounded buffering', () => {
  for (const payload of ['x'.repeat(16385), '{}\n', 'not-json\n']) {
    const mock = mockSpawn(), errors = [];
    const capture = new Capture({ region: { x: 0, y: 0 }, spawn: mock.spawn,
      onFrame: () => assert.fail('malformed output cannot deliver'), onError: error => errors.push(error) });
    capture.start(); mock.children[0].stdout.emit('data', Buffer.from(payload));
    assert.equal(errors.length, 1); assert.equal(mock.children[0].killCount, 1);
  }
});

test('spawn failures and child exits report once and permit explicit restart', () => {
  const errors = [];
  const capture = new Capture({ region: { x: 0, y: 0 }, onFrame() {}, onError: error => errors.push(error),
    spawn() { throw new Error('spawn unavailable'); } });
  capture.start(); assert.equal(capture.running, false); assert.equal(errors[0].message, 'spawn unavailable');
  const mock = mockSpawn(); capture.spawn = mock.spawn; capture.start();
  mock.children[0].stderr.emit('data', Buffer.from('q'.repeat(10000)));
  mock.children[0].emit('exit', 1);
  assert.equal(errors.length, 2); assert.ok(errors[1].message.length < 4200);
  assert.equal(capture.running, false);
  capture.start(); mock.children[1].emit('error', new Error('native spawn failed'));
  assert.equal(errors.length, 3); capture.stop();
});

test('frame callback failure tears down capture and is reported without repeat delivery', () => {
  const mock = mockSpawn(), errors = [];
  const capture = new Capture({ region: { x: -1920, y: 0 }, spawn: mock.spawn,
    onFrame() { throw new Error('decoder failed'); }, onError: error => errors.push(error) });
  capture.start(); output(mock.children[0], record());
  assert.equal(errors[0].message, 'decoder failed'); assert.equal(capture.running, false);
  assert.equal(mock.children[0].killCount, 1);
});

test('single calibration capture preserves virtual desktop origin and RGBA without requiring foreground', async () => {
  const mock = mockSpawn();
  const pending = captureOnce({ calibration: true, spawn: mock.spawn });
  const args = mock.calls[0][1];
  assert.ok(args.includes('-Calibration')); assert.equal(args[args.indexOf('-Mode') + 1], 'Once');
  const expected = Buffer.from([255, 0, 85, 255, 0, 170, 255, 255]);
  output(mock.children[0], record({ width: 2, height: 1, x: -1920, y: -1080, foreground: false, rgba: expected.toString('base64') }), 30);
  const frame = await pending;
  assert.equal(frame.x, -1920); assert.equal(frame.y, -1080); assert.equal(frame.foreground, false);
  assert.deepEqual(frame.data, expected); assert.equal(mock.children[0].killCount, 1);
});

test('single capture rejects oversized calibration metadata, errors and invalid options', async () => {
  const mock = mockSpawn();
  const pending = captureOnce({ calibration: true, spawn: mock.spawn });
  output(mock.children[0], record({ width: 4001, height: 4000 }));
  await assert.rejects(pending, /dimensions/);
  await assert.rejects(captureOnce({}), /region/);
  await assert.rejects(captureOnce({ calibration: 'yes' }), /options/);
  await assert.rejects(captureOnce({ calibration: true, spawn() { throw new Error('missing powershell'); } }), /missing powershell/);
  await assert.rejects(captureOnce({ calibration: true, spawn() { return {}; } }), /piped output/);
  const errorMock = mockSpawn();
  const failed = captureOnce({ calibration: true, spawn: errorMock.spawn });
  output(errorMock.children[0], { protocol: 1, type: 'error', message: 'Desktop too large' });
  await assert.rejects(failed, /Desktop too large/);
});

test('helper source retains foreground checks around capture and a persistent five-Hz loop', async () => {
  const source = await readFile(new URL('../capture/capture-strip.ps1', import.meta.url), 'utf8');
  assert.match(source, /#Requires -Version 5\.1/);
  // The live client runs as Wow.exe; the beta ran as WowB.exe. The list matches the macOS helper's.
  assert.match(source, /GameProcesses = \{ "Wow", "WowClassic", "WowB", "WowT" \}/);
  assert.match(source, /String\.Equals\(name, game, StringComparison\.OrdinalIgnoreCase\)/);
  assert.match(source, /foregroundBefore -and \$foregroundAfter/);
  assert.match(source, /200 - \[int\]\$cycle\.ElapsedMilliseconds/);
  assert.match(source, /16000000/);
  assert.doesNotMatch(source, /SendKeys|keybd_event|SendInput|ReadProcessMemory|WriteProcessMemory/);
});
