#!/usr/bin/env python3
"""Read-only capture of the Witchcraft strip for Linux (X11 or XWayland) and macOS (Quartz).

Speaks the same JSON-lines protocol as capture-strip.ps1. Coordinates are relative to the
game window, in game pixels: -Scale is window pixels per game pixel, so a client rendering
2560x1440 into a 3840x2160 window uses 1.5 and each sampled pixel is the centre of its
upscaled block. Stream frames are refused unless the game window holds input focus. The single
calibration capture is taken regardless, as on Windows: calibrate runs from a terminal that holds
the focus, and its image only locates the strip.

On Linux, requires libX11 and libXRes (the X-Resource extension client library). The window is found by
title ("World of Warcraft") and accepted only when the X server reports that it belongs to a
process whose name starts with "wow" (read from /proc/<pid>/comm); a window whose
process cannot be verified is never chosen.
On macOS, uses CoreGraphics (CGWindowListCopyWindowInfo / CGWindowListCreateImage) to locate and read
the "World of Warcraft" window (Screen Recording permission is required for pixel reads).
WITCHCRAFT_WINDOW_ID selects the window explicitly on either platform.
"""
import argparse
import base64
import ctypes
import ctypes.util
import json
import os
import plistlib
import sys
import time
from array import array

MAX_PIXELS = 16_000_000
TITLE = b"World of Warcraft"
ZPIXMAP, ALL_PLANES = 2, ctypes.c_ulong(-1).value
XRES_CLIENT_ID_PID_MASK = 2


class GrabFailed(RuntimeError):
    """The window could not be read this time (unmapped, minimized or partly off screen)."""


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


class XResClientIdSpec(ctypes.Structure):
    _fields_ = [("client", ctypes.c_ulong), ("mask", ctypes.c_uint)]


class XResClientIdValue(ctypes.Structure):
    _fields_ = [("spec", XResClientIdSpec), ("length", ctypes.c_long), ("value", ctypes.c_void_p)]


def write(record):
    sys.stdout.write(json.dumps(record, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def game_process(comm):
    """Whether a /proc/<pid>/comm name is the game: Wine names a process after its exe (WowB.exe)."""
    name = comm.strip().lower()
    return name.startswith("wow")


def mac_game_owner(owner):
    """Whether a macOS window owner (the app name) is the game: World of Warcraft*, or a Wine exe name."""
    name = str(owner).strip().lower()
    if name.startswith("world of warcraft"):
        return True
    if name.endswith(".exe"):
        name = name[:-4]
    return name in ("wow", "wowclassic", "wowb", "wowt")


def mac_game_window(entry):
    """Whether a macOS Quartz CGWindowListCopyWindowInfo dictionary belongs to World of Warcraft."""
    if not isinstance(entry, dict) or entry.get("kCGWindowLayer", -1) != 0:
        return False
    bounds = entry.get("kCGWindowBounds")
    if not isinstance(bounds, dict) or bounds.get("Width", 0) < 132 or bounds.get("Height", 0) < 12:
        return False
    owner = str(entry.get("kCGWindowOwnerName") or "").strip()
    title = str(entry.get("kCGWindowName") or "").strip()
    owner_ok = mac_game_owner(owner)
    title_ok = not title or title == "World of Warcraft"
    return owner_ok and title_ok


class CGPoint(ctypes.Structure):
    _fields_ = [("x", ctypes.c_double), ("y", ctypes.c_double)]


class CGSize(ctypes.Structure):
    _fields_ = [("width", ctypes.c_double), ("height", ctypes.c_double)]


class CGRect(ctypes.Structure):
    _fields_ = [("origin", CGPoint), ("size", CGSize)]


class MacScreen:
    """macOS Quartz / CoreGraphics window reader speaking the same interface as Screen."""

    K_ON_SCREEN_NO_DESKTOP = 1 | 16
    K_ALL_NO_DESKTOP = 16
    K_INCLUDING_WINDOW = 8
    K_IMAGE_FRAMELESS = 1
    K_PLIST_XML = 100
    K_BITMAP_BGRX_32LE = 6 | (2 << 12)
    # The window bounds include the title bar, so the calibration strip may start below it.
    TITLE_BAR = True
    LIST_TTL = 0.05
    SEARCH_INTERVAL = 1.0
    PROBE_INTERVAL = 1.0
    clock = staticmethod(time.monotonic)
    _screen_list = None
    _screen_list_at = float("-inf")
    _last_search = float("-inf")
    _probe_bounds = None
    _probe_at = float("-inf")

    def __init__(self):
        cg_path = ctypes.util.find_library("CoreGraphics") or "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics"
        cf_path = ctypes.util.find_library("CoreFoundation") or "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation"
        cg = self.cg = ctypes.CDLL(cg_path)
        cf = self.cf = ctypes.CDLL(cf_path)
        cg.CGWindowListCopyWindowInfo.restype = ctypes.c_void_p
        cg.CGWindowListCopyWindowInfo.argtypes = [ctypes.c_uint32, ctypes.c_uint32]
        cg.CGWindowListCreateImage.restype = ctypes.c_void_p
        cg.CGWindowListCreateImage.argtypes = [CGRect, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_uint32]
        cg.CGImageGetWidth.restype = ctypes.c_size_t
        cg.CGImageGetWidth.argtypes = [ctypes.c_void_p]
        cg.CGImageGetHeight.restype = ctypes.c_size_t
        cg.CGImageGetHeight.argtypes = [ctypes.c_void_p]
        cg.CGColorSpaceCreateDeviceRGB.restype = ctypes.c_void_p
        cg.CGColorSpaceCreateDeviceRGB.argtypes = []
        cg.CGColorSpaceRelease.restype = None
        cg.CGColorSpaceRelease.argtypes = [ctypes.c_void_p]
        cg.CGBitmapContextCreate.restype = ctypes.c_void_p
        cg.CGBitmapContextCreate.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_size_t,
                                             ctypes.c_size_t, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_uint32]
        cg.CGContextDrawImage.restype = None
        cg.CGContextDrawImage.argtypes = [ctypes.c_void_p, CGRect, ctypes.c_void_p]
        cg.CGContextRelease.restype = None
        cg.CGContextRelease.argtypes = [ctypes.c_void_p]
        cg.CGImageRelease.restype = None
        cg.CGImageRelease.argtypes = [ctypes.c_void_p]
        cf.CFPropertyListCreateData.restype = ctypes.c_void_p
        cf.CFPropertyListCreateData.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_long,
                                                ctypes.c_ulong, ctypes.c_void_p]
        cf.CFDataGetBytePtr.restype = ctypes.c_void_p
        cf.CFDataGetBytePtr.argtypes = [ctypes.c_void_p]
        cf.CFDataGetLength.restype = ctypes.c_long
        cf.CFDataGetLength.argtypes = [ctypes.c_void_p]
        cf.CFRelease.restype = None
        cf.CFRelease.argtypes = [ctypes.c_void_p]
        self._bounds = {"X": 0.0, "Y": 0.0, "Width": 0.0, "Height": 0.0}
        self._backing = 1.0
        self.pid = None
        self.window = self._find()

    def _windows(self, on_screen_only=True):
        flags = self.K_ON_SCREEN_NO_DESKTOP if on_screen_only else self.K_ALL_NO_DESKTOP
        info = self.cg.CGWindowListCopyWindowInfo(flags, 0)
        if not info:
            return []
        try:
            data = self.cf.CFPropertyListCreateData(None, info, self.K_PLIST_XML, 0, None)
            if not data:
                return []
            try:
                ptr = self.cf.CFDataGetBytePtr(data)
                length = self.cf.CFDataGetLength(data)
                if not ptr or length <= 0:
                    return []
                parsed = plistlib.loads(ctypes.string_at(ptr, length))
                return parsed if isinstance(parsed, list) else []
            finally:
                self.cf.CFRelease(data)
        finally:
            self.cf.CFRelease(info)

    def _on_screen(self):
        """The on-screen window list, reused until the next image capture or cycle.

        Every new cycle and every image capture (grab() and the backing probe) drop it. A steady
        cycle reads it twice and captures one image; a cycle that runs the backing probe (once a
        second, or when the window moved or resized) reads it three times and captures two images.
        A search for a new game window adds its own list reads. LIST_TTL is only a staleness backstop.
        """
        now = self.clock()
        if self._screen_list is None or now - self._screen_list_at >= self.LIST_TTL:
            self._screen_list = self._windows(on_screen_only=True)
            self._screen_list_at = now
        return self._screen_list

    def new_cycle(self):
        """Drops the window list, so no cycle's focus checks reuse a list read in an earlier cycle."""
        self._screen_list = None

    def _rediscover(self):
        """The tracked window left the on-screen list: adopt a new game window when the old one is gone.

        A restarted game opens a new window number. A window that is only hidden, minimised or on
        another Space stays in the all-windows list and is kept. WITCHCRAFT_WINDOW_ID is never replaced.
        """
        if os.environ.get("WITCHCRAFT_WINDOW_ID"):
            return
        now = self.clock()
        if now - self._last_search < self.SEARCH_INTERVAL:
            return
        self._last_search = now
        if any(entry.get("kCGWindowNumber") == self.window for entry in self._windows(on_screen_only=False)):
            return
        try:
            window = self._find()
        except RuntimeError as error:
            if "No World of Warcraft window found" not in str(error):
                raise
            return
        if window != self.window:
            self.window = window
            self._probe_bounds = None
            self._screen_list = None

    def _refresh_backing(self):
        self._screen_list = None  # the focus check after this probe must see a fresh window list
        probe = CGRect(CGPoint(float(self._bounds.get("X", 0.0)), float(self._bounds.get("Y", 0.0))), CGSize(1.0, 1.0))
        image = self.cg.CGWindowListCreateImage(probe, self.K_INCLUDING_WINDOW, self.window, self.K_IMAGE_FRAMELESS)
        if not image:
            return
        try:
            img_w = self.cg.CGImageGetWidth(image)
            if img_w > 0:
                self._backing = max(1.0, float(img_w))
        finally:
            self.cg.CGImageRelease(image)

    def _find(self):
        override = os.environ.get("WITCHCRAFT_WINDOW_ID")
        windows = self._windows(on_screen_only=True)
        if override:
            target = int(override, 0)
            for entry in windows or self._windows(on_screen_only=False):
                if entry.get("kCGWindowNumber") == target:
                    self._bounds = entry.get("kCGWindowBounds") or self._bounds
                    self.pid = entry.get("kCGWindowOwnerPID")
                    break
            return target
        matches = [(int(entry["kCGWindowBounds"].get("Width", 0)) * int(entry["kCGWindowBounds"].get("Height", 0)), entry)
                   for entry in windows if mac_game_window(entry)]
        if not matches:
            matches = [(int(entry["kCGWindowBounds"].get("Width", 0)) * int(entry["kCGWindowBounds"].get("Height", 0)), entry)
                       for entry in self._windows(on_screen_only=False) if mac_game_window(entry)]
        if not matches:
            raise RuntimeError("No World of Warcraft window found. Start the game, or set WITCHCRAFT_WINDOW_ID.")
        _, best = max(matches, key=lambda item: item[0])
        self._bounds = best["kCGWindowBounds"]
        self.pid = best.get("kCGWindowOwnerPID")
        return int(best["kCGWindowNumber"])

    def size(self, window=None):
        target = window or self.window
        for entry in self._on_screen():
            if entry.get("kCGWindowNumber") == target:
                bounds = entry.get("kCGWindowBounds") or {}
                width, height = float(bounds.get("Width", 0)), float(bounds.get("Height", 0))
                if width > 0 and height > 0:
                    if target == self.window:
                        self._bounds = bounds
                        self.pid = entry.get("kCGWindowOwnerPID")
                        # The 1x1 backing probe is an image capture: repeat it only when the window
                        # moved or resized, or once a second. grab() corrects _backing from each image.
                        now = self.clock()
                        if bounds != self._probe_bounds or now - self._probe_at >= self.PROBE_INTERVAL:
                            self._probe_bounds = dict(bounds)
                            self._probe_at = now
                            self._refresh_backing()
                    backing = self._backing if target == self.window else 1.0
                    return max(1, int(round(width * backing))), max(1, int(round(height * backing)))
        raise GrabFailed("The game window is not on screen. Keep World of Warcraft visible and not minimized.")

    def focused(self):
        # A frame is accepted only when the game was focused before and after its read. Every new
        # cycle and every image capture (grab() and the backing probe) drop the cached list, so the
        # cycle's first check, the check after a probe and the check after a grab each read a fresh
        # list, and a focus change during either capture turns the frame into an idle.
        windows = self._on_screen()
        if not any(entry.get("kCGWindowNumber") == self.window for entry in windows):
            self._rediscover()
            return False
        for entry in windows:
            if entry.get("kCGWindowLayer", -1) != 0:
                continue
            bounds = entry.get("kCGWindowBounds") or {}
            if bounds.get("Width", 0) < 64 or bounds.get("Height", 0) < 64:
                continue
            if entry.get("kCGWindowNumber") == self.window:
                return True
            if self.pid and entry.get("kCGWindowOwnerPID") == self.pid:
                return True
            return False
        return False

    def grab(self, x, y, width, height):
        self._screen_list = None  # the focus check after this read must see a fresh window list
        # The backing probe runs only once a second or on a bounds change, so the display density can
        # change under an unchanged window. An image at another scale than its request was built with
        # does not cover the requested pixels: correct the scale and capture once more.
        for attempt in range(2):
            scale = max(1.0, float(self._backing))
            pt_x0 = int(x // scale)
            pt_y0 = int(y // scale)
            pt_w = max(1, int(-(-(x + width) // scale)) - pt_x0)
            pt_h = max(1, int(-(-(y + height) // scale)) - pt_y0)
            ox = float(self._bounds.get("X", 0.0)) + pt_x0
            oy = float(self._bounds.get("Y", 0.0)) + pt_y0
            rect = CGRect(CGPoint(ox, oy), CGSize(float(pt_w), float(pt_h)))
            image = self.cg.CGWindowListCreateImage(rect, self.K_INCLUDING_WINDOW, self.window, self.K_IMAGE_FRAMELESS)
            if not image:
                raise GrabFailed("The game window could not be read. Grant Screen Recording permission in System Settings > Privacy & Security, and keep the game visible.")
            try:
                img_w = self.cg.CGImageGetWidth(image)
                img_h = self.cg.CGImageGetHeight(image)
                if img_w <= 0 or img_h <= 0:
                    raise GrabFailed("The game window could not be read. Keep it visible and not minimized.")
                actual_scale = img_w / pt_w
                if actual_scale >= 1.0 and abs(actual_scale - scale) > 0.01:
                    if attempt:
                        raise GrabFailed("The game window changed display scale during the read. Keep it on one display.")
                    self._backing = actual_scale
                    continue  # the finally below releases this image first
                sub_x = max(0, min(max(0, img_w - width), int(round(x - pt_x0 * actual_scale))))
                sub_y = max(0, min(max(0, img_h - height), int(round(y - pt_y0 * actual_scale))))
                buf = (ctypes.c_ubyte * (width * height * 4))()
                space = self.cg.CGColorSpaceCreateDeviceRGB()
                if not space:
                    raise RuntimeError("Could not create CGColorSpace")
                try:
                    ctx = self.cg.CGBitmapContextCreate(buf, width, height, 8, width * 4, space, self.K_BITMAP_BGRX_32LE)
                    if not ctx:
                        raise RuntimeError("Could not create CGBitmapContext")
                    try:
                        draw_rect = CGRect(CGPoint(-float(sub_x), float(height - img_h + sub_y)), CGSize(float(img_w), float(img_h)))
                        self.cg.CGContextDrawImage(ctx, draw_rect, image)
                    finally:
                        self.cg.CGContextRelease(ctx)
                finally:
                    self.cg.CGColorSpaceRelease(space)
                words = array("I")
                words.frombytes(bytes(buf))
                if sys.byteorder != "little":
                    words.byteswap()
                return words
            finally:
                self.cg.CGImageRelease(image)


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
        self.xres = self._load_xres()
        self.failed = False
        handler = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p)(self._error)
        self._handler = handler  # keep the callback alive
        x.XSetErrorHandler(handler)
        self.display = x.XOpenDisplay(None)
        if not self.display:
            raise RuntimeError("No X display. The game must run under X11 or XWayland and DISPLAY must be set.")
        self.root = x.XDefaultRootWindow(self.display)
        self.window = self._find()

    @staticmethod
    def _load_xres():
        """libXRes, or None; a missing library only makes the process check fail."""
        name = ctypes.util.find_library("XRes")
        if not name:
            return None
        try:
            xres = ctypes.CDLL(name)
            xres.XResQueryClientIds.restype = ctypes.c_int
            xres.XResQueryClientIds.argtypes = [ctypes.c_void_p, ctypes.c_long, ctypes.POINTER(XResClientIdSpec),
                                                ctypes.POINTER(ctypes.c_long),
                                                ctypes.POINTER(ctypes.POINTER(XResClientIdValue))]
            xres.XResClientIdsDestroy.restype = None
            xres.XResClientIdsDestroy.argtypes = [ctypes.c_long, ctypes.POINTER(XResClientIdValue)]
        except (OSError, AttributeError):
            return None
        return xres

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

    def _pid(self, window):
        """The PID the X server records for the client that owns window, or None."""
        if not self.xres:
            return None
        spec = XResClientIdSpec(window, XRES_CLIENT_ID_PID_MASK)
        count = ctypes.c_long(0)
        ids = ctypes.POINTER(XResClientIdValue)()
        self.failed = False
        try:
            status = self.xres.XResQueryClientIds(self.display, 1, ctypes.byref(spec), ctypes.byref(count),
                                                  ctypes.byref(ids))
            if status != 0 or self.failed:
                return None
            for i in range(count.value):  # zero ids also means the extension is missing
                value = ids[i]
                if value.spec.mask & XRES_CLIENT_ID_PID_MASK and value.length >= 4 and value.value:
                    return ctypes.c_uint32.from_address(value.value).value
            return None
        finally:
            if ids:  # libXRes frees and nulls the list itself on a failed reply, leaving the count set
                self.xres.XResClientIdsDestroy(count.value, ids)

    def _owned_by_game(self, window):
        try:
            pid = self._pid(window)
            if not pid:
                return False
            with open(f"/proc/{pid}/comm", encoding="utf-8", errors="replace") as comm:
                return game_process(comm.read())
        except Exception:
            return False

    def _find(self):
        override = os.environ.get("WITCHCRAFT_WINDOW_ID")
        if override:
            return int(override, 0)  # an explicit operator choice, used without the process check
        matches, queue, seen = [], [self.root], 0
        while queue and seen < 4096:
            window = queue.pop(0)
            seen += 1
            kids, _ = self._children(window)
            queue.extend(kids)
            if self._name(window) == TITLE:
                width, height = self.size(window)
                matches.append((width * height, window))
        if not matches:
            raise RuntimeError("No World of Warcraft window found. Start the game, or set WITCHCRAFT_WINDOW_ID.")
        for _, window in sorted(matches, key=lambda match: match[0], reverse=True):
            if self._owned_by_game(window):
                return window
        raise RuntimeError("A World of Warcraft window was found, but its process could not be verified as the "
                           "game (this needs libXRes and a readable /proc). Set WITCHCRAFT_WINDOW_ID to select "
                           "the window explicitly.")

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
            raise GrabFailed("The game window could not be read. Keep it visible and not minimized.")
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
    (about 17% at 1.5x, just past the decoder's tolerance). The strip is anchored on a 6-pixel grid,
    so for scale > 1 each game pixel is read from inside its own cell, 1.5 window pixels clear of
    both edges. For 0.5 <= scale < 1 (e.g. 3 nominal points per 6-pixel cell on a 2x display), each
    game pixel maps proportionally across the sub-6-pixel cell so sample() reconstructs 6-pixel cells.
    """
    if scale == 1:
        return v
    if scale < 1:
        return int((v + 0.5) * scale)
    cell, k = divmod(v, CELL)
    start, width = cell * CELL * scale, CELL * scale
    return int(start + 1.5 + (k + 0.5) * (width - 3) / CELL)


def calibration_size(window_width, window_height, scale):
    """The largest game-pixel capture whose last row and column still map inside the window, within MAX_PIXELS."""
    size = []
    for window in (window_width, window_height):
        count = max(1, int(window / scale))
        while count > 1 and real_pixel(count - 1, scale) >= window:  # real_pixel never decreases in v
            count -= 1
        size.append(count)
    if size[0] * size[1] > MAX_PIXELS:
        ratio = (MAX_PIXELS / (size[0] * size[1])) ** 0.5
        size = [max(1, int(size[0] * ratio)), max(1, int(size[1] * ratio))]
    return size[0], size[1]


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


def _match_row_scale(row, width, min_step, max_step, exact_candidates=()):
    expected = [level((r << 16) | (g << 8) | b) for r, g, b in calibration_cells()]

    def passes(scale):
        return real_pixel(CELLS * CELL - 1, scale) < width and all(
            level(row[real_pixel(i * CELL + k, scale)]) == expected[i] for i in range(CELLS) for k in (0, CELL - 1))

    for exact in exact_candidates:
        if passes(exact):
            return exact
    runs, run = [], []
    for step in range(min_step, max_step + 1):
        scale = step / 1000
        if passes(scale):
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


def measure_scale(screen, window_width, window_height=None):
    """Window pixels per game pixel (0.5..4.0), measured from the /witch calibrate strip.

    An unscaled window returns 1.0; a 3-point-per-cell nominal Retina capture returns 0.5; an
    upscaled Retina capture returns about 2.0 (the middle of the passing run). On a screen with a
    TITLE_BAR it also scans below the title bar when window_height is supplied and row y=4 / y=1 did
    not match.
    """
    width = min(window_width, CELLS * CELL * 4 + 8)
    if width < CELLS * 3:
        return None
    row4 = screen.grab(0, 4, width, 1)
    # Exactly 1.0 when it passes; otherwise the middle of the longest passing run, since a true
    # ratio is rarely round (1.515 for a nominal 1.5) and a run edge has no margin.
    found = _match_row_scale(row4, width, 1000, 4000, exact_candidates=(1.0,))
    if found is not None:
        return found
    row1 = row4 if window_height is not None and window_height <= 4 else screen.grab(0, 1, width, 1)
    found = _match_row_scale(row1, width, 495, 999, exact_candidates=(0.5,))
    if found is not None:
        return found
    # Only a macOS window's bounds include a title bar; an X window is the client area.
    if getattr(screen, "TITLE_BAR", False) and window_height is not None and window_height > 16:
        for y in range(2, min(window_height, 128)):
            if y in (1, 4):
                continue
            band = screen.grab(0, y, width, 1)
            found = _match_row_scale(band, width, 495, 4000, exact_candidates=(1.0, 2.0, 0.5))
            if found is not None:
                return found
    return None


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


def frame_record(screen, mode, x, y, width, height, scale):
    """One cycle's record: a frame, or idle in Stream mode when the game is not focused or not readable."""
    before = screen.focused()
    if mode == "Stream" and not before:
        return {"protocol": 1, "type": "idle", "foreground": False}
    started = time.monotonic()
    try:
        encoded = sample(screen, x, y, width, height, scale)
    except GrabFailed:
        if mode == "Stream":
            return {"protocol": 1, "type": "idle", "foreground": False}
        raise
    elapsed = (time.monotonic() - started) * 1000
    foreground = before and screen.focused()
    if mode == "Stream" and not foreground:
        return {"protocol": 1, "type": "idle", "foreground": False}
    return {"protocol": 1, "type": "frame", "x": x, "y": y, "width": width, "height": height,
            "captureMs": elapsed, "foreground": bool(foreground), "scale": scale, "rgba": encoded}


def cycle_record(screen, mode, x, y, width, height, scale, calibration=False):
    """One cycle of main(): resolves window geometry and returns a frame or Stream idle record."""
    new_cycle = getattr(screen, "new_cycle", None)
    if new_cycle:
        new_cycle()
    if mode == "Stream" and not screen.focused():
        return {"protocol": 1, "type": "idle", "foreground": False}
    try:
        window_width, window_height = screen.size()
    except GrabFailed:
        if mode == "Stream":
            return {"protocol": 1, "type": "idle", "foreground": False}
        raise
    if calibration:
        x, y = 0, 0
        width, height = calibration_size(window_width, window_height, scale)
    if width <= 0 or height <= 0 or width * height > MAX_PIXELS:
        raise RuntimeError("Capture exceeds the bounded dimensions (sixteen million pixels).")
    if x < 0 or y < 0 or real_pixel(x + width - 1, scale) >= window_width or real_pixel(y + height - 1, scale) >= window_height:
        if mode == "Stream":
            return {"protocol": 1, "type": "idle", "foreground": False, "reason": "outside"}
        raise RuntimeError("The calibrated strip is outside the game window. Calibrate again.")
    return frame_record(screen, mode, x, y, width, height, scale)


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
        if args.Scale != 0 and not 0.5 <= args.Scale <= 4:
            raise RuntimeError("Scale must be between 0.5 and 4.")
        screen = MacScreen() if sys.platform == "darwin" else Screen()
        if args.Scale == 0:
            if args.Calibration:
                win_w, win_h = screen.size()
                measured = measure_scale(screen, win_w, win_h)
            else:
                measured = 1.0
            if measured is None:
                raise RuntimeError("No Witchcraft calibration strip at the top-left of the game window. "
                                   "Show /witch calibrate and keep that corner uncovered.")
            args.Scale = measured
        while True:
            cycle = time.monotonic()
            write(cycle_record(screen, args.Mode, args.X, args.Y, args.Width, args.Height, args.Scale, args.Calibration))
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
