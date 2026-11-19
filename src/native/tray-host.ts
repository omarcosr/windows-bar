import { messageWindow, type MessageWindow, type MessageWindowEvent } from "@tarve/core";
import { dlopen, type Pointer, toArrayBuffer } from "./ffi";
import { deflateSync } from "node:zlib";
import { setAppBarRoute } from "./win32";
import { encodeWide, decodeWide } from "./wide";

/**
 * Hosts the notification area the way RetroBar/ManagedShell do. Shell_NotifyIcon and
 * SHAppBarMessage find the tray with FindWindow("Shell_TrayWnd"), which returns the topmost
 * window of that class: this module creates one above Explorer's, reads every NOTIFYICONDATA
 * it receives (WM_COPYDATA) and forwards every message to Explorer's tray, so Explorer keeps
 * working as before. A "TaskbarCreated" broadcast makes running apps re-add their icons here.
 *
 * The windows are Tarve's messageWindow tree, on a native thread that sleeps in GetMessage as
 * Explorer's tray thread does: senders get Explorer's answer at once and the JS thread is only told
 * what arrived.
 */

const user32 = dlopen("user32.dll", {
  SendNotifyMessageW: { args: ["ptr", "u32", "u64", "i64"], returns: "i32" },
  RegisterWindowMessageW: { args: ["ptr"], returns: "u32" },
  FindWindowW: { args: ["ptr", "ptr"], returns: "ptr" },
  SetWindowPos: { args: ["ptr", "i64", "i32", "i32", "i32", "i32", "u32"], returns: "i32" },
  GetWindowThreadProcessId: { args: ["ptr", "ptr"], returns: "u32" },
  AllowSetForegroundWindow: { args: ["i32"], returns: "i32" },
  ChangeWindowMessageFilterEx: { args: ["ptr", "u32", "u32", "ptr"], returns: "i32" },
  GetIconInfo: { args: ["ptr", "ptr"], returns: "i32" },
  IsWindow: { args: ["ptr"], returns: "i32" },
  SetPropW: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
  GetDC: { args: ["ptr"], returns: "ptr" },
  ReleaseDC: { args: ["ptr", "ptr"], returns: "i32" },
});
const gdi32 = dlopen("gdi32.dll", {
  GetObjectW: { args: ["ptr", "i32", "ptr"], returns: "i32" },
  GetDIBits: { args: ["ptr", "ptr", "u32", "u32", "ptr", "ptr", "u32"], returns: "i32" },
  DeleteObject: { args: ["ptr"], returns: "i32" },
});

const U = user32.symbols;
const G = gdi32.symbols;
type HWND = Pointer;

const wide = (s: string) => encodeWide(s);
const WM_COPYDATA = 0x004a;
const WM_USER = 0x0400;
const HWND_TOPMOST = -1;
const SWP_NOSIZE = 0x1;
const SWP_NOMOVE = 0x2;
const SWP_NOACTIVATE = 0x10;

// ---------- Messages the host passes out ----------

/** One NOTIFYICONDATA as it arrived: msg 0 add, 1 modify, 2 delete, 3 set focus, 4 set version. */
export interface NotifyIconMessage {
  message: number;
  hwnd: number;
  uid: number;
  flags: number;
  callback: number;
  /** The icon's pixels (NIF_ICON), read before the sender got its answer. */
  icon?: { width: number; height: number; rgba: Uint8Array };
  tip: string;
  state: number;
  stateMask: number;
  version: number;
  guid: string;
}

/** An ITaskbarList call that reached the task band (WM_USER range), with its raw arguments. */
export interface TaskbandMessage {
  msg: number;
  wParam: bigint;
  lParam: number;
  /** SetOverlayIcon's badge pixels. */
  icon?: { width: number; height: number; rgba: Uint8Array };
  /** A thumbnail toolbar, tooltip or clip call, read from its shared memory while the app waited. */
  thumbBar?: ThumbBarCall;
}

type Pixels = { width: number; height: number; rgba: Uint8Array };

/** One THUMBBUTTON as the app passed it (THB_* in `mask` says which fields count). */
export interface ThumbButtonData {
  mask: number;
  id: number;
  /** Index into the window's image list (THB_BITMAP). */
  bitmap: number;
  /** The pixels of hIcon (THB_ICON), read before the app got its answer. */
  icon: Pixels | null;
  tip: string;
  /** THBF_*: 1 disabled, 2 dismiss on click, 4 no background, 8 hidden, 0x10 non-interactive. */
  flags: number;
}

export type ThumbBarCall =
  | { kind: "add" | "update"; buttons: ThumbButtonData[] }
  | { kind: "images"; images: (Pixels | null)[] }
  | { kind: "tooltip"; text: string | null }
  | { kind: "clip"; rect: { left: number; top: number; right: number; bottom: number } | null };

export interface TrayHostHandlers {
  onNotifyIcon(message: NotifyIconMessage): void;
  onTaskband?(message: TaskbandMessage): void;
}

// ---------- The host windows, on their own thread ----------

let handlers: TrayHostHandlers | null = null;
let host: MessageWindow | undefined;
const debug = !!process.env.TRAY_DEBUG;

function readWide(view: Uint8Array, offset: number, chars: number) {
  const s = decodeWide(view.buffer, view.byteOffset + offset, chars * 2);
  const end = s.indexOf("\0");
  return end >= 0 ? s.slice(0, end) : s;
}

function guidString(b: Uint8Array) {
  const v = new DataView(b.buffer, b.byteOffset, 16);
  const hex = (n: number, len: number) => n.toString(16).padStart(len, "0");
  const tail = [...b.slice(8)].map((x) => hex(x, 2)).join("");
  return `${hex(v.getUint32(0, true), 8)}-${hex(v.getUint16(4, true), 4)}-${hex(v.getUint16(6, true), 4)}-${tail.slice(0, 4)}-${tail.slice(4)}`;
}

/** SHELLTRAYDATA: signature 0x34753423, message, then a NOTIFYICONDATA with 32-bit handles. */
function parseTrayData(bytes: Uint8Array): NotifyIconMessage | null {
  const size = bytes.length;
  if (size < 8 + 24) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, size);
  if (v.getUint32(0, true) !== 0x34753423) return null;
  const n = 8;
  const has = (o: number, len: number) => n + o + len <= size;
  const guid = has(936, 16) ? bytes.subarray(n + 936, n + 952) : null;
  return {
    message: v.getUint32(4, true),
    hwnd: v.getUint32(n + 4, true),
    uid: v.getUint32(n + 8, true),
    flags: v.getUint32(n + 12, true),
    callback: v.getUint32(n + 16, true),
    tip: has(24, 256) ? readWide(bytes, n + 24, 128) : "",
    state: has(280, 4) ? v.getUint32(n + 280, true) : 0,
    stateMask: has(284, 4) ? v.getUint32(n + 284, true) : 0,
    version: has(800, 4) ? v.getUint32(n + 800, true) : 0,
    guid: guid && guid.some((x) => x) ? guidString(guid) : "",
  };
}

/** Explorer's tray tree, as the classes apps and ITaskbarList look for. */
const tree = [
  { className: "TrayNotifyWnd" },
  { className: "ReBarWindow32", children: [{ className: "MSTaskSwWClass", children: [{ className: "MSTaskListWClass" }] }] },
];


// ---------- Thumbnail toolbars (ITaskbarList3 ThumbBar*, SetThumbnailTooltip/Clip) ----------

// Seen on Windows 11: these reach the task band with wParam the window and lParam an SHAllocShared
// block made for the band's process (ours), which the app frees as soon as it has its answer; a 0
// answer fails the call (ERROR_TIMEOUT). So they are not forwarded (Explorer could not open the
// block) and are answered from JavaScript, after the block is read.
const TBL_THUMBBAR_ADD = 0x44c;
const TBL_THUMBBAR_UPDATE = 0x44d;
const TBL_THUMBBAR_IMAGELIST = 0x44e;
const TBL_THUMBNAIL_TOOLTIP = 0x450;
const TBL_THUMBNAIL_CLIP = 0x451;
const THUMBBAR_MESSAGES = [TBL_THUMBBAR_ADD, TBL_THUMBBAR_UPDATE, TBL_THUMBBAR_IMAGELIST, TBL_THUMBNAIL_TOOLTIP, TBL_THUMBNAIL_CLIP];

const shlwapi = dlopen("shlwapi.dll", {
  SHLockShared: { args: ["ptr", "u32"], returns: "ptr" },
  SHUnlockShared: { args: ["ptr"], returns: "i32" },
});
const kernel32 = dlopen("kernel32.dll", { VirtualQuery: { args: ["ptr", "ptr", "u64"], returns: "u64" } });
const postMessage = dlopen("user32.dll", { PostMessageW: { args: ["ptr", "u32", "u64", "i64"], returns: "i32" } }).symbols.PostMessageW;

/** The bytes of a shared-memory block handed to our process (up to the end of its mapping). */
function readShared(handle: number): Uint8Array | null {
  const view = shlwapi.symbols.SHLockShared(handle as unknown as Pointer, process.pid) as number | null;
  if (!view) return null;
  try {
    const mbi = new Uint8Array(48);
    if (!kernel32.symbols.VirtualQuery(view as unknown as Pointer, mbi, 48n)) return null;
    const v = new DataView(mbi.buffer);
    // MEMORY_BASIC_INFORMATION: BaseAddress at 0, RegionSize at 24.
    const size = Number(v.getBigUint64(24, true)) - (view - Number(v.getBigUint64(0, true)));
    if (size <= 0) return null;
    return new Uint8Array(toArrayBuffer(view, 0, Math.min(size, 1 << 20))).slice();
  } finally {
    shlwapi.symbols.SHUnlockShared(view as unknown as Pointer);
  }
}

/** THUMBBUTTON with a 32-bit hIcon: mask, id, bitmap, hIcon, szTip[260], flags. */
const THUMBBUTTON_SIZE = 4 * 4 + 520 + 4;

function parseButtons(bytes: Uint8Array): ThumbButtonData[] {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = Math.min(7, v.getUint32(0, true));
  const buttons: ThumbButtonData[] = [];
  for (let i = 0; i < count; i++) {
    const o = 4 + i * THUMBBUTTON_SIZE;
    if (o + THUMBBUTTON_SIZE > bytes.length) break;
    const mask = v.getUint32(o, true);
    const hicon = v.getUint32(o + 12, true);
    buttons.push({
      mask,
      id: v.getUint32(o + 4, true),
      bitmap: v.getUint32(o + 8, true),
      icon: mask & 0x2 && hicon ? iconPixels(hicon) : null,
      tip: readWide(bytes, o + 16, 260),
      flags: v.getUint32(o + 536, true),
    });
  }
  return buttons;
}

/** A BMP as ImageList_Write stores it: file header, BITMAPINFOHEADER, palette, rows. */
function readBmp(v: DataView, at: number) {
  if (at + 54 > v.byteLength || v.getUint16(at, true) !== 0x4d42) return null;
  const bits = at + v.getUint32(at + 10, true);
  const width = v.getInt32(at + 18, true);
  const height = v.getInt32(at + 22, true);
  const bpp = v.getUint16(at + 28, true);
  const stride = (((width * bpp + 31) >> 5) << 2) >>> 0;
  const rows = Math.abs(height);
  if (width <= 0 || bits + stride * rows > v.byteLength) return null;
  const row = (y: number) => bits + stride * (height > 0 ? rows - 1 - y : y);
  return { width, height: rows, bpp, row, end: bits + stride * rows };
}

/**
 * ThumbBarSetImageList's image list, as the block carries it: its size, then ImageList_Write's
 * stream (ILHEAD, the images' bitmap, the mask's when ILC_MASK). Images sit cx×cy in a grid.
 */
function imageListPixels(bytes: Uint8Array): (Pixels | null)[] {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const h = 4;
  if (bytes.length < h + 28 || v.getUint16(h, true) !== 0x4c49) return [];
  const count = v.getUint16(h + 4, true);
  const cx = v.getUint16(h + 10, true);
  const cy = v.getUint16(h + 12, true);
  const flags = v.getUint16(h + 18, true);
  const color = readBmp(v, h + 28);
  if (!color || !cx || !cy || (color.bpp !== 32 && color.bpp !== 24)) return [];
  const mask = flags & 0x1 ? readBmp(v, color.end) : null;
  const columns = Math.max(1, Math.floor(color.width / cx));
  const images: (Pixels | null)[] = [];
  for (let i = 0; i < count; i++) {
    const left = (i % columns) * cx;
    const top = Math.floor(i / columns) * cy;
    if (top + cy > color.height) {
      images.push(null);
      continue;
    }
    const rgba = new Uint8Array(cx * cy * 4);
    let anyAlpha = false;
    for (let y = 0; y < cy; y++) {
      const src = color.row(top + y);
      for (let x = 0; x < cx; x++) {
        const s = src + (left + x) * (color.bpp / 8);
        const o = (y * cx + x) * 4;
        rgba[o] = v.getUint8(s + 2);
        rgba[o + 1] = v.getUint8(s + 1);
        rgba[o + 2] = v.getUint8(s);
        rgba[o + 3] = color.bpp === 32 ? v.getUint8(s + 3) : 0;
        if (rgba[o + 3]) anyAlpha = true;
      }
    }
    if (!anyAlpha) {
      for (let y = 0; y < cy; y++) {
        for (let x = 0; x < cx; x++) {
          const bit = mask && mask.bpp === 1 ? (v.getUint8(mask.row(top + y) + ((left + x) >> 3)) >> (7 - ((left + x) & 7))) & 1 : 0;
          rgba[(y * cx + x) * 4 + 3] = bit ? 0 : 255;
        }
      }
    }
    images.push({ width: cx, height: cy, rgba });
  }
  return images;
}

/** Reads a thumbnail-toolbar call while its sender still waits. */
function readThumbBarCall(message: number, handle: number): ThumbBarCall | null {
  if (message === TBL_THUMBNAIL_TOOLTIP && !handle) return { kind: "tooltip", text: null };
  if (message === TBL_THUMBNAIL_CLIP && !handle) return { kind: "clip", rect: null };
  if (message === TBL_THUMBBAR_IMAGELIST && !handle) return { kind: "images", images: [] };
  const bytes = handle ? readShared(handle) : null;
  if (!bytes) return null;
  switch (message) {
    case TBL_THUMBBAR_ADD:
      return { kind: "add", buttons: parseButtons(bytes) };
    case TBL_THUMBBAR_UPDATE:
      return { kind: "update", buttons: parseButtons(bytes) };
    case TBL_THUMBBAR_IMAGELIST:
      return { kind: "images", images: imageListPixels(bytes) };
    case TBL_THUMBNAIL_TOOLTIP:
      return { kind: "tooltip", text: readWide(bytes, 0, Math.floor(bytes.length / 2)) };
    case TBL_THUMBNAIL_CLIP: {
      if (bytes.length < 16) return null;
      const v = new DataView(bytes.buffer, bytes.byteOffset, 16);
      return { kind: "clip", rect: { left: v.getInt32(0, true), top: v.getInt32(4, true), right: v.getInt32(8, true), bottom: v.getInt32(12, true) } };
    }
  }
  return null;
}

/** A thumbnail toolbar button was clicked: WM_COMMAND with THBN_CLICKED and the button's id, as Explorer sends it. */
export function clickThumbButton(hwnd: number, id: number) {
  // The app usually brings its window forward or opens one; let it, as for tray icons.
  U.AllowSetForegroundWindow(windowPidOf(hwnd));
  postMessage(hwnd as unknown as Pointer, 0x0111 /* WM_COMMAND */, BigInt(((0x1800 /* THBN_CLICKED */ << 16) | (id & 0xffff)) >>> 0), 0n);
}

/**
 * Tarve's messageWindow (0.13.5) hosts the tree on a native thread of its own: every WM_COPYDATA and
 * WM_USER message is sent on to Explorer's twin window and its answer returned before the sender
 * waits on JavaScript; icons are read before the sender gets its answer (apps destroy theirs right
 * after Shell_NotifyIcon/SetOverlayIcon return); keepFirst keeps this tray the one FindWindow
 * finds, since Windows raises no event when a hidden window loses that place.
 */
function onHostMessage(event: MessageWindowEvent) {
  if (event.type !== "message") return;
  try {
    if (event.message === WM_COPYDATA) {
      if (event.window.className !== "Shell_TrayWnd" || event.copyData?.dwData !== 1n) return;
      const parsed = parseTrayData(event.copyData.data);
      if (!parsed) return;
      parsed.icon = event.icon;
      if (debug) console.log("[tray]", parsed.message, parsed.hwnd, parsed.uid, parsed.tip);
      handlers?.onNotifyIcon(parsed);
      return;
    }
    if (event.window.className !== "MSTaskSwWClass" && event.window.className !== "MSTaskListWClass") return;
    if (THUMBBAR_MESSAGES.includes(event.message)) {
      const handle = Number(BigInt.asUintN(32, event.lParam));
      const thumbBar = readThumbBarCall(event.message, handle);
      if (debug) console.log(`[tray] thumbbar msg 0x${event.message.toString(16)} w=${event.wParam}`, thumbBar?.kind ?? "unreadable");
      if (thumbBar) handlers?.onTaskband?.({ msg: event.message, wParam: event.wParam, lParam: handle, thumbBar });
      // Non-zero: the call succeeded (0 fails it with ERROR_TIMEOUT).
      return thumbBar ? 1 : 0;
    }
    if (debug && event.message !== 0x4ef) console.log(`[tray] taskband msg 0x${event.message.toString(16)} w=${event.wParam} l=${event.lParam}`);
    handlers?.onTaskband?.({ msg: event.message, wParam: event.wParam, lParam: Number(BigInt.asIntN(64, event.lParam)), icon: event.icon });
  } catch (error) {
    console.error("[tray]", error);
  }
}

function openHost(): MessageWindow {
  const window = messageWindow({
    className: "Shell_TrayWnd",
    // WS_POPUP, WS_EX_TOOLWINDOW | WS_EX_TOPMOST: first among the Shell_TrayWnd windows.
    style: 0x80000000,
    exStyle: 0x88,
    children: tree,
    messages: [WM_COPYDATA],
    // Private (WM_USER) messages only: ITaskbarList's calls to the task band. Registered messages
    // (TaskbarCreated, SHELLHOOK) are broadcasts Explorer gets itself; forwarding them doubled them.
    messageRanges: [[WM_USER, 0xbfff]],
    // Explorer keeps its copy, so its own flyouts and a crash of the dock lose nothing.
          forward: {
        messages: [WM_COPYDATA],
        // All but the thumbnail toolbar calls: their shared memory opens only in our process.
        ranges: [
          [WM_USER, TBL_THUMBBAR_ADD - 1],
          [TBL_THUMBBAR_IMAGELIST + 1, TBL_THUMBNAIL_TOOLTIP - 1],
          [TBL_THUMBNAIL_CLIP + 1, 0xbfff],
        ],
        timeout: 2000,
      },
      // The app waits while its shared memory is read (it frees the block once answered).
      waitReplies: THUMBBAR_MESSAGES,
      replyTimeout: 2000,
    // NIM_* gets 1 at once, as Explorer answers.
    keyedReplies: [{ message: WM_COPYDATA, dwData: 1, value: 1 }],
    icons: [
      // SHELLTRAYDATA: NOTIFYICONDATA at 8, its uFlags at 20 (NIF_ICON 2), its 32-bit hIcon at 28.
      { message: WM_COPYDATA, dwData: 1, offset: 28, when: { offset: 20, mask: 0x2 } },
      // SetOverlayIcon (WM_USER + 0x4f): lParam is the badge HICON.
      { message: 0x44f },
    ],
    keepFirst: 250,
    onMessage: onHostMessage,
  });
  const tray = Number(window.hwnd) as HWND;
  const band = window.children.find((c) => c.className === "MSTaskSwWClass");
  // ITaskbarList finds the task band through this property of the tray window.
  if (band) U.SetPropW(tray, wide("TaskbandHWND"), Number(band.hwnd) as HWND);
  // Medium-integrity apps reach us anyway; this lets sandboxed (low-integrity) ones in too.
  for (const h of [window.hwnd, ...window.children.map((c) => c.hwnd)]) U.ChangeWindowMessageFilterEx(Number(h) as HWND, WM_COPYDATA, 1, null);
  return window;
}

/** Puts our tray first among the Shell_TrayWnd windows again (FindWindow returns the topmost one). */
function keepTrayOnTop() {
  if (!host) return;
  const tray = Number(host.hwnd) as HWND;
  if (Number(U.FindWindowW(trayClass, null)) !== Number(tray)) {
    U.SetWindowPos(tray, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE);
  }
}
const trayClass = wide("Shell_TrayWnd");

let taskbarCreated = 0;
let reannounce: ReturnType<typeof setTimeout> | undefined;

/** Asks every app to (re)add its notification icons; they arrive at whichever tray is on top. */
export function broadcastTaskbarCreated() {
  taskbarCreated ||= U.RegisterWindowMessageW(wide("TaskbarCreated"));
  U.SendNotifyMessageW(0xffff as unknown as Pointer, taskbarCreated, 0n, 0);
}

let buttonCreated = 0;

/** Tells windows their taskbar button exists, as Explorer does: apps then (re)set overlays. */
export function broadcastTaskbarButtonCreated(hwnds: readonly Pointer[]) {
  buttonCreated ||= U.RegisterWindowMessageW(wide("TaskbarButtonCreated"));
  for (const hwnd of hwnds) U.SendNotifyMessageW(hwnd, buttonCreated, 0n, 0);
}

export function startTrayHost(h: TrayHostHandlers) {
  handlers = h;
  if (host) return;
  try {
    host = openHost();
  } catch (error) {
    console.error("[tray]", error);
    return;
  }
  const tray = Number(host.hwnd) as HWND;
  // The dock's own AppBar calls go straight to Explorer: our tray drops to the bottom of the
  // z-order for the call, so FindWindow("Shell_TrayWnd") inside SHAppBarMessage finds Explorer's.
  setAppBarRoute((call) => {
    U.SetWindowPos(tray, 1 /* HWND_BOTTOM */, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE);
    try {
      return call();
    } finally {
      keepTrayOnTop();
      // Icons added while our tray was out of the way (apps answering the startup broadcast)
      // went to Explorer only: ask again once things settle, so none goes missing here.
      clearTimeout(reannounce);
      reannounce = setTimeout(broadcastTaskbarCreated, 1500);
    }
  });
  keepTrayOnTop();
  broadcastTaskbarCreated();
}

export function stopTrayHost() {
  setAppBarRoute(null);
  clearTimeout(reannounce);
  host?.dispose();
  host = undefined;
  handlers = null;
}

process.on("exit", () => {
  if (host) stopTrayHost();
});

// ---------- Talking to icon owners ----------

export function windowPidOf(hwnd: number): number {
  const pid = new Uint32Array(1);
  U.GetWindowThreadProcessId(hwnd as unknown as Pointer, new Uint8Array(pid.buffer));
  return pid[0]!;
}

export function windowAlive(hwnd: number) {
  return !!U.IsWindow(hwnd as unknown as Pointer);
}

export const NIN_SELECT = WM_USER;
const WM_CONTEXTMENU = 0x007b;
const WM_MOUSEMOVE = 0x0200;
const WM_LBUTTONDOWN = 0x0201;
const WM_LBUTTONUP = 0x0202;
const WM_LBUTTONDBLCLK = 0x0203;
const WM_RBUTTONDOWN = 0x0204;
const WM_RBUTTONUP = 0x0205;

/**
 * Plays a click on an icon to its owner the way Explorer does: button down and up, then
 * NIN_SELECT / WM_CONTEXTMENU for version-4 icons, which take the anchor point in wParam.
 */
export function clickIcon(
  icon: { hwnd: number; uid: number; callback: number; version: number },
  button: "left" | "right" | "double",
  at: { x: number; y: number },
) {
  if (!icon.callback) return;
  const hwnd = icon.hwnd as unknown as Pointer;
  // The app usually brings a window forward in answer; let it (ASFW_ANY also covers helpers
  // of the owner process). This only works while the dock is the foreground app.
  U.AllowSetForegroundWindow(windowPidOf(icon.hwnd));
  U.AllowSetForegroundWindow(-1);
  const v4 = icon.version >= 4;
  const wParam = v4 ? BigInt(((at.y & 0xffff) << 16) | (at.x & 0xffff)) : BigInt(icon.uid);
  const send = (event: number) => {
    const lParam = v4 ? ((icon.uid & 0xffff) << 16) | event : event;
    U.SendNotifyMessageW(hwnd, icon.callback, wParam, lParam);
  };
  send(WM_MOUSEMOVE);
  if (button === "right") {
    send(WM_RBUTTONDOWN);
    send(WM_RBUTTONUP);
    if (v4) send(WM_CONTEXTMENU);
  } else if (button === "double") {
    send(WM_LBUTTONDOWN);
    send(WM_LBUTTONUP);
    send(WM_LBUTTONDBLCLK);
    send(WM_LBUTTONUP);
  } else {
    send(WM_LBUTTONDOWN);
    send(WM_LBUTTONUP);
    if (v4) send(NIN_SELECT);
  }
}

// ---------- HICON -> PNG ----------

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array) {
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array) {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  out.set(Buffer.from(type, "ascii"), 4);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  const parts = [
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array(0)),
  ];
  return Buffer.concat(parts);
}

function bitmapPixels(dc: Pointer, hbm: Pointer, width: number, height: number) {
  const bmi = new Uint8Array(40 + 1024);
  const v = new DataView(bmi.buffer);
  v.setUint32(0, 40, true);
  v.setInt32(4, width, true);
  v.setInt32(8, -height, true);
  v.setUint16(12, 1, true);
  v.setUint16(14, 32, true);
  const px = new Uint8Array(width * height * 4);
  return G.GetDIBits(dc, hbm, 0, height, px, bmi, 0) ? px : null;
}

/** The icon's pixels as RGBA, read through GDI (icon handles are valid across processes). */
export function iconPixels(hicon: number): { width: number; height: number; rgba: Uint8Array } | null {
  if (!hicon) return null;
  const info = new Uint8Array(32);
  if (!U.GetIconInfo(hicon as unknown as Pointer, info)) return null;
  const iv = new DataView(info.buffer);
  // GDI handles are sign-extended to 64 bits, past what a JS number holds exactly; the low
  // 32 bits are the handle.
  const mask = Number(iv.getBigUint64(16, true) & 0xffffffffn) as unknown as Pointer;
  const color = Number(iv.getBigUint64(24, true) & 0xffffffffn) as unknown as Pointer;
  try {
    const bm = new Uint8Array(32);
    if (!G.GetObjectW(color || mask, 32, bm)) return null;
    const bv = new DataView(bm.buffer);
    const width = bv.getInt32(4, true);
    let height = bv.getInt32(8, true);
    if (!color) height /= 2;
    if (width <= 0 || height <= 0 || width > 256 || height > 256) return null;
    const dc = U.GetDC(null) as Pointer;
    try {
      const maskPx = mask ? bitmapPixels(dc, mask, width, color ? height : height * 2) : null;
      const colorPx = color ? bitmapPixels(dc, color, width, height) : maskPx?.subarray(width * height * 4);
      if (!colorPx) return null;
      const rgba = new Uint8Array(width * height * 4);
      let anyAlpha = false;
      for (let i = 3; i < colorPx.length; i += 4) if (colorPx[i]) { anyAlpha = true; break; }
      for (let i = 0; i < width * height; i++) {
        const o = i * 4;
        rgba[o] = colorPx[o + 2]!;
        rgba[o + 1] = colorPx[o + 1]!;
        rgba[o + 2] = colorPx[o]!;
        rgba[o + 3] = anyAlpha ? colorPx[o + 3]! : maskPx && maskPx[o] ? 0 : 255;
      }
      return { width, height, rgba };
    } finally {
      U.ReleaseDC(null, dc);
    }
  } finally {
    if (mask) G.DeleteObject(mask);
    if (color) G.DeleteObject(color);
  }
}
