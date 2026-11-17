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
