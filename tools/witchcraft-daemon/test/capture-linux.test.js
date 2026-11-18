import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateRegion, validateScale } from '../src/capture.js';

test('a calibrated region keeps its window scale and rejects an invalid one', () => {
  assert.deepEqual(validateRegion({ x: 0, y: 0 }), { x: 0, y: 0, width: 132, height: 12 });
  assert.deepEqual(validateRegion({ x: 0, y: 0, scale: 1.511 }), { x: 0, y: 0, width: 132, height: 12, scale: 1.511 });
  for (const scale of [0.5, 4.5, '1.5', Number.NaN]) assert.throws(() => validateScale(scale), RangeError);
});

// The helper's sampling map is pure arithmetic, so it is checked wherever python3 exists.
const python = (() => { try { execFileSync('python3', ['--version']); return true; } catch { return false; } })();
test('the Linux helper samples every game pixel inside its own upscaled cell', { skip: !python }, () => {
  const helper = fileURLToPath(new URL('../capture/capture-strip.py', import.meta.url));
  const script = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('helper', sys.argv[1]); helper = importlib.util.module_from_spec(spec); spec.loader.exec_module(helper)
print(json.dumps({str(s): [helper.real_pixel(v, s) for v in range(132)] for s in (1, 1.5, 1.511, 2, 3)}))`;
  const maps = JSON.parse(execFileSync('python3', ['-c', script, helper], { encoding: 'utf8' }));
  assert.deepEqual(maps['1'], Array.from({ length: 132 }, (_, v) => v));
  for (const [scale, map] of Object.entries(maps)) {
    if (scale === '1') continue;
    const cell = 6 * Number(scale);
    map.forEach((pixel, v) => {
      const start = Math.floor(v / 6) * cell;
      assert.ok(pixel >= start + 1 && pixel + 1 <= start + cell - 1, `scale ${scale}: game pixel ${v} read from blended edge pixel ${pixel}`);
      if (v) assert.ok(pixel > map[v - 1], `scale ${scale}: game pixel ${v} does not advance`);
    });
  }
});

// Runs a Python body with the helper imported as `helper` and returns its printed JSON.
const helperPath = fileURLToPath(new URL('../capture/capture-strip.py', import.meta.url));
function runHelper(body) {
  const script = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('helper', sys.argv[1]); helper = importlib.util.module_from_spec(spec); spec.loader.exec_module(helper)
${body}`;
  return JSON.parse(execFileSync('python3', ['-c', script, helperPath], { encoding: 'utf8' }));
}

test('the Linux calibration capture keeps its last game pixel inside the window', { skip: !python }, () => {
  const result = runHelper(`
failures = []
for window in (1280, 1366, 1600, 1920, 2560, 3440, 3840, 5120):
    for step in range(1000, 4000):
        scale = step / 1000
        width, height = helper.calibration_size(window, window, scale)
        for size in (width, height):
            if size < 1 or helper.real_pixel(size - 1, scale) >= window:
                failures.append([window, scale, size])
width, _ = helper.calibration_size(3440, 1440, 1.007)
print(json.dumps({"failures": failures[:20], "count": len(failures),
                  "regression": [width, helper.real_pixel(width - 1, 1.007)]}))`);
  assert.equal(result.count, 0, `out-of-window sizes (window, scale, size): ${JSON.stringify(result.failures)}`);
  const [width, last] = result.regression;
  assert.ok(width >= 1 && last < 3440, `3440 at 1.007: width ${width} reads window pixel ${last}`);
});

test('the Linux helper measures an unscaled strip as exactly 1 and a 1.5x strip near 1.5', { skip: !python }, () => {
  const result = runHelper(`
cells = helper.calibration_cells()
class Fake:
    def __init__(self, scale):
        self.scale = scale
    def grab(self, x, y, width, height):
        row = []
        for p in range(x, x + width):
            cell = int(p / self.scale) // 6
            r, g, b = cells[cell] if cell < len(cells) else (0, 0, 0)
            row.append((r << 16) | (g << 8) | b)
        return row
print(json.dumps({"one": helper.measure_scale(Fake(1), 3840), "half": helper.measure_scale(Fake(1.5), 3840)}))`);
  assert.equal(result.one, 1);
  assert.ok(result.half !== null && Math.abs(result.half - 1.5) <= 0.02, `1.5x strip measured ${result.half}`);
});

test('the Linux helper accepts only the game process name', { skip: !python }, () => {
  const result = runHelper(`
names = ['WowB.exe\\n', 'wowb.exe', 'wine64-preloader', 'chrome', 'firefox', '', 'python3']
print(json.dumps({name: helper.game_process(name) for name in names}))`);
  assert.deepEqual(result, {
    'WowB.exe\n': true, 'wowb.exe': true, 'wine64-preloader': false,
    chrome: false, firefox: false, '': false, python3: false,
  });
});

test('a failed grab is an idle record in Stream mode and an error in Once mode', { skip: !python }, () => {
  const result = runHelper(`
class Fake:
    def focused(self):
        return True
    def grab(self, x, y, width, height):
        raise helper.GrabFailed("The game window could not be read. Keep it visible and not minimized.")
stream = helper.frame_record(Fake(), "Stream", 0, 0, 132, 12, 1.0)
try:
    helper.frame_record(Fake(), "Once", 0, 0, 132, 12, 1.0)
    once = None
except helper.GrabFailed as error:
    once = str(error)
print(json.dumps({"stream": stream, "once": once}))`);
  assert.deepEqual(result.stream, { protocol: 1, type: 'idle', foreground: false });
  assert.ok(typeof result.once === 'string' && result.once.length > 0, 'Once mode must raise GrabFailed');
});
