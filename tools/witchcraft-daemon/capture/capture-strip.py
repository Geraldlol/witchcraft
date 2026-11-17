#!/usr/bin/env python3
"""Read-only capture of the Witchcraft strip for Linux (X11 or XWayland).

Speaks the same JSON-lines protocol as capture-strip.ps1. Coordinates are relative to the
game window, in game pixels: -Scale is window pixels per game pixel, so a client rendering
2560x1440 into a 3840x2160 window uses 1.5 and each sampled pixel is the centre of its
upscaled block. Frames are refused unless the game window holds X input focus.

The window is found by title ("World of Warcraft"); WITCHCRAFT_WINDOW_ID overrides it.
"""
import argparse
import base64
import ctypes
import ctypes.util
import json
import os
import sys
import time
from array import array

MAX_PIXELS = 16_000_000
TITLE = b"World of Warcraft"
ZPIXMAP, ALL_PLANES = 2, ctypes.c_ulong(-1).value


class XImage(ctypes.Structure):
    pass


XImage._fields_ = [
    ("width", ctypes.c_int), ("height", ctypes.c_int), ("xoffset", ctypes.c_int), ("format", ctypes.c_int),
    ("data", ctypes.POINTER(ctypes.c_ubyte)), ("byte_order", ctypes.c_int), ("bitmap_unit", ctypes.c_int),
    ("bitmap_bit_order", ctypes.c_int), ("bitmap_pad", ctypes.c_int), ("depth", ctypes.c_int),
    ("bytes_per_line", ctypes.c_int), ("bits_per_pixel", ctypes.c_int),
    ("red_mask", ctypes.c_ulong), ("green_mask", ctypes.c_ulong), ("blue_mask", ctypes.c_ulong),
    ("obdata", ctypes.c_void_p), ("create_image", ctypes.c_void_p),
    ("destroy_image", ctypes.CFUNCTYPE(ctypes.c_int, ctypes.POINTER(XImage))),
]


class XWindowAttributes(ctypes.Structure):
    _fields_ = [("x", ctypes.c_int), ("y", ctypes.c_int), ("width", ctypes.c_int), ("height", ctypes.c_int),
                ("border_width", ctypes.c_int), ("depth", ctypes.c_int), ("pad", ctypes.c_byte * 256)]


def write(record):
    sys.stdout.write(json.dumps(record, separators=(",", ":")) + "\n")
    sys.stdout.flush()


class Screen:
    def __init__(self):
        name = ctypes.util.find_library("X11")
        if not name:
            raise RuntimeError("libX11 was not found")
        x = self.x = ctypes.CDLL(name)
        x.XOpenDisplay.restype = ctypes.c_void_p
        x.XOpenDisplay.argtypes = [ctypes.c_char_p]
        x.XDefaultRootWindow.restype = ctypes.c_ulong
        x.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
        x.XGetImage.restype = ctypes.POINTER(XImage)
        x.XGetImage.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_int, ctypes.c_uint,
                                ctypes.c_uint, ctypes.c_ulong, ctypes.c_int]
        x.XQueryTree.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong),
                                 ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.POINTER(ctypes.c_ulong)),
                                 ctypes.POINTER(ctypes.c_uint)]
        x.XFetchName.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(ctypes.c_char_p)]
        x.XFree.argtypes = [ctypes.c_void_p]
        x.XGetInputFocus.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_int)]
        x.XGetWindowAttributes.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(XWindowAttributes)]
        x.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
        self.failed = False
        handler = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p)(self._error)
        self._handler = handler  # keep the callback alive
        x.XSetErrorHandler(handler)
        self.display = x.XOpenDisplay(None)
        if not self.display:
            raise RuntimeError("No X display. The game must run under X11 or XWayland and DISPLAY must be set.")
        self.root = x.XDefaultRootWindow(self.display)
        self.window = self._find()

    def _error(self, _display, _event):
        self.failed = True
        return 0

    def _children(self, window):
        root, parent, count = ctypes.c_ulong(), ctypes.c_ulong(), ctypes.c_uint()
        kids = ctypes.POINTER(ctypes.c_ulong)()
        if not self.x.XQueryTree(self.display, window, ctypes.byref(root), ctypes.byref(parent),
                                 ctypes.byref(kids), ctypes.byref(count)):
            return [], 0
        found = [kids[i] for i in range(count.value)]
        if kids:
            self.x.XFree(kids)
        return found, parent.value

    def _name(self, window):
        name = ctypes.c_char_p()
        self.x.XFetchName(self.display, window, ctypes.byref(name))
        value = name.value
        if name:
            self.x.XFree(name)
        return value

    def _find(self):
        override = os.environ.get("WITCHCRAFT_WINDOW_ID")
        if override:
            return int(override, 0)
        best, queue, seen = None, [self.root], 0
        while queue and seen < 4096:
            window = queue.pop(0)
            seen += 1
            kids, _ = self._children(window)
            queue.extend(kids)
            if self._name(window) == TITLE:
                width, height = self.size(window)
                if width * height > (best[1] if best else 0):
                    best = (window, width * height)
        if not best:
            raise RuntimeError("No World of Warcraft window found. Start the game, or set WITCHCRAFT_WINDOW_ID.")
        return best[0]

    def size(self, window=None):
        attributes = XWindowAttributes()
        self.failed = False
        ok = self.x.XGetWindowAttributes(self.display, window or self.window, ctypes.byref(attributes))
        if not ok or self.failed:
            raise RuntimeError("The game window is gone. Start the game and try again.")
        return attributes.width, attributes.height

    def focused(self):
        focus, revert = ctypes.c_ulong(), ctypes.c_int()
        self.x.XGetInputFocus(self.display, ctypes.byref(focus), ctypes.byref(revert))
        window, hops = focus.value, 0
        while window > 1 and hops < 32:  # 0 is None and 1 is PointerRoot
            if window == self.window:
                return True
            _, window = self._children(window)
            hops += 1
        return False

    def grab(self, x, y, width, height):
        """The window rectangle as an array of 0x00RRGGBB words, one per pixel."""
        self.failed = False
        image = self.x.XGetImage(self.display, self.window, x, y, width, height, ALL_PLANES, ZPIXMAP)
        self.x.XSync(self.display, 0)
        if not image or self.failed:
            raise RuntimeError("The game window could not be read. Keep it visible and not minimized.")
        try:
            shot = image.contents
            if shot.bits_per_pixel != 32 or shot.red_mask != 0xFF0000 or shot.blue_mask != 0xFF:
                raise RuntimeError("Unsupported X pixel format; a 24-bit BGRX visual is required.")
            raw = ctypes.string_at(shot.data, shot.bytes_per_line * shot.height)
            words = array("I")
            words.frombytes(raw)
            if shot.bytes_per_line != width * 4:
                stride = shot.bytes_per_line // 4
                packed = array("I")
                for row in range(height):
                    packed.extend(words[row * stride:row * stride + width])
                words = packed
            if sys.byteorder != ("little" if shot.byte_order == 0 else "big"):
                words.byteswap()
            return words
        finally:
            shot.destroy_image(image)


CELL, CELLS = 6, 22


def real_pixel(v, scale):
    """The window pixel that stands for game pixel v.

    An upscaled client blends the window pixels at each strip cell's edge with the neighbouring cell
    (about 17% at 1.5x, just past the decoder's tolerance). The strip is anchored at the window
    origin on a 6-pixel grid, so each game pixel is read from inside its own cell, 1.5 window pixels
    clear of both edges.
    """
    if scale == 1:
        return v
    cell, k = divmod(v, CELL)
    start, width = cell * CELL * scale, CELL * scale
    return int(start + 1.5 + (k + 0.5) * (width - 3) / CELL)


def calibration_cells():
    colors = [(255, 0, 0), (0, 255, 0), (0, 0, 255), (255, 255, 255), (0, 0, 0)]
    colors += [((i % 4) * 85, (i // 4) * 85, ((i + 1) % 4) * 85) for i in range(16)]
    return colors + [(255, 0, 255)]


def level(word):
    """The decoder's four-level reading of a pixel, or None outside its tolerance."""
    value = 0
    for shift in (16, 8, 0):
        channel = (word >> shift) & 255
        step = int(channel / 85 + 0.5)
        if abs(channel - step * 85) > 40:
            return None
        value = value * 4 + step
    return value


def measure_scale(screen, window_width):
    """Window pixels per game pixel, measured from the /witch calibrate strip at the window origin.

    The ratio is rarely a round number (a 2560x1440 client in a 3840x2160 window measured 1.515), and
    1% of error walks a whole pixel across the 22 cells, so every ratio that reads all four corners of
    every cell correctly is collected and the middle of the longest run of them is used.
    """
    width = min(window_width, CELLS * CELL * 4 + 8)
    row = screen.grab(0, 4, width, 1)
    expected = [level((r << 16) | (g << 8) | b) for r, g, b in calibration_cells()]
    runs, run = [], []
    for step in range(1000, 4001):
        scale = step / 1000
        ok = real_pixel(CELLS * CELL - 1, scale) < width and all(
            level(row[real_pixel(i * CELL + k, scale)]) == expected[i] for i in range(CELLS) for k in (0, CELL - 1))
        if ok:
            run.append(scale)
        elif run:
            runs.append(run)
            run = []
    if run:
        runs.append(run)
    if not runs:
        return None
    best = max(runs, key=len)
    return best[len(best) // 2]


def sample(screen, x, y, width, height, scale):
    """A width-by-height block of game pixels at (x, y), as base64 RGBA."""
    columns = [real_pixel(x + i, scale) for i in range(width)]
    rows = [real_pixel(y + j, scale) for j in range(height)]
    left, top = columns[0], rows[0]
    real_width, real_height = columns[-1] - left + 1, rows[-1] - top + 1
    words = screen.grab(left, top, real_width, real_height)
    columns = [column - left for column in columns]
    out = array("I")
    for row in rows:
        base = (row - top) * real_width
        out.extend([words[base + column] for column in columns])
    if sys.byteorder != "little":
        out.byteswap()
    bgrx = bytearray(out.tobytes())
    rgba = bytearray(len(bgrx))
    rgba[0::4], rgba[1::4], rgba[2::4] = bgrx[2::4], bgrx[1::4], bgrx[0::4]
    rgba[3::4] = b"\xff" * (len(bgrx) // 4)
    return base64.b64encode(bytes(rgba)).decode("ascii")


def main():
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("-Mode", choices=["Stream", "Once"], default="Stream")
    parser.add_argument("-X", type=int, default=0)
    parser.add_argument("-Y", type=int, default=0)
    parser.add_argument("-Width", type=int, default=132)
    parser.add_argument("-Height", type=int, default=12)
    parser.add_argument("-Scale", type=float, default=0.0, help="0 measures it during calibration")
    parser.add_argument("-Calibration", action="store_true")
    args = parser.parse_args()
    try:
        if args.Calibration and args.Mode != "Once":
            raise RuntimeError("Calibration is a single capture, never a stream.")
        if args.Scale != 0 and not 1 <= args.Scale <= 4:
            raise RuntimeError("Scale must be between 1 and 4.")
        screen = Screen()
        if args.Scale == 0:
            measured = measure_scale(screen, screen.size()[0]) if args.Calibration else 1.0
            if measured is None:
                raise RuntimeError("No Witchcraft calibration strip at the top-left of the game window. "
                                   "Show /witch calibrate and keep that corner uncovered.")
            args.Scale = measured
        while True:
            cycle = time.monotonic()
            window_width, window_height = screen.size()
            x, y, width, height = args.X, args.Y, args.Width, args.Height
            if args.Calibration:
                x, y, width, height = 0, 0, int(window_width / args.Scale), int(window_height / args.Scale)
            if width <= 0 or height <= 0 or width * height > MAX_PIXELS:
                raise RuntimeError("Capture exceeds the bounded dimensions (sixteen million pixels).")
            if x < 0 or y < 0 or real_pixel(x + width - 1, args.Scale) >= window_width or real_pixel(y + height - 1, args.Scale) >= window_height:
                raise RuntimeError("The calibrated strip is outside the game window. Calibrate again.")
            before = screen.focused()
            if args.Mode == "Stream" and not before:
                write({"protocol": 1, "type": "idle", "foreground": False})
            else:
                started = time.monotonic()
                encoded = sample(screen, x, y, width, height, args.Scale)
                elapsed = (time.monotonic() - started) * 1000
                foreground = before and screen.focused()
                if args.Mode == "Stream" and not foreground:
                    write({"protocol": 1, "type": "idle", "foreground": False})
                else:
                    write({"protocol": 1, "type": "frame", "x": x, "y": y, "width": width, "height": height,
                           "captureMs": elapsed, "foreground": bool(foreground), "scale": args.Scale, "rgba": encoded})
            if args.Mode == "Once":
                break
            time.sleep(max(0.001, 0.2 - (time.monotonic() - cycle)))
    except BrokenPipeError:
        pass
    except Exception as error:  # every failure is reported through the protocol
        try:
            write({"protocol": 1, "type": "error", "message": str(error)})
        except BrokenPipeError:
            pass
        sys.exit(1)


if __name__ == "__main__":
    main()
