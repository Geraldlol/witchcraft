import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateRegion, validateScale } from '../src/capture.js';
import { calibrate, decodeHeartbeat, encodeHeartbeat } from '../src/pixel.js';

test('a calibrated region keeps its window scale and rejects an invalid one', () => {
  assert.deepEqual(validateRegion({ x: 0, y: 0 }), { x: 0, y: 0, width: 132, height: 12 });
  assert.deepEqual(validateRegion({ x: 0, y: 0, scale: 1.511 }), { x: 0, y: 0, width: 132, height: 12, scale: 1.511 });
  assert.deepEqual(validateRegion({ x: 0, y: 0, scale: 0.5 }), { x: 0, y: 0, width: 132, height: 12, scale: 0.5 });
  for (const scale of [0.49, 4.5, '1.5', Number.NaN]) assert.throws(() => validateScale(scale), RangeError);
});

// The helper's sampling map is pure arithmetic, so it is checked wherever Python 3 exists.
const python = ['python3', 'python', 'py'].find(cmd => {
  try { return /^Python 3\./u.test(execFileSync(cmd, ['--version'], { encoding: 'utf8' })); } catch { return false; }
}) ?? null;
test('the Linux helper samples every game pixel inside its own upscaled cell', { skip: !python }, () => {
  const helper = fileURLToPath(new URL('../capture/capture-strip.py', import.meta.url));
  const script = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('helper', sys.argv[1]); helper = importlib.util.module_from_spec(spec); spec.loader.exec_module(helper)
print(json.dumps({str(s): [helper.real_pixel(v, s) for v in range(132)] for s in (1, 1.5, 1.511, 2, 3)}))`;
  const maps = JSON.parse(execFileSync(python, ['-c', script, helper], { encoding: 'utf8' }));
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
  return JSON.parse(execFileSync(python, ['-c', script, helperPath], { encoding: 'utf8' }));
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
print(json.dumps({"one": helper.measure_scale(Fake(1), 3840), "half": helper.measure_scale(Fake(1.5), 3840),
                  "two": helper.measure_scale(Fake(2), 3840), "near_two": helper.measure_scale(Fake(1.985), 3840)}))`);
  assert.equal(result.one, 1);
  assert.ok(result.half !== null && Math.abs(result.half - 1.5) <= 0.02, `1.5x strip measured ${result.half}`);
  assert.ok(result.two !== null && Math.abs(result.two - 2) <= 0.02, `2x strip measured ${result.two}`);
  // A true 1.985 also passes at exactly 2.0; the row-4 scan must return the run middle, not 2.0.
  assert.ok(result.near_two !== null && result.near_two !== 2 && Math.abs(result.near_two - 1.985) <= 0.01,
    `1.985x strip measured ${result.near_two}`);
});

// A strip below a title bar: the header row, then a heartbeat row, each 6 * scale window pixels tall.
const TITLE_BAR_STRIP = heartbeat => `
from array import array
cells = helper.calibration_cells()
hb = ${JSON.stringify(heartbeat)}
class Strip:
    def __init__(self, scale, top, title_bar, size=(1280, 400)):
        self.scale, self.top, self.win = scale, top, size
        if title_bar:
            self.TITLE_BAR = True
    def focused(self):
        return True
    def size(self, window=None):
        return self.win
    def grab(self, x, y, width, height):
        out = array("I")
        for py in range(y, y + height):
            band = int((py - self.top) // (6 * self.scale)) if py >= self.top else -1
            for p in range(x, x + width):
                cell = int(p / self.scale) // 6
                r, g, b = (19, 19, 19)
                if cell < len(cells) and band == 0:
                    r, g, b = cells[cell]
                elif cell < len(cells) and band == 1:
                    r, g, b = hb[cell]
                out.append((r << 16) | (g << 8) | b)
        return out
`;

test('the title-bar band scan runs only on a TITLE_BAR screen', { skip: !python }, () => {
  const result = runHelper(`${TITLE_BAR_STRIP(encodeHeartbeat('0123abcd', 71, 1, '12345678'))}
print(json.dumps({"linux": helper.measure_scale(Strip(1, 30, False), 1280, 400),
                  "aligned": helper.measure_scale(Strip(2, 48, True), 1280, 400),
                  "one": helper.measure_scale(Strip(1, 28, True), 1280, 400),
                  "mac_attr": helper.MacScreen.TITLE_BAR, "linux_attr": getattr(helper.Screen, "TITLE_BAR", False)}))`);
  assert.equal(result.linux, null);
  assert.ok(result.aligned !== null && Math.abs(result.aligned - 2) <= 0.02, `2x strip at row 48 measured ${result.aligned}`);
  assert.equal(result.one, 1);
  assert.equal(result.mac_attr, true);
  assert.equal(result.linux_attr, false);
});

// End to end below a title bar: measure_scale, a calibration frame, the Node locator, then a
// Stream frame at the located anchor whose second row must decode as the heartbeat.
// The window must be wider than the strip (132 game pixels times the scale).
for (const [label, scale, top, anchor, windowWidth] of [
  ['a 2x strip on the cell grid', 2, 48, 24, 320],
  ['a 2x strip off the cell grid (header at row 55)', 2, 55, 28, 320],
  ['a 2.5x strip off the cell grid (header at row 35)', 2.5, 35, 14, 400],
]) {
  test(`${label} below a title bar calibrates and decodes end to end`, { skip: !python }, () => {
    const heartbeat = encodeHeartbeat('0123abcd', 71, 1, '12345678');
    const result = runHelper(`${TITLE_BAR_STRIP(heartbeat)}
screen = Strip(${scale}, ${top}, True, (${windowWidth}, 200))
scale = helper.measure_scale(screen, ${windowWidth}, 200)
cal = helper.cycle_record(screen, "Once", 0, 0, 132, 12, scale, calibration=True)
print(json.dumps({"scale": scale, "cal": cal}))`);
    assert.ok(Math.abs(result.scale - scale) <= 0.02, `measured ${result.scale}`);
    const found = calibrate({ width: result.cal.width, height: result.cal.height, data: Buffer.from(result.cal.rgba, 'base64') });
    assert.deepEqual(found, { x: 0, y: anchor, width: 132, height: 12, cellSize: 6 });
    const stream = runHelper(`${TITLE_BAR_STRIP(heartbeat)}
print(json.dumps(helper.cycle_record(Strip(${scale}, ${top}, True, (${windowWidth}, 200)), "Stream", ${found.x}, ${found.y}, 132, 12, ${result.scale})))`);
    assert.equal(stream.type, 'frame');
    const data = Buffer.from(stream.rgba, 'base64');
    const row = Array.from({ length: 22 }, (_, i) => {
      const offset = ((6 + 3) * 132 + i * 6 + 3) * 4;
      return [data[offset], data[offset + 1], data[offset + 2]];
    });
    assert.deepEqual(decodeHeartbeat(row), {
      epoch: '0123abcd', uiNonce: '12345678', nextSeq: 71, flags: 1, combat: true, reload: false,
    });
  });
}

test('a strip outside the window is an idle with reason outside in Stream mode and an error in Once mode', { skip: !python }, () => {
  const result = runHelper(`
from array import array
class Small:
    def focused(self): return True
    def size(self, window=None): return 100, 50
    def grab(self, x, y, width, height): return array("I", [0] * (width * height))
stream = helper.cycle_record(Small(), "Stream", 0, 0, 132, 12, 1.0)
try:
    helper.cycle_record(Small(), "Once", 0, 0, 132, 12, 1.0)
    once = None
except RuntimeError as error:
    once = str(error)
class Unfocused(Small):
    def focused(self): return False
print(json.dumps({"stream": stream, "once": once, "plain": helper.cycle_record(Unfocused(), "Stream", 0, 0, 132, 12, 1.0)}))`);
  assert.deepEqual(result.stream, { protocol: 1, type: 'idle', foreground: false, reason: 'outside' });
  assert.match(result.once, /outside the game window/u);
  assert.deepEqual(result.plain, { protocol: 1, type: 'idle', foreground: false });
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

test('the macOS Quartz helper accepts only normal-layer World of Warcraft windows', { skip: !python }, () => {
  const result = runHelper(`
bounds = {"X": 0, "Y": 25, "Width": 2560, "Height": 1440}
cases = {
    "native": {"kCGWindowLayer": 0, "kCGWindowOwnerName": "World of Warcraft", "kCGWindowName": "World of Warcraft", "kCGWindowBounds": bounds},
    "unlisted_title": {"kCGWindowLayer": 0, "kCGWindowOwnerName": "World of Warcraft", "kCGWindowBounds": bounds},
    "crossover": {"kCGWindowLayer": 0, "kCGWindowOwnerName": "WowB.exe", "kCGWindowName": "World of Warcraft", "kCGWindowBounds": bounds},
    "wrong_title": {"kCGWindowLayer": 0, "kCGWindowOwnerName": "World of Warcraft", "kCGWindowName": "Crash Reporter", "kCGWindowBounds": bounds},
    "overlay_layer": {"kCGWindowLayer": 25, "kCGWindowOwnerName": "World of Warcraft", "kCGWindowName": "World of Warcraft", "kCGWindowBounds": bounds},
    "tiny": {"kCGWindowLayer": 0, "kCGWindowOwnerName": "World of Warcraft", "kCGWindowName": "World of Warcraft", "kCGWindowBounds": {"Width": 64, "Height": 10}},
    "other_app": {"kCGWindowLayer": 0, "kCGWindowOwnerName": "Safari", "kCGWindowName": "World of Warcraft", "kCGWindowBounds": bounds},
    "classic": {"kCGWindowLayer": 0, "kCGWindowOwnerName": "World of Warcraft Classic", "kCGWindowBounds": bounds},
    "wow": {"kCGWindowLayer": 0, "kCGWindowOwnerName": "Wow", "kCGWindowBounds": bounds},
    "wowza": {"kCGWindowLayer": 0, "kCGWindowOwnerName": "Wowza", "kCGWindowBounds": bounds},
    "wowup": {"kCGWindowLayer": 0, "kCGWindowOwnerName": "WowUp", "kCGWindowBounds": bounds},
}
print(json.dumps({k: helper.mac_game_window(v) for k, v in cases.items()}))`);
  assert.deepEqual(result, {
    native: true,
    unlisted_title: true,
    crossover: true,
    wrong_title: false,
    overlay_layer: false,
    tiny: false,
    other_app: false,
    classic: true,
    wow: true,
    wowza: false,
    wowup: false,
  });
});

test('the macOS Quartz helper loads CoreGraphics and enumerates window records on darwin', { skip: !python || process.platform !== 'darwin' }, () => {
  const result = runHelper(`
screen = helper.MacScreen.__new__(helper.MacScreen)
try:
    helper.MacScreen.__init__(screen)
except RuntimeError as error:
    if "No World of Warcraft window found" not in str(error):
        raise
windows = screen._windows()
print(json.dumps({"is_list": isinstance(windows, list)}))`);
  assert.equal(result.is_list, true);
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

test('hiding the macOS game window idles instead of exiting and resumes when the same window returns', { skip: !python }, () => {
  const result = runHelper(`
from array import array
wow = {"kCGWindowNumber": 42, "kCGWindowOwnerPID": 777, "kCGWindowLayer": 0,
       "kCGWindowOwnerName": "World of Warcraft", "kCGWindowName": "World of Warcraft",
       "kCGWindowBounds": {"X": 10, "Y": 20, "Width": 1280, "Height": 720}}
safari = {"kCGWindowNumber": 99, "kCGWindowOwnerPID": 888, "kCGWindowLayer": 0,
          "kCGWindowOwnerName": "Safari", "kCGWindowName": "Docs",
          "kCGWindowBounds": {"X": 0, "Y": 0, "Width": 1200, "Height": 800}}
wow_moved = {**wow, "kCGWindowBounds": {"X": 50, "Y": 60, "Width": 1280, "Height": 720}}

screen = helper.MacScreen.__new__(helper.MacScreen)
screen._bounds = dict(wow["kCGWindowBounds"])
screen._backing = 1.0
screen.pid = 777
screen.window = 42
now = [100.0]
screen.clock = lambda: now[0]
current_windows = [wow]
screen._windows = lambda on_screen_only=True: list(current_windows)
screen._refresh_backing = lambda: None
screen.grab = lambda x, y, width, height: array("I", [0x0055AAFF] * (width * height))
def cycle(mode="Stream"):
    now[0] += 0.25
    return helper.cycle_record(screen, mode, 0, 0, 132, 12, 1.0)

r1 = cycle()
# Hidden via Cmd+H: disappears from on-screen window list completely.
current_windows = []
r2 = cycle()
# Even if focused() raced and returned True just as the window vanished from size():
screen_race = helper.MacScreen.__new__(helper.MacScreen)
screen_race._bounds = dict(wow["kCGWindowBounds"])
screen_race._backing = 1.0
screen_race.pid = 777
screen_race.window = 42
screen_race._windows = lambda on_screen_only=True: []
screen_race.focused = lambda: True
r_race = helper.cycle_record(screen_race, "Stream", 0, 0, 132, 12, 1.0)
try:
    helper.cycle_record(screen_race, "Once", 0, 0, 132, 12, 1.0)
    once_hidden = None
except helper.GrabFailed as err:
    once_hidden = str(err)
# Unhidden behind Safari: still unfocused -> idle.
current_windows = [safari, wow]
r3 = cycle()
# Focused again at new position -> resumes streaming frames and updates bounds!
current_windows = [wow_moved]
r4 = cycle()
print(json.dumps({
    "r1": r1["type"], "r2": r2, "r_race": r_race, "once_hidden": once_hidden,
    "r3": r3, "r4": r4["type"], "bounds_x": screen._bounds["X"],
}))`);
  assert.equal(result.r1, 'frame');
  assert.deepEqual(result.r2, { protocol: 1, type: 'idle', foreground: false });
  assert.deepEqual(result.r_race, { protocol: 1, type: 'idle', foreground: false });
  assert.match(result.once_hidden, /not on screen/u);
  assert.deepEqual(result.r3, { protocol: 1, type: 'idle', foreground: false });
  assert.equal(result.r4, 'frame');
  assert.equal(result.bounds_x, 50);
});

test('3-point-per-cell Retina strip calibrates and decodes end-to-end (at origin and below a title bar)', { skip: !python }, () => {
  const heartbeat = encodeHeartbeat('0123abcd', 71, 1, '12345678');
  for (const titleBarPoints of [0, 28]) {
    const result = runHelper(`
from array import array
cells = helper.calibration_cells()
hb = ${JSON.stringify(heartbeat)}
win_w, win_h = 320, 120
top_y = ${titleBarPoints}

class ThreePointRetina:
    TITLE_BAR = True
    def focused(self):
        return True
    def size(self, window=None):
        return win_w, win_h
    def grab(self, x, y, width, height):
        out = array("I")
        for py in range(y, y + height):
            rel_y = py - top_y
            for px in range(x, x + width):
                cell = px // 3
                if 0 <= rel_y < 3 and 0 <= cell < 22:
                    r, g, b = cells[cell]
                elif 3 <= rel_y < 6 and 0 <= cell < 22:
                    r, g, b = hb[cell]
                else:
                    r, g, b = (19, 19, 19)
                out.append((r << 16) | (g << 8) | b)
        return out

screen = ThreePointRetina()
scale = helper.measure_scale(screen, win_w, win_h)
cal = helper.cycle_record(screen, "Once", 0, 0, 132, 12, scale, calibration=True)
print(json.dumps({"scale": scale, "cal": cal}))`);
    assert.equal(result.scale, 0.5, `titleBar=${titleBarPoints}: expected 0.5 scale, got ${result.scale}`);
    const image = {
      width: result.cal.width,
      height: result.cal.height,
      data: Buffer.from(result.cal.rgba, 'base64'),
    };
    const found = calibrate(image);
    assert.deepEqual(found, { x: 0, y: titleBarPoints * 2, width: 132, height: 12, cellSize: 6 });
    const stream = runHelper(`
from array import array
cells = helper.calibration_cells()
hb = ${JSON.stringify(heartbeat)}
top_y = ${titleBarPoints}
class ThreePointRetina:
    def focused(self): return True
    def size(self, window=None): return 320, 120
    def grab(self, x, y, width, height):
        out = array("I")
        for py in range(y, y + height):
            rel_y = py - top_y
            for px in range(x, x + width):
                cell = px // 3
                r, g, b = cells[cell] if (0 <= rel_y < 3 and 0 <= cell < 22) else (hb[cell] if (3 <= rel_y < 6 and 0 <= cell < 22) else (19, 19, 19))
                out.append((r << 16) | (g << 8) | b)
        return out
print(json.dumps(helper.cycle_record(ThreePointRetina(), "Stream", ${found.x}, ${found.y}, 132, 12, ${result.scale})))`);
    assert.equal(stream.type, 'frame');
    const streamData = Buffer.from(stream.rgba, 'base64');
    const sampledRow1 = Array.from({ length: 22 }, (_, i) => {
      const offset = ((6 + 3) * 132 + i * 6 + 3) * 4;
      return [streamData[offset], streamData[offset + 1], streamData[offset + 2]];
    });
    assert.deepEqual(decodeHeartbeat(sampledRow1), {
      epoch: '0123abcd',
      uiNonce: '12345678',
      nextSeq: 71,
      flags: 1,
      combat: true,
      reload: false,
    });
  }
});

const MAC_WINDOWS = `
from array import array
wow = {"kCGWindowNumber": 42, "kCGWindowOwnerPID": 777, "kCGWindowLayer": 0,
       "kCGWindowOwnerName": "World of Warcraft", "kCGWindowName": "World of Warcraft",
       "kCGWindowBounds": {"X": 10, "Y": 20, "Width": 1280, "Height": 720}}
wow_new = {**wow, "kCGWindowNumber": 43, "kCGWindowOwnerPID": 999}
safari = {"kCGWindowNumber": 99, "kCGWindowOwnerPID": 888, "kCGWindowLayer": 0,
          "kCGWindowOwnerName": "Safari", "kCGWindowName": "Docs",
          "kCGWindowBounds": {"X": 0, "Y": 0, "Width": 1200, "Height": 800}}
def mac_screen(window=42, pid=777):
    screen = helper.MacScreen.__new__(helper.MacScreen)
    screen._bounds = dict(wow["kCGWindowBounds"])
    screen._backing = 1.0
    screen.pid = pid
    screen.window = window
    screen.now = [100.0]
    screen.clock = lambda: screen.now[0]
    return screen
`;

test('the macOS helper adopts the new game window after a restart, but never an overridden one', { skip: !python }, () => {
  const result = runHelper(`${MAC_WINDOWS}
import os
os.environ.pop("WITCHCRAFT_WINDOW_ID", None)
def run(screen):
    lists = {"on": [wow], "all": [wow]}
    screen._windows = lambda on_screen_only=True: list(lists["on"] if on_screen_only else lists["all"])
    screen._refresh_backing = lambda: None
    grabbed = []
    def grab(x, y, width, height):
        grabbed.append(screen.window)
        return array("I", [0] * (width * height))
    screen.grab = grab
    def cycle(step=0.25):
        screen.now[0] += step
        return helper.cycle_record(screen, "Stream", 0, 0, 132, 12, 1.0)["type"]
    out = {"start": cycle()}
    # Hidden or on another Space: gone from the on-screen list, still in the all-windows list.
    lists["on"], lists["all"] = [wow_new], [wow_new, wow]
    out["hidden"] = [cycle(1.0), cycle(1.0), screen.window]
    # The game restarted: the old number is gone everywhere.
    lists["all"] = [wow_new]
    out["throttled"] = [cycle(), screen.window]
    out["restart"] = [cycle(1.0), cycle(), cycle(), screen.window, grabbed[-1], screen.pid]
    return out
plain = run(mac_screen())
os.environ["WITCHCRAFT_WINDOW_ID"] = "42"
pinned = run(mac_screen())
print(json.dumps({"plain": plain, "pinned": pinned}))`);
  assert.deepEqual(result.plain, {
    start: 'frame', hidden: ['idle', 'idle', 42], throttled: ['idle', 42],
    restart: ['idle', 'frame', 'frame', 43, 43, 999],
  });
  assert.deepEqual(result.pinned, {
    start: 'frame', hidden: ['idle', 'idle', 42], throttled: ['idle', 42],
    restart: ['idle', 'idle', 'idle', 42, 42, 777],
  });
});

test('a steady macOS Stream cycle reads the window list twice and a probe cycle three times, and still sees focus lost during the read',{ skip: !python }, () => {
  const result = runHelper(`${MAC_WINDOWS}
screen = mac_screen()
state = {"windows": [wow], "reads": 0, "images": 0, "steal_focus": False}
def windows(on_screen_only=True):
    state["reads"] += 1
    return list(state["windows"])
screen._windows = windows
class FakeCG:
    def CGWindowListCreateImage(self, rect, flags, window, options):
        state["images"] += 1
        if state["steal_focus"]:
            state["windows"] = [safari, wow]
        return (int(rect.size.width), int(rect.size.height))
    def CGImageGetWidth(self, image): return image[0]
    def CGImageGetHeight(self, image): return image[1]
    def CGColorSpaceCreateDeviceRGB(self): return 1
    def CGColorSpaceRelease(self, space): pass
    def CGBitmapContextCreate(self, *args): return 1
    def CGContextDrawImage(self, ctx, rect, image): pass
    def CGContextRelease(self, ctx): pass
    def CGImageRelease(self, image): pass
screen.cg = FakeCG()
def cycle(step):
    screen.now[0] += step
    state["reads"] = state["images"] = 0
    record = helper.cycle_record(screen, "Stream", 0, 0, 132, 12, 1.0)
    return [record["type"], state["reads"], state["images"]]
out = {"first": cycle(0.25), "steady": cycle(0.25), "second_later": cycle(1.0)}
state["steal_focus"] = True
out["focus_lost"] = cycle(0.25)
print(json.dumps(out))`);
  // The first cycle probes the backing scale; afterwards only a moved window or a second does.
  // The probe is an image capture and drops the window list, so a probe cycle reads it three times.
  assert.deepEqual(result.first, ['frame', 3, 2]);
  assert.deepEqual(result.steady, ['frame', 2, 1]);
  assert.deepEqual(result.second_later, ['frame', 3, 2]);
  assert.deepEqual(result.focus_lost, ['idle', 2, 1]);
});

test('a macOS cycle sees focus lost during the backing probe and never reads the strip', { skip: !python }, () => {
  const result = runHelper(`${MAC_WINDOWS}
screen = mac_screen()
state = {"windows": [wow], "reads": 0, "images": 0, "armed": False}
def windows(on_screen_only=True):
    state["reads"] += 1
    return list(state["windows"])
screen._windows = windows
class FakeCG:
    def CGWindowListCreateImage(self, rect, flags, window, options):
        state["images"] += 1
        if rect.size.width == 1 and rect.size.height == 1:
            if state["armed"]:
                state["windows"] = [safari, wow]
        else:
            state["windows"] = [wow]
        return (int(rect.size.width), int(rect.size.height))
    def CGImageGetWidth(self, image): return image[0]
    def CGImageGetHeight(self, image): return image[1]
    def CGColorSpaceCreateDeviceRGB(self): return 1
    def CGColorSpaceRelease(self, space): pass
    def CGBitmapContextCreate(self, *args): return 1
    def CGContextDrawImage(self, ctx, rect, image): pass
    def CGContextRelease(self, ctx): pass
    def CGImageRelease(self, image): pass
screen.cg = FakeCG()
def cycle(step):
    screen.now[0] += step
    state["reads"] = state["images"] = 0
    record = helper.cycle_record(screen, "Stream", 0, 0, 132, 12, 1.0)
    return [record["type"], state["reads"], state["images"]]
out = {"settle": cycle(0.25)}
# Another app comes to the front during the probe; the strip read would bring the game back.
state["armed"] = True
out["probe"] = cycle(1.0)
print(json.dumps(out))`);
  assert.equal(result.settle[0], 'frame');
  assert.deepEqual(result.probe, ['idle', 2, 1]);
});

test('a macOS cycle never reuses the previous cycle\'s window list for its focus check', { skip: !python }, () => {
  const result = runHelper(`${MAC_WINDOWS}
screen = mac_screen()
state = {"windows": [wow], "reads": 0, "images": 0, "restore_focus": False}
def windows(on_screen_only=True):
    state["reads"] += 1
    return list(state["windows"])
screen._windows = windows
screen._refresh_backing = lambda: None
class FakeCG:
    def CGWindowListCreateImage(self, rect, flags, window, options):
        state["images"] += 1
        if state["restore_focus"]:
            state["windows"] = [wow]
        return (int(rect.size.width), int(rect.size.height))
    def CGImageGetWidth(self, image): return image[0]
    def CGImageGetHeight(self, image): return image[1]
    def CGColorSpaceCreateDeviceRGB(self): return 1
    def CGColorSpaceRelease(self, space): pass
    def CGBitmapContextCreate(self, *args): return 1
    def CGContextDrawImage(self, ctx, rect, image): pass
    def CGContextRelease(self, ctx): pass
    def CGImageRelease(self, image): pass
screen.cg = FakeCG()
def cycle(step):
    screen.now[0] += step
    state["reads"] = state["images"] = 0
    record = helper.cycle_record(screen, "Stream", 0, 0, 132, 12, 1.0)
    return [record["type"], state["reads"], state["images"]]
out = {"first": cycle(0.25)}
# Another app comes to the front between cycles, well inside LIST_TTL; a grab would bring the game back.
state["windows"], state["restore_focus"] = [safari, wow], True
out["unfocused"] = cycle(0.001)
print(json.dumps(out))`);
  assert.deepEqual(result.first, ['frame', 2, 1]);
  assert.deepEqual(result.unfocused, ['idle', 1, 0]);
});

test('a macOS grab whose display density changed since the probe captures once more, and a second change is an idle', { skip: !python }, () => {
  const result = runHelper(`${MAC_WINDOWS}
def run(backing, densities, mode="Stream"):
    screen = mac_screen()
    screen._backing = backing
    screen._windows = lambda on_screen_only=True: [wow]
    screen._refresh_backing = lambda: None  # the density changes between backing probes
    state = {"rects": [], "released": 0}
    class FakeCG:
        def CGWindowListCreateImage(self, rect, flags, window, options):
            density = densities[len(state["rects"]) % len(densities)]
            state["rects"].append([rect.origin.x, rect.origin.y, rect.size.width, rect.size.height])
            return (int(rect.size.width * density), int(rect.size.height * density))
        def CGImageGetWidth(self, image): return image[0]
        def CGImageGetHeight(self, image): return image[1]
        def CGColorSpaceCreateDeviceRGB(self): return 1
        def CGColorSpaceRelease(self, space): pass
        def CGBitmapContextCreate(self, *args): return 1
        def CGContextDrawImage(self, ctx, rect, image): pass
        def CGContextRelease(self, ctx): pass
        def CGImageRelease(self, image): state["released"] += 1
    screen.cg = FakeCG()
    try:
        record = helper.cycle_record(screen, mode, 0, 0, 132, 12, 1.0)["type"]
    except helper.GrabFailed as error:
        record = "raised: " + str(error)
    return {"record": record, "rects": state["rects"], "released": state["released"], "backing": screen._backing}
print(json.dumps({"down": run(2.0, [1]), "up": run(1.0, [2]), "flip": run(2.0, [1, 2]),
                  "flip_once": run(2.0, [1, 2], "Once")}))`);
  // Bounds X 10, Y 20. Density 1 under a stale 2.0: half the strip asked for, then the full strip in points.
  assert.deepEqual(result.down, { record: 'frame', rects: [[10, 20, 66, 6], [10, 20, 132, 12]], released: 2, backing: 1 });
  assert.deepEqual(result.up, { record: 'frame', rects: [[10, 20, 132, 12], [10, 20, 66, 6]], released: 2, backing: 2 });
  assert.equal(result.flip.record, 'idle');
  assert.equal(result.flip.rects.length, 2);
  assert.equal(result.flip.released, 2);
  assert.equal(result.flip_once.record, 'raised: The game window changed display scale during the read. Keep it on one display.');
  assert.equal(result.flip_once.released, 2);
});
