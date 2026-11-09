#!/usr/bin/env python3
"""Local computer-use MCP bridge for OpenCode (Windows).

Exposes desktop tools to any MCP client (OpenCode). Two kinds of tools:

  * Direct input tools (click_at, type_text, key_press, scroll) drive the
    mouse and keyboard through Win32 SendInput. No model involved.
  * Vision tools (find_element, click_element, describe_screen, do_action)
    screenshot the primary display, send the PNG to a local UI-TARS model
    served by llama.cpp (default http://127.0.0.1:8081/v1), and act on the
    coordinates it returns. The calling model never sees the image; it gets
    coordinates and status text back, so a text-only model can drive it.

Standard library only. Windows only (ctypes + Win32).
Protocol: newline-delimited JSON-RPC 2.0 on stdio (the MCP stdio transport).
Nothing is printed to stdout except protocol messages; logs go to stderr.
"""

import base64
import ctypes
import json
import os
import re
import struct
import sys
import time
import urllib.error
import urllib.request
import zlib

BASE_URL = os.environ.get("UITARS_BASE_URL", "http://127.0.0.1:8081/v1").rstrip("/")
MODEL = os.environ.get("UITARS_MODEL", "ui-tars-1.5-7b")
IS_WINDOWS = sys.platform == "win32"

user32 = ctypes.windll.user32 if IS_WINDOWS else None
gdi32 = ctypes.windll.gdi32 if IS_WINDOWS else None

if IS_WINDOWS:
    # Handles are pointers on 64-bit Windows; without restype they truncate.
    user32.GetDC.restype = ctypes.c_void_p
    gdi32.CreateCompatibleDC.restype = ctypes.c_void_p
    gdi32.CreateCompatibleBitmap.restype = ctypes.c_void_p
    gdi32.SelectObject.restype = ctypes.c_void_p


def log(*args):
    print("[computer-use-mcp]", *args, file=sys.stderr, flush=True)


def require_windows():
    if not IS_WINDOWS:
        raise RuntimeError("the computer-use bridge only runs on Windows")


# --------------------------------------------------------------------------
# Screenshot: GDI capture of the primary display, encoded as PNG by hand.
# --------------------------------------------------------------------------

class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ("biSize", ctypes.c_ulong), ("biWidth", ctypes.c_long),
        ("biHeight", ctypes.c_long), ("biPlanes", ctypes.c_ushort),
        ("biBitCount", ctypes.c_ushort), ("biCompression", ctypes.c_ulong),
        ("biSizeImage", ctypes.c_ulong), ("biXPelsPerMeter", ctypes.c_long),
        ("biYPelsPerMeter", ctypes.c_long), ("biClrUsed", ctypes.c_ulong),
        ("biClrImportant", ctypes.c_ulong),
    ]


class BITMAPINFO(ctypes.Structure):
    _fields_ = [("bmiHeader", BITMAPINFOHEADER), ("bmiColors", ctypes.c_ulong * 3)]


def screen_size():
    require_windows()
    return user32.GetSystemMetrics(0), user32.GetSystemMetrics(1)


def take_screenshot():
    """Return (png_bytes, width, height) for the primary display.

    width/height are the REAL screen size, used to map the model's
    0-1000 coordinates back to pixels. The PNG itself is downscaled to
    at most MAX_IMAGE_WIDTH wide: vision models tokenize images in
    tiles, so a full 1080p frame costs far more tokens and latency for
    no grounding accuracy the model can actually use."""
    require_windows()
    width, height = screen_size()
    SRCCOPY = 0x00CC0020
    hdc_screen = user32.GetDC(None)
    hdc_mem = gdi32.CreateCompatibleDC(hdc_screen)
    hbmp = gdi32.CreateCompatibleBitmap(hdc_screen, width, height)
    old = gdi32.SelectObject(hdc_mem, hbmp)
    try:
        if not gdi32.BitBlt(hdc_mem, 0, 0, width, height, hdc_screen, 0, 0, SRCCOPY):
            raise RuntimeError("BitBlt failed while capturing the screen")
        info = BITMAPINFO()
        info.bmiHeader.biSize = ctypes.sizeof(BITMAPINFOHEADER)
        info.bmiHeader.biWidth = width
        info.bmiHeader.biHeight = -height  # negative = top-down rows
        info.bmiHeader.biPlanes = 1
        info.bmiHeader.biBitCount = 32
        info.bmiHeader.biCompression = 0  # BI_RGB
        buf = ctypes.create_string_buffer(width * height * 4)
        lines = gdi32.GetDIBits(hdc_mem, hbmp, 0, height, buf,
                                ctypes.byref(info), 0)
        if lines != height:
            raise RuntimeError("GetDIBits did not return the full frame")
        raw = buf.raw  # BGRA, top-down
    finally:
        gdi32.SelectObject(hdc_mem, old)
        gdi32.DeleteObject(hbmp)
        gdi32.DeleteDC(hdc_mem)
        user32.ReleaseDC(None, hdc_screen)
    return _screenshot_png(raw, width, height), width, height


MAX_IMAGE_WIDTH = 1344


def _downscale_bgra(buf, width, height, new_width, new_height):
    """Nearest-neighbor downscale of a top-down BGRA frame."""
    out = bytearray(new_width * new_height * 4)
    for y in range(new_height):
        src_row = (y * height // new_height) * width * 4
        dst_row = y * new_width * 4
        for x in range(new_width):
            s = src_row + (x * width // new_width) * 4
            d = dst_row + x * 4
            out[d:d + 4] = buf[s:s + 4]
    return bytes(out)


def _screenshot_png(raw, width, height):
    if width > MAX_IMAGE_WIDTH:
        new_width = MAX_IMAGE_WIDTH
        new_height = max(1, round(height * new_width / width))
        raw = _downscale_bgra(raw, width, height, new_width, new_height)
        width, height = new_width, new_height
    return _png_from_bgra(raw, width, height)


def _png_from_bgra(buf, width, height):
    rgb = bytearray(width * height * 3)
    rgb[0::3] = buf[2::4]
    rgb[1::3] = buf[1::4]
    rgb[2::3] = buf[0::4]
    stride = width * 3
    raw = bytearray()
    for y in range(height):
        raw.append(0)  # filter type 0 for every scanline
        raw += rgb[y * stride:(y + 1) * stride]

    def chunk(kind, data):
        return (struct.pack(">I", len(data)) + kind + data +
                struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF))

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) +
            chunk(b"IDAT", zlib.compress(bytes(raw), 6)) +
            chunk(b"IEND", b""))


# --------------------------------------------------------------------------
# Input: SendInput for mouse buttons, wheel, virtual keys, and Unicode text.
# --------------------------------------------------------------------------

class MOUSEINPUT(ctypes.Structure):
    _fields_ = [
        ("dx", ctypes.c_long), ("dy", ctypes.c_long),
        ("mouseData", ctypes.c_ulong), ("dwFlags", ctypes.c_ulong),
        ("time", ctypes.c_ulong), ("dwExtraInfo", ctypes.c_size_t),
    ]


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [
        ("wVk", ctypes.c_ushort), ("wScan", ctypes.c_ushort),
        ("dwFlags", ctypes.c_ulong), ("time", ctypes.c_ulong),
        ("dwExtraInfo", ctypes.c_size_t),
    ]


class HARDWAREINPUT(ctypes.Structure):
    _fields_ = [
        ("uMsg", ctypes.c_ulong), ("wParamL", ctypes.c_ushort),
        ("wParamH", ctypes.c_ushort),
    ]


class _INPUT_UNION(ctypes.Union):
    _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT), ("hi", HARDWAREINPUT)]


class INPUT(ctypes.Structure):
    _fields_ = [("type", ctypes.c_ulong), ("u", _INPUT_UNION)]


INPUT_MOUSE = 0
INPUT_KEYBOARD = 1
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_RIGHTDOWN = 0x0008
MOUSEEVENTF_RIGHTUP = 0x0010
MOUSEEVENTF_MIDDLEDOWN = 0x0020
MOUSEEVENTF_MIDDLEUP = 0x0040
MOUSEEVENTF_WHEEL = 0x0800


def _send(inputs):
    require_windows()
    if not inputs:
        return
    arr = (INPUT * len(inputs))(*inputs)
    sent = user32.SendInput(len(inputs), arr, ctypes.sizeof(INPUT))
    if sent != len(inputs):
        raise RuntimeError(f"SendInput sent {sent} of {len(inputs)} events")


def _mouse_event(flags, data=0):
    inp = INPUT()
    inp.type = INPUT_MOUSE
    inp.u.mi = MOUSEINPUT(0, 0, data & 0xFFFFFFFF, flags, 0, 0)
    return inp


def _key_event(vk=0, scan=0, flags=0):
    inp = INPUT()
    inp.type = INPUT_KEYBOARD
    inp.u.ki = KEYBDINPUT(vk, scan, flags, 0, 0)
    return inp


def move_mouse(x, y):
    require_windows()
    if not user32.SetCursorPos(int(x), int(y)):
        raise RuntimeError(f"SetCursorPos({x}, {y}) failed")


def cursor_pos():
    require_windows()

    class POINT(ctypes.Structure):
        _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]

    pt = POINT()
    user32.GetCursorPos(ctypes.byref(pt))
    return pt.x, pt.y


_BUTTON_FLAGS = {
    "left": (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
    "right": (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
    "middle": (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
}


def click_at(x, y, button="left", clicks=1):
    move_mouse(x, y)
    time.sleep(0.05)
    down, up = _BUTTON_FLAGS.get(button, _BUTTON_FLAGS["left"])
    for _ in range(max(1, int(clicks))):
        _send([_mouse_event(down)])
        time.sleep(0.04)
        _send([_mouse_event(up)])
        time.sleep(0.06)
    time.sleep(0.15)


def scroll(direction, amount, x=None, y=None):
    if x is not None and y is not None:
        move_mouse(x, y)
        time.sleep(0.05)
    clicks = max(1, min(int(amount), 50))
    delta = 120 * clicks * (1 if direction == "up" else -1)
    _send([_mouse_event(MOUSEEVENTF_WHEEL, delta)])
    time.sleep(0.1)


VK = {
    "enter": 0x0D, "return": 0x0D, "tab": 0x09, "esc": 0x1B, "escape": 0x1B,
    "space": 0x20, "backspace": 0x08, "delete": 0x2E, "del": 0x2E,
    "home": 0x24, "end": 0x23, "pageup": 0x21, "pagedown": 0x22,
    "up": 0x26, "down": 0x28, "left": 0x25, "right": 0x27,
    "shift": 0x10, "ctrl": 0x11, "control": 0x11, "alt": 0x12,
    "win": 0x5B, "windows": 0x5B, "capslock": 0x14, "insert": 0x2D,
}
VK.update({f"f{i}": 0x70 + i - 1 for i in range(1, 13)})


def _vk_for(token):
    token = token.strip().lower()
    if token in VK:
        return VK[token], False
    if len(token) == 1:
        scan = user32.VkKeyScanW(ord(token))
        if scan == -1:
            raise RuntimeError(f"no virtual key for {token!r}")
        return scan & 0xFF, bool(scan >> 8 & 0x01)
    raise RuntimeError(f"unknown key: {token!r}")


def key_press(keys):
    """Press a key or a '+' combo, e.g. 'enter', 'ctrl+l', 'alt+tab'."""
    tokens = [t for t in re.split(r"\+", keys) if t.strip()]
    if not tokens:
        raise RuntimeError("empty key press")
    if len(tokens) == 1 and len(tokens[0].strip()) == 1 and tokens[0].strip().isprintable():
        type_text(tokens[0].strip())
        return
    pressed = []
    try:
        for tok in tokens:
            vk, needs_shift = _vk_for(tok)
            if needs_shift:
                _send([_key_event(VK["shift"])])
                pressed.append(VK["shift"])
            _send([_key_event(vk)])
            pressed.append(vk)
        time.sleep(0.03)
    finally:
        for vk in reversed(pressed):
            _send([_key_event(vk, flags=KEYEVENTF_KEYUP)])
    time.sleep(0.1)


def type_text(text):
    require_windows()
    for ch in text:
        if ch == "\n":
            _send([_key_event(VK["enter"])])
            _send([_key_event(VK["enter"], flags=KEYEVENTF_KEYUP)])
        elif ch == "\t":
            _send([_key_event(VK["tab"])])
            _send([_key_event(VK["tab"], flags=KEYEVENTF_KEYUP)])
        elif ch == "\r":
            continue
        else:
            code = ord(ch)
            _send([_key_event(0, code, KEYEVENTF_UNICODE)])
            _send([_key_event(0, code, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP)])
    time.sleep(0.05)


# --------------------------------------------------------------------------
# Vision model (UI-TARS served by llama.cpp on :8081)
# --------------------------------------------------------------------------

def vision_up():
    try:
        req = urllib.request.Request(BASE_URL + "/models", method="GET")
        with urllib.request.urlopen(req, timeout=2) as resp:
            return resp.status == 200
    except Exception:
        return False


def vision_chat(prompt, png_bytes, max_tokens=256):
    b64 = base64.b64encode(png_bytes).decode("ascii")
    payload = {
        "model": MODEL,
        "temperature": 0.0,
        "max_tokens": max_tokens,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url",
                 "image_url": {"url": f"data:image/png;base64,{b64}"}},
            ],
        }],
    }
    req = urllib.request.Request(
        BASE_URL + "/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json",
                 "Authorization": "Bearer local"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.URLError as exc:
        raise RuntimeError(
            f"UI-TARS server is not answering at {BASE_URL} ({exc}). "
            "Start it with start-computer-use.ps1 (or start-agent.ps1) "
            "and leave that window open."
        )
    try:
        return data["choices"][0]["message"]["content"] or ""
    except (KeyError, IndexError, TypeError):
        raise RuntimeError(f"unexpected reply from the vision server: {data!r:.300}")


def parse_point(text, width, height):
    """Pull a point out of a UI-TARS reply. Coordinates are expected in the
    model's 0-1000 space; values above 1000 are treated as raw pixels."""
    pair = None
    m = re.search(r'"x"\s*:\s*(\d+(?:\.\d+)?)\s*,\s*"y"\s*:\s*(\d+(?:\.\d+)?)', text)
    if m:
        pair = (float(m.group(1)), float(m.group(2)))
    if pair is None:
        m = re.search(r"<point>\s*(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)\s*</point>", text)
        if m:
            pair = (float(m.group(1)), float(m.group(2)))
    if pair is None:
        m = re.search(r"\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*\)", text)
        if m:
            pair = (float(m.group(1)), float(m.group(2)))
    if pair is None:
        nums = re.findall(r"\d+(?:\.\d+)?", text)
        if len(nums) >= 2:
            pair = (float(nums[0]), float(nums[1]))
    if pair is None:
        raise RuntimeError(f"could not find coordinates in the model reply: {text!r:.200}")
    x, y = pair
    px = round(x / 1000 * (width - 1)) if x <= 1000 else round(x)
    py = round(y / 1000 * (height - 1)) if y <= 1000 else round(y)
    return max(0, min(px, width - 1)), max(0, min(py, height - 1))


FIND_PROMPT = (
    "You are a GUI grounding model. Look at the screenshot and find the UI "
    "element described below. Respond with ONLY the center point of the "
    "element as JSON in 0-1000 coordinates, like {{\"x\": 500, \"y\": 500}}. "
    "No other text.\nElement: {desc}"
)

DESCRIBE_PROMPT = (
    "Describe the current screen for a coding agent that cannot see it. "
    "Name the active application or window, list the main visible UI "
    "elements with approximate locations in 0-1000 coordinates, and include "
    "any readable text that matters. Be concise."
)

ACTION_PROMPT = (
    "You are a computer-use agent looking at a screenshot. The task step "
    "to perform right now is:\n{instruction}\n\n"
    "Respond with exactly ONE action and nothing else, in one of these "
    "forms (coordinates are 0-1000):\n"
    "click(x, y)\n"
    "double_click(x, y)\n"
    "right_click(x, y)\n"
    "type(\"text to type\")\n"
    "hotkey(\"ctrl+l\")\n"
    "scroll(down, 3) or scroll(up, 3)\n"
    "wait(1)\n"
    "finished(\"short summary\")"
)


def find_element(description):
    png, width, height = take_screenshot()
    reply = vision_chat(FIND_PROMPT.format(desc=description), png, max_tokens=128)
    x, y = parse_point(reply, width, height)
    return x, y, reply.strip()


def do_one_action(instruction):
    png, width, height = take_screenshot()
    reply = vision_chat(ACTION_PROMPT.format(instruction=instruction), png,
                        max_tokens=256)
    text = reply.strip()
    low = text.lower()
    if "finished" in low or low.startswith("done"):
        m = re.search(r'finished\(\s*["\'](.*?)["\']\s*\)', text, re.S)
        return f"model reports the step is finished: {m.group(1) if m else text}"
    m = re.search(r"(double_click|right_click|click|type|hotkey|key|scroll|wait)\s*\(",
                  low)
    if not m:
        raise RuntimeError(f"could not parse an action from the model reply: {text!r:.200}")
    kind = m.group(1)
    if kind in ("click", "double_click", "right_click"):
        x, y = parse_point(text, width, height)
        button = "right" if kind == "right_click" else "left"
        clicks = 2 if kind == "double_click" else 1
        click_at(x, y, button=button, clicks=clicks)
        return f"did {kind} at pixel ({x}, {y})"
    if kind == "type":
        tm = re.search(r'type\(\s*["\'](.*?)["\']\s*\)', text, re.S)
        if not tm:
            raise RuntimeError(f"could not parse the text to type: {text!r:.200}")
        type_text(tm.group(1))
        return f"typed {tm.group(1)!r:.80}"
    if kind in ("hotkey", "key"):
        km = re.search(r'(?:hotkey|key)\(\s*["\'](.*?)["\']\s*\)', text, re.S)
        if not km:
            raise RuntimeError(f"could not parse the key combo: {text!r:.200}")
        key_press(km.group(1))
        return f"pressed {km.group(1)}"
    if kind == "scroll":
        direction = "up" if "up" in low else "down"
        nums = re.findall(r"\d+", text[m.end():])
        amount = int(nums[0]) if nums else 3
        scroll(direction, amount)
        return f"scrolled {direction} {amount}"
    if kind == "wait":
        nums = re.findall(r"\d+(?:\.\d+)?", text[m.end():])
        secs = min(float(nums[0]) if nums else 1.0, 10.0)
        time.sleep(secs)
        return f"waited {secs}s"
    raise RuntimeError(f"unhandled action kind: {kind}")


# --------------------------------------------------------------------------
# MCP tools
# --------------------------------------------------------------------------

TOOLS = [
    {
        "name": "computer_screen_info",
        "description": "Get the primary display size, the current cursor "
                       "position, and whether the UI-TARS vision server is "
                       "up. Call this first if unsure about the setup.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "computer_find_element",
        "description": "Find a UI element on screen by description using "
                       "the local UI-TARS vision model. Returns pixel "
                       "coordinates; does not click. Needs the vision "
                       "server (start-computer-use.ps1) running.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "description": {"type": "string",
                                "description": "What to find, e.g. 'the Save button'"},
            },
            "required": ["description"],
        },
    },
    {
        "name": "computer_click_element",
        "description": "Find a UI element by description with the vision "
                       "model and click it. Needs the vision server "
                       "running.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "description": {"type": "string"},
                "button": {"type": "string", "enum": ["left", "right", "middle"],
                           "default": "left"},
                "clicks": {"type": "integer", "default": 1},
            },
            "required": ["description"],
        },
    },
    {
        "name": "computer_click_at",
        "description": "Click at exact pixel coordinates on the primary "
                       "display.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "x": {"type": "integer"}, "y": {"type": "integer"},
                "button": {"type": "string", "enum": ["left", "right", "middle"],
                           "default": "left"},
                "clicks": {"type": "integer", "default": 1},
            },
            "required": ["x", "y"],
        },
    },
    {
        "name": "computer_type_text",
        "description": "Type text at the current keyboard focus, as if "
                       "typed on a physical keyboard.",
        "inputSchema": {
            "type": "object",
            "properties": {"text": {"type": "string"}},
            "required": ["text"],
        },
    },
    {
        "name": "computer_key_press",
        "description": "Press a key or a '+' combo, e.g. 'enter', 'tab', "
                       "'ctrl+l', 'ctrl+shift+esc', 'alt+tab', 'win+r'.",
        "inputSchema": {
            "type": "object",
            "properties": {"keys": {"type": "string"}},
            "required": ["keys"],
        },
    },
    {
        "name": "computer_scroll",
        "description": "Scroll the mouse wheel, optionally at given pixel "
                       "coordinates.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "direction": {"type": "string", "enum": ["up", "down"]},
                "amount": {"type": "integer", "default": 3,
                           "description": "Wheel clicks, 1-50"},
                "x": {"type": "integer"}, "y": {"type": "integer"},
            },
            "required": ["direction"],
        },
    },
    {
        "name": "computer_describe_screen",
        "description": "Ask the vision model to describe what is on screen "
                       "right now (active app, main elements, readable "
                       "text). Needs the vision server running.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "computer_do_action",
        "description": "Perform ONE computer-use step for a plain-language "
                       "instruction: the vision model looks at the screen, "
                       "picks a single action (click, type, hotkey, scroll, "
                       "wait), and the bridge executes it. Call repeatedly "
                       "to work through a GUI task, checking progress with "
                       "computer_describe_screen between steps. Needs the "
                       "vision server running.",
        "inputSchema": {
            "type": "object",
            "properties": {"instruction": {"type": "string"}},
            "required": ["instruction"],
        },
    },
]


def call_tool(name, args):
    args = args or {}
    if name == "computer_screen_info":
        width, height = screen_size()
        cx, cy = cursor_pos()
        up = vision_up()
        return (f"display: {width}x{height}, cursor at ({cx}, {cy}), "
                f"vision server ({BASE_URL}, model {MODEL}): "
                f"{'up' if up else 'DOWN - start start-computer-use.ps1'}")
    if name == "computer_find_element":
        x, y, raw = find_element(args["description"])
        return f"found '{args['description']}' at pixel ({x}, {y}) [model said: {raw}]"
    if name == "computer_click_element":
        x, y, raw = find_element(args["description"])
        click_at(x, y, button=args.get("button", "left"),
                 clicks=int(args.get("clicks", 1)))
        return f"clicked '{args['description']}' at pixel ({x}, {y})"
    if name == "computer_click_at":
        click_at(int(args["x"]), int(args["y"]),
                 button=args.get("button", "left"),
                 clicks=int(args.get("clicks", 1)))
        return f"clicked at pixel ({args['x']}, {args['y']})"
    if name == "computer_type_text":
        type_text(args["text"])
        return f"typed {len(args['text'])} characters at the current focus"
    if name == "computer_key_press":
        key_press(args["keys"])
        return f"pressed {args['keys']}"
    if name == "computer_scroll":
        scroll(args["direction"], int(args.get("amount", 3)),
               args.get("x"), args.get("y"))
        return f"scrolled {args['direction']} {args.get('amount', 3)}"
    if name == "computer_describe_screen":
        png, _, _ = take_screenshot()
        return vision_chat(DESCRIBE_PROMPT, png, max_tokens=512)
    if name == "computer_do_action":
        return do_one_action(args["instruction"])
    raise RuntimeError(f"unknown tool: {name}")


# --------------------------------------------------------------------------
# MCP stdio transport: newline-delimited JSON-RPC 2.0
# --------------------------------------------------------------------------

def main():
    out = sys.stdout.buffer
    for raw_line in sys.stdin.buffer:
        line = raw_line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        method = msg.get("method")
        msg_id = msg.get("id")
        if method == "exit":
            break
        if msg_id is None:
            continue  # notification, nothing to answer
        try:
            if method == "initialize":
                params = msg.get("params") or {}
                result = {
                    "protocolVersion": params.get("protocolVersion", "2024-11-05"),
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "local-computer-use", "version": "1.0.0"},
                }
            elif method == "ping":
                result = {}
            elif method == "tools/list":
                result = {"tools": TOOLS}
            elif method == "tools/call":
                params = msg.get("params") or {}
                try:
                    text = call_tool(params.get("name"),
                                     params.get("arguments") or {})
                    result = {"content": [{"type": "text", "text": text}],
                              "isError": False}
                except Exception as exc:  # tool errors are results, not protocol errors
                    result = {"content": [{"type": "text", "text": str(exc)}],
                              "isError": True}
            elif method == "resources/list":
                result = {"resources": []}
            elif method == "prompts/list":
                result = {"prompts": []}
            else:
                reply = {"jsonrpc": "2.0", "id": msg_id,
                         "error": {"code": -32601,
                                   "message": f"method not found: {method}"}}
                out.write(json.dumps(reply).encode("utf-8") + b"\n")
                out.flush()
                continue
        except Exception as exc:
            reply = {"jsonrpc": "2.0", "id": msg_id,
                     "error": {"code": -32603, "message": str(exc)}}
            out.write(json.dumps(reply).encode("utf-8") + b"\n")
            out.flush()
            continue
        reply = {"jsonrpc": "2.0", "id": msg_id, "result": result}
        out.write(json.dumps(reply).encode("utf-8") + b"\n")
        out.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
