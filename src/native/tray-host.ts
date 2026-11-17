import { dlopen, JSCallback, ptr, read, toArrayBuffer, type Pointer } from "./ffi";
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
 * Everything runs on the JS thread: Windows calls the window procedure while pump() peeks
 * messages, so a pump every few ms keeps senders (who wait up to seconds) from noticing.
 */

const user32 = dlopen("user32.dll", {
  RegisterClassExW: { args: ["ptr"], returns: "u16" },
  UnregisterClassW: { args: ["ptr", "ptr"], returns: "i32" },
  CreateWindowExW: {
    args: ["u32", "ptr", "ptr", "u32", "i32", "i32", "i32", "i32", "ptr", "ptr", "ptr", "ptr"],
    returns: "ptr",
  },
  DefWindowProcW: { args: ["ptr", "u32", "u64", "ptr"], returns: "i64" },
  DestroyWindow: { args: ["ptr"], returns: "i32" },
  PeekMessageW: { args: ["ptr", "ptr", "u32", "u32", "u32"], returns: "i32" },
  TranslateMessage: { args: ["ptr"], returns: "i32" },
  DispatchMessageW: { args: ["ptr"], returns: "i64" },
  SendMessageTimeoutW: { args: ["ptr", "u32", "u64", "ptr", "u32", "u32", "ptr"], returns: "i64" },
  SendNotifyMessageW: { args: ["ptr", "u32", "u64", "i64"], returns: "i32" },
  PostMessageW: { args: ["ptr", "u32", "u64", "i64"], returns: "i32" },
  RegisterWindowMessageW: { args: ["ptr"], returns: "u32" },
  FindWindowW: { args: ["ptr", "ptr"], returns: "ptr" },
  FindWindowExW: { args: ["ptr", "ptr", "ptr", "ptr"], returns: "ptr" },
  SetWindowPos: { args: ["ptr", "i64", "i32", "i32", "i32", "i32", "u32"], returns: "i32" },
  GetWindowThreadProcessId: { args: ["ptr", "ptr"], returns: "u32" },
  AllowSetForegroundWindow: { args: ["i32"], returns: "i32" },
  ChangeWindowMessageFilterEx: { args: ["ptr", "u32", "u32", "ptr"], returns: "i32" },
  GetIconInfo: { args: ["ptr", "ptr"], returns: "i32" },
  IsWindow: { args: ["ptr"], returns: "i32" },
  SetPropW: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
  GetPropW: { args: ["ptr", "ptr"], returns: "ptr" },
  GetDC: { args: ["ptr"], returns: "ptr" },
  ReleaseDC: { args: ["ptr", "ptr"], returns: "i32" },
});
const gdi32 = dlopen("gdi32.dll", {
  GetObjectW: { args: ["ptr", "i32", "ptr"], returns: "i32" },
  GetDIBits: { args: ["ptr", "ptr", "u32", "u32", "ptr", "ptr", "u32"], returns: "i32" },
  DeleteObject: { args: ["ptr"], returns: "i32" },
});
const kernel32 = dlopen("kernel32.dll", { GetModuleHandleW: { args: ["ptr"], returns: "ptr" } });

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
  hicon: number;
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
}

export interface TrayHostHandlers {
  onNotifyIcon(message: NotifyIconMessage): void;
  onTaskband?(message: TaskbandMessage): void;
}

// ---------- Window classes ----------

const classNames = ["Shell_TrayWnd", "TrayNotifyWnd", "ReBarWindow32", "MSTaskSwWClass", "MSTaskListWClass"] as const;
type ClassName = (typeof classNames)[number];

let handlers: TrayHostHandlers | null = null;
let wndProc: JSCallback | null = null;
const classBufs = new Map<string, Uint8Array>();
const windows = new Map<ClassName, HWND>();
const byHwnd = new Map<number, ClassName>();
let pumpTimer: ReturnType<typeof setInterval> | undefined;
let topTimer: ReturnType<typeof setInterval> | undefined;
const debug = !!process.env.TRAY_DEBUG;

const hInstance = kernel32.symbols.GetModuleHandleW(null);

/** Explorer's window of the same class (top level, or under Explorer's tray), skipping ours. */
function explorerWindow(cls: ClassName): HWND | null {
  const own = new Set([...windows.values()].map(Number));
  const tray = (() => {
    let h: HWND | null = null;
    while ((h = U.FindWindowExW(null, h, classBufs.get("Shell_TrayWnd") ?? wide("Shell_TrayWnd"), null) as HWND | null)) {
      if (!own.has(Number(h))) return h;
    }
    return null;
  })();
  if (!tray || cls === "Shell_TrayWnd") return tray;
  if (cls === "TrayNotifyWnd") return U.FindWindowExW(tray, null, wide("TrayNotifyWnd"), null) as HWND | null;
  const rebar = U.FindWindowExW(tray, null, wide("ReBarWindow32"), null) as HWND | null;
  if (!rebar || cls === "ReBarWindow32") return rebar;
  const sw = U.FindWindowExW(rebar, null, wide("MSTaskSwWClass"), null) as HWND | null;
  if (!sw || cls === "MSTaskSwWClass") return sw;
  return U.FindWindowExW(sw, null, wide("MSTaskListWClass"), null) as HWND | null;
}

const resultBuf = new BigUint64Array(1);

/** Sends the same message to Explorer's twin of `cls` and returns its answer. */
function forward(cls: ClassName, msg: number, wParam: bigint | number, lParam: Pointer | null): number {
  const target = explorerWindow(cls);
  if (!target) return 0;
  resultBuf[0] = 0n;
  const ok = U.SendMessageTimeoutW(target, msg, BigInt(wParam), lParam, 0x2 /* SMTO_ABORTIFHUNG */, 2000, new Uint8Array(resultBuf.buffer));
  return ok ? Number(BigInt.asIntN(64, resultBuf[0]!)) : 0;
}

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
function parseTrayData(data: Pointer, size: number): NotifyIconMessage | null {
  if (size < 8 + 24) return null;
  const bytes = new Uint8Array(toArrayBuffer(data, 0, size).slice(0));
  const v = new DataView(bytes.buffer);
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
    hicon: v.getUint32(n + 20, true),
    tip: has(24, 256) ? readWide(bytes, n + 24, 128) : "",
    state: has(280, 4) ? v.getUint32(n + 280, true) : 0,
    stateMask: has(284, 4) ? v.getUint32(n + 284, true) : 0,
    version: has(800, 4) ? v.getUint32(n + 800, true) : 0,
    guid: guid && guid.some((x) => x) ? guidString(guid) : "",
  };
}

function windowProc(hwnd: HWND, msg: number, wParam: bigint, lParam: Pointer | null): number | bigint {
  const cls = byHwnd.get(Number(hwnd));
  if (!cls) return U.DefWindowProcW(hwnd, msg, wParam, lParam);
  try {
    if (cls === "Shell_TrayWnd" && msg === WM_COPYDATA && lParam) {
      // COPYDATASTRUCT: dwData (0 appbar, 1 notify icon, 3 icon rect), cbData, lpData.
      const kind = Number(read.u64(lParam, 0));
      const size = read.u32(lParam, 8);
      const data = read.ptr(lParam, 16) as Pointer | null;
      if (kind === 1 && data) {
        const parsed = parseTrayData(data, size);
        // Explorer keeps its copy, so its own flyouts and a crash of the dock lose nothing.
        forward(cls, msg, wParam, lParam);
        if (parsed) {
          if (debug) console.log("[tray]", parsed.message, parsed.hwnd, parsed.uid, parsed.tip);
          handlers?.onNotifyIcon(parsed);
          return 1;
        }
        return 0;
      }
      return forward(cls, msg, wParam, lParam);
    }
    if (msg >= WM_USER && msg < 0xc000 + 0x4000) {
      if (debug && msg !== 0x4ef) console.log(`[tray] ${cls} msg 0x${msg.toString(16)} w=${wParam} l=${Number(lParam ?? 0)}`);
      if (cls === "MSTaskSwWClass" || cls === "MSTaskListWClass") handlers?.onTaskband?.({ msg, wParam, lParam: Number(lParam ?? 0) });
      const result = forward(cls, msg, wParam, lParam);
      if (debug && msg !== 0x4ef) console.log(`[tray]   -> ${result}`);
      return result;
    }
  } catch (error) {
    console.error("[tray]", error);
  }
  return U.DefWindowProcW(hwnd, msg, wParam, lParam);
}

function registerClasses() {
  wndProc ??= new JSCallback(windowProc, { args: ["ptr", "u32", "u64", "ptr"], returns: "i64" });
  for (const name of classNames) {
    const nameBuf = wide(name);
    classBufs.set(name, nameBuf);
    const wc = new Uint8Array(80);
    const v = new DataView(wc.buffer);
    v.setUint32(0, 80, true);
    v.setUint32(4, 0x8 /* CS_DBLCLKS */, true);
    v.setBigUint64(8, BigInt(wndProc.ptr as number), true);
    v.setBigUint64(24, BigInt((hInstance as number) ?? 0), true);
    v.setBigUint64(64, BigInt(ptr(nameBuf)), true);
    U.RegisterClassExW(wc);
  }
}

function create(cls: ClassName, parent: HWND | null, exStyle: number, style: number) {
  const hwnd = U.CreateWindowExW(exStyle, classBufs.get(cls)!, null, style, 0, 0, 0, 0, parent, null, hInstance, null) as HWND | null;
  if (!hwnd) throw new Error(`CreateWindowEx ${cls} failed`);
  windows.set(cls, hwnd);
  byHwnd.set(Number(hwnd), cls);
  return hwnd;
}

const msgBuf = new Uint8Array(48);

/** Processes pending messages for our windows (sent ones are handled inside PeekMessage). */
function pump() {
  for (const hwnd of windows.values()) {
    for (let i = 0; i < 64 && U.PeekMessageW(msgBuf, hwnd, 0, 0, 1 /* PM_REMOVE */); i++) {
      U.TranslateMessage(msgBuf);
      U.DispatchMessageW(msgBuf);
    }
  }
}

function keepOnTop() {
  const tray = windows.get("Shell_TrayWnd");
  if (!tray) return;
  const first = U.FindWindowW(classBufs.get("Shell_TrayWnd")!, null);
  if (Number(first) !== Number(tray)) {
    U.SetWindowPos(tray, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE);
  }
}

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
  if (windows.size) return;
  registerClasses();
  const WS_POPUP = 0x80000000;
  const WS_CHILD = 0x40000000;
  const WS_EX_TOOLWINDOW = 0x80;
  const WS_EX_TOPMOST = 0x8;
  const tray = create("Shell_TrayWnd", null, WS_EX_TOOLWINDOW | WS_EX_TOPMOST, WS_POPUP);
  create("TrayNotifyWnd", tray, 0, WS_CHILD);
  const rebar = create("ReBarWindow32", tray, 0, WS_CHILD);
  const sw = create("MSTaskSwWClass", rebar, 0, WS_CHILD);
  create("MSTaskListWClass", sw, 0, WS_CHILD);
  // ITaskbarList finds the task band through this property of the tray window.
  const explorer = explorerWindow("Shell_TrayWnd");
  if (debug && explorer)
    console.log("[tray] explorer TaskbandHWND", U.GetPropW(explorer, wide("TaskbandHWND")), "MSTaskSw", explorerWindow("MSTaskSwWClass"));
  U.SetPropW(tray, wide("TaskbandHWND"), sw);
  // Medium-integrity apps reach us anyway; this lets sandboxed (low-integrity) ones in too.
  for (const hwnd of windows.values()) {
    U.ChangeWindowMessageFilterEx(hwnd, WM_COPYDATA, 1, null);
  }
  // The dock's own AppBar calls go straight to Explorer: our tray drops to the bottom of the
  // z-order for the call, so FindWindow("Shell_TrayWnd") inside SHAppBarMessage finds Explorer's.
  setAppBarRoute((call) => {
    U.SetWindowPos(tray, 1 /* HWND_BOTTOM */, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE);
    try {
      return call();
    } finally {
      keepOnTop();
      // Icons added while our tray was out of the way (apps answering the startup broadcast)
      // went to Explorer only: ask again once things settle, so none goes missing here.
      clearTimeout(reannounce);
      reannounce = setTimeout(broadcastTaskbarCreated, 1500);
    }
  });
  pumpTimer = setInterval(pump, 8);
  keepOnTop();
  topTimer = setInterval(keepOnTop, 250);
  broadcastTaskbarCreated();
}

export function stopTrayHost() {
  setAppBarRoute(null);
  clearInterval(pumpTimer);
  clearInterval(topTimer);
  const tray = windows.get("Shell_TrayWnd");
  if (tray) U.DestroyWindow(tray);
  windows.clear();
  byHwnd.clear();
  handlers = null;
}

process.on("exit", () => {
  if (windows.size) stopTrayHost();
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
      for (let i = 3; i < colorPx.length; i += 4) if (colorPx[i]) anyAlpha = true;
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
