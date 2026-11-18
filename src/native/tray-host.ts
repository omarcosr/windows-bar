import { dlopen, runtime, type Pointer } from "./ffi";
import { deflateSync } from "node:zlib";
import { setAppBarRoute } from "./win32";
import { encodeWide, decodeWide } from "./wide";
import { startWorker, type RuntimeWorker } from "../runtime/worker";

/**
 * Hosts the notification area the way RetroBar/ManagedShell do. Shell_NotifyIcon and
 * SHAppBarMessage find the tray with FindWindow("Shell_TrayWnd"), which returns the topmost
 * window of that class: this module creates one above Explorer's, reads every NOTIFYICONDATA
 * it receives (WM_COPYDATA) and forwards every message to Explorer's tray, so Explorer keeps
 * working as before. A "TaskbarCreated" broadcast makes running apps re-add their icons here.
 *
 * The windows live on a worker thread that sleeps in GetMessage, as Explorer's tray thread does:
 * senders get their answer at once and the JS thread is only told what arrived. Tarve's
 * messageWindow() is not used here: its sent messages are answered either from a fixed table or by
 * the JS thread, and this host has to answer with Explorer's own reply after copying the icon (apps
 * destroy it once Shell_NotifyIcon returns), nest five windows of fixed classes and keep its tray
 * on top with a native timer, all without waiting for the JS thread.
 */

const user32 = dlopen("user32.dll", {
  PostThreadMessageW: { args: ["u32", "u32", "u64", "i64"], returns: "i32" },
  DestroyIcon: { args: ["ptr"], returns: "i32" },
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

// ---------- The host windows, on their own thread ----------

const classNames = ["Shell_TrayWnd", "TrayNotifyWnd", "ReBarWindow32", "MSTaskSwWClass", "MSTaskListWClass"] as const;
type ClassName = (typeof classNames)[number];

let handlers: TrayHostHandlers | null = null;
let worker: RuntimeWorker | undefined;
let threadId = 0;
const windows = new Map<ClassName, HWND>();
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
    hicon: v.getUint32(n + 20, true),
    tip: has(24, 256) ? readWide(bytes, n + 24, 128) : "",
    state: has(280, 4) ? v.getUint32(n + 280, true) : 0,
    stateMask: has(284, 4) ? v.getUint32(n + 284, true) : 0,
    version: has(800, 4) ? v.getUint32(n + 800, true) : 0,
    guid: guid && guid.some((x) => x) ? guidString(guid) : "",
  };
}

/** Self-contained JS for the worker's FFI: a worker cannot import the application's TypeScript facade. */
function workerFfi(target: typeof runtime): string {
  if (target === "bun") return 'const { dlopen, JSCallback, ptr } = await import("bun:ffi");';
  const backend = target === "node" ?
    'const ffi = require("node:ffi");\n' +
    'const types = { void:"void", ptr:"pointer", u16:"uint16", i32:"int32", u32:"uint32", i64:"int64", u64:"uint64" };\n' +
    'const sig = s => ({ arguments: (s.args || []).map(t => types[t]), return: types[s.returns || "void"] });\n' +
    'const nativePtr = v => v instanceof Uint8Array ? ffi.getRawPointer(v) : BigInt(v || 0);\n' +
    'const address = v => Number(v || 0);\n' +
    'const open = (path, specs) => { const lib = new ffi.DynamicLibrary(path); libraries.push(lib); return Object.fromEntries(Object.entries(specs).map(([name, s]) => [name, lib.getFunction(name, sig(s))])); };\n' +
    'const callback = (fn, s) => { const lib = new ffi.DynamicLibrary("kernel32.dll"); libraries.push(lib); return lib.registerCallback(sig(s), fn); };\n'
    : 'const ffi = await import("tjs:ffi");\n' +
    'const integer64 = signed => new ffi.AdvancedType(ffi.types[signed ? "sint64" : "uint64"], { name: signed ? "bigint64" : "biguint64", toBuffer(value) { const b = new Uint8Array(8), v = new DataView(b.buffer); if (signed) v.setBigInt64(0, BigInt(value), true); else v.setBigUint64(0, BigInt(value), true); return b; }, fromBuffer(b) { const v = new DataView(b.buffer, b.byteOffset, b.byteLength); return signed ? v.getBigInt64(0, true) : v.getBigUint64(0, true); } });\n' +
    'const types = { void:ffi.types.void, ptr:ffi.types.pointer, u16:ffi.types.uint16, i32:ffi.types.sint32, u32:ffi.types.uint32, i64:integer64(true), u64:integer64(false) };\n' +
    'const sig = s => ({ args: (s.args || []).map(t => types[t]), returns: types[s.returns || "void"] });\n' +
    'const nativePtr = v => { if (v instanceof Uint8Array) return ffi.bufferToPointer(v); const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(v || 0), true); return ffi.types.pointer.fromBuffer(b); };\n' +
    'const address = p => { if (p == null) return 0; const b = ffi.types.pointer.toBuffer(p); return Number(new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(0, true)); };\n' +
    'const open = (path, specs) => { const lib = ffi.dlopen(path, Object.fromEntries(Object.entries(specs).map(([n,s]) => [n,sig(s)]))); libraries.push(lib); return lib.symbols; };\n' +
    'const callback = (fn,s) => { const cb = new ffi.JSCallback(types[s.returns], (s.args || []).map(t => types[t]), fn); callbacks.push(cb); return cb.addr; };\n';
  return 'const libraries = [], callbacks = [];\n' + backend +
    'const input = (t,v) => t === "ptr" ? nativePtr(v) : t === "i64" || t === "u64" ? BigInt(v) : v;\n' +
    'const output = (t,v) => t === "ptr" ? address(v) : t === "i64" || t === "u64" ? BigInt(v) : v;\n' +
    'const ptr = b => address(nativePtr(b));\n' +
    'const dlopen = (path,specs) => { const symbols = open(path,specs); return { symbols: Object.fromEntries(Object.entries(specs).map(([n,s]) => [n,(...args) => output(s.returns, symbols[n](...(s.args || []).map((t,i) => input(t,args[i]))))])) }; };\n' +
    'class JSCallback { constructor(fn,s) { this.ptr = address(callback((...args) => input(s.returns, fn(...(s.args || []).map((t,i) => output(t,args[i])))), s)); } }\n';
}

type TrayWorkerMessage =
  | { type: "ready"; threadId: number; windows: Record<ClassName, number> }
  /** SHELLTRAYDATA bytes; `copied`: the icon handle in it is our copy, to destroy after use. */
  | { type: "notify"; bytes: Uint8Array; copied: number }
  | { type: "taskband"; msg: number; wParam: string; lParam: number; copied: number }
  | { type: "log"; text: string };

/**
 * The worker: the five windows Explorer's tray has, a window procedure and a GetMessage loop, so
 * senders get their answer at once and nothing is polled. Each message is forwarded to Explorer's
 * twin window and passed on to the JS thread. Icon handles are copied before answering, as
 * Explorer does: apps destroy theirs right after Shell_NotifyIcon/SetOverlayIcon return.
 */
function trayWorkerSource(): string {
  return `
${workerFfi(runtime)}
const u = dlopen("user32.dll", {
  RegisterClassExW: { args: ["ptr"], returns: "u16" },
  CreateWindowExW: { args: ["u32", "ptr", "ptr", "u32", "i32", "i32", "i32", "i32", "ptr", "ptr", "ptr", "ptr"], returns: "ptr" },
  DefWindowProcW: { args: ["ptr", "u32", "u64", "i64"], returns: "i64" },
  GetMessageW: { args: ["ptr", "ptr", "u32", "u32"], returns: "i32" },
  TranslateMessage: { args: ["ptr"], returns: "i32" },
  DispatchMessageW: { args: ["ptr"], returns: "i64" },
  SendMessageTimeoutW: { args: ["ptr", "u32", "u64", "i64", "u32", "u32", "ptr"], returns: "i64" },
  FindWindowExW: { args: ["ptr", "ptr", "ptr", "ptr"], returns: "ptr" },
  SetPropW: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
  ChangeWindowMessageFilterEx: { args: ["ptr", "u32", "u32", "ptr"], returns: "i32" },
  CopyIcon: { args: ["ptr"], returns: "ptr" },
  DestroyWindow: { args: ["ptr"], returns: "i32" },
  SetWindowPos: { args: ["ptr", "i64", "i32", "i32", "i32", "i32", "u32"], returns: "i32" },
  SetTimer: { args: ["ptr", "u64", "u32", "ptr"], returns: "u64" },
}).symbols;
const k = dlopen("kernel32.dll", {
  GetModuleHandleW: { args: ["ptr"], returns: "ptr" },
  GetCurrentThreadId: { args: [], returns: "u32" },
  RtlMoveMemory: { args: ["ptr", "ptr", "u64"], returns: "void" },
}).symbols;
const wide = (s) => { const units = new Uint16Array(s.length + 1); for (let i = 0; i < s.length; i++) units[i] = s.charCodeAt(i); return new Uint8Array(units.buffer); };
const names = ${JSON.stringify(classNames)};
const bufs = {};
for (const n of names) bufs[n] = wide(n);
const byHwnd = new Map();
const own = new Set();
/** Explorer's window of the same class (top level, or under Explorer's tray), skipping ours. */
function explorerWindow(cls) {
  let h = null, tray = null;
  while ((h = u.FindWindowExW(null, h, bufs.Shell_TrayWnd, null))) {
    if (!own.has(Number(h))) { tray = h; break; }
  }
  if (!tray || cls === "Shell_TrayWnd") return tray;
  if (cls === "TrayNotifyWnd") return u.FindWindowExW(tray, null, bufs.TrayNotifyWnd, null);
  const rebar = u.FindWindowExW(tray, null, bufs.ReBarWindow32, null);
  if (!rebar || cls === "ReBarWindow32") return rebar;
  const sw = u.FindWindowExW(rebar, null, bufs.MSTaskSwWClass, null);
  if (!sw || cls === "MSTaskSwWClass") return sw;
  return u.FindWindowExW(sw, null, bufs.MSTaskListWClass, null);
}
const result = new BigUint64Array(1);
const resultBytes = new Uint8Array(result.buffer);
/** Sends the same message to Explorer's twin of cls and returns its answer. */
function forward(cls, msg, wParam, lParam) {
  const target = explorerWindow(cls);
  if (!target) return 0n;
  result[0] = 0n;
  const ok = u.SendMessageTimeoutW(target, msg, BigInt(wParam), BigInt(lParam), 0x2 /* SMTO_ABORTIFHUNG */, 2000, resultBytes);
  return ok ? BigInt.asIntN(64, result[0]) : 0n;
}
const copyIcon = (h) => Number(u.CopyIcon(h) || 0) & 0xffffffff;
const head = new Uint8Array(24);
const hv = new DataView(head.buffer);
const proc = new JSCallback((hwnd, msg, wParam, lParam) => {
  const cls = byHwnd.get(Number(hwnd));
  if (!cls) return u.DefWindowProcW(hwnd, msg, wParam, lParam);
  try {
    if (cls === "Shell_TrayWnd" && msg === 0x4a /* WM_COPYDATA */ && lParam) {
      // COPYDATASTRUCT: dwData (0 appbar, 1 notify icon, 3 icon rect), cbData, lpData.
      k.RtlMoveMemory(head, Number(lParam), 24n);
      const kind = Number(hv.getBigUint64(0, true));
      const size = hv.getUint32(8, true);
      const data = Number(hv.getBigUint64(16, true));
      if (kind === 1 && data && size >= 32 && size <= 0x10000) {
        const bytes = new Uint8Array(size);
        k.RtlMoveMemory(bytes, data, BigInt(size));
        // Explorer keeps its copy, so its own flyouts and a crash of the dock lose nothing.
        forward(cls, msg, wParam, lParam);
        const v = new DataView(bytes.buffer);
        if (v.getUint32(0, true) !== 0x34753423) return 0n;
        let copied = 0;
        const hicon = v.getUint32(8 + 20, true);
        if (v.getUint32(8 + 12, true) & 0x2 /* NIF_ICON */ && hicon) {
          const copy = copyIcon(hicon);
          if (copy) { v.setUint32(8 + 20, copy, true); copied = 1; }
        }
        postMessage({ type: "notify", bytes, copied });
        return 1n;
      }
      return forward(cls, msg, wParam, lParam);
    }
    if (msg >= 0x400 && msg < 0x10000) {
      const answer = forward(cls, msg, wParam, lParam);
      if (cls === "MSTaskSwWClass" || cls === "MSTaskListWClass") {
        let l = Number(lParam), copied = 0;
        // SetOverlayIcon (WM_USER + 0x4f): lParam is the badge HICON.
        if (msg === 0x44f && l) { const copy = copyIcon(l); if (copy) { l = copy; copied = 1; } }
        postMessage({ type: "taskband", msg, wParam: String(wParam), lParam: l, copied });
      }
      return answer;
    }
  } catch (error) {
    postMessage({ type: "log", text: String((error && error.stack) || error) });
  }
  return u.DefWindowProcW(hwnd, msg, wParam, lParam);
}, { args: ["ptr", "u32", "u64", "i64"], returns: "i64" });
const inst = k.GetModuleHandleW(null);
for (const n of names) {
  const wc = new Uint8Array(80);
  const v = new DataView(wc.buffer);
  v.setUint32(0, 80, true);
  v.setUint32(4, 0x8 /* CS_DBLCLKS */, true);
  v.setBigUint64(8, BigInt(proc.ptr), true);
  v.setBigUint64(24, BigInt(inst ?? 0), true);
  v.setBigUint64(64, BigInt(ptr(bufs[n])), true);
  u.RegisterClassExW(wc);
}
const created = {};
function create(cls, parent, exStyle, style) {
  const h = u.CreateWindowExW(exStyle, bufs[cls], null, style, 0, 0, 0, 0, parent, null, inst, null);
  if (!h) throw new Error("CreateWindowEx " + cls + " failed");
  created[cls] = Number(h);
  byHwnd.set(Number(h), cls);
  own.add(Number(h));
  return h;
}
// WS_EX_TOOLWINDOW | WS_EX_TOPMOST, WS_POPUP; the rest WS_CHILD.
const tray = create("Shell_TrayWnd", null, 0x88, 0x80000000);
create("TrayNotifyWnd", tray, 0, 0x40000000);
const rebar = create("ReBarWindow32", tray, 0, 0x40000000);
const sw = create("MSTaskSwWClass", rebar, 0, 0x40000000);
create("MSTaskListWClass", sw, 0, 0x40000000);
// ITaskbarList finds the task band through this property of the tray window.
u.SetPropW(tray, wide("TaskbandHWND"), sw);
// Medium-integrity apps reach us anyway; this lets sandboxed (low-integrity) ones in too.
for (const h of byHwnd.keys()) u.ChangeWindowMessageFilterEx(h, 0x4a, 1, null);
postMessage({ type: "ready", threadId: k.GetCurrentThreadId(), windows: created });
// Explorer raises its own taskbar above ours now and then (seen after AppBar state changes), and
// Windows raises no event for a z-order change of a hidden window (tested: no WinEvent, no
// message). So this thread checks the order 4 times a second with a native timer: one FindWindow,
// on this thread, without waking the JS thread.
const keepOnTop = () => {
  if (Number(u.FindWindowExW(null, null, bufs.Shell_TrayWnd, null)) !== Number(tray)) u.SetWindowPos(tray, -1n, 0, 0, 0, 0, 0x13);
};
u.SetTimer(null, 0n, 250, null);
const msg = new Uint8Array(48);
const mv = new DataView(msg.buffer);
while (u.GetMessageW(msg, null, 0, 0) > 0) {
  if (mv.getUint32(8, true) === 0x113 /* WM_TIMER */ && !mv.getBigUint64(0, true)) { keepOnTop(); continue; }
  u.TranslateMessage(msg);
  u.DispatchMessageW(msg);
}
u.DestroyWindow(tray);
`;
}

function onWorkerMessage(m: TrayWorkerMessage) {
  if (m.type === "ready") {
    threadId = m.threadId;
    for (const [cls, hwnd] of Object.entries(m.windows)) windows.set(cls as ClassName, hwnd as HWND);
    const tray = windows.get("Shell_TrayWnd")!;
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
    return;
  }
  if (m.type === "log") return console.error("[tray]", m.text);
  if (m.type === "notify") {
    const parsed = parseTrayData(m.bytes);
    try {
      if (!parsed) return;
      if (debug) console.log("[tray]", parsed.message, parsed.hwnd, parsed.uid, parsed.tip);
      handlers?.onNotifyIcon(parsed);
    } catch (error) {
      console.error("[tray]", error);
    } finally {
      if (m.copied && parsed?.hicon) U.DestroyIcon(parsed.hicon as unknown as Pointer);
    }
    return;
  }
  try {
    if (debug && m.msg !== 0x4ef) console.log(`[tray] taskband msg 0x${m.msg.toString(16)} w=${m.wParam} l=${m.lParam}`);
    handlers?.onTaskband?.({ msg: m.msg, wParam: BigInt(m.wParam), lParam: m.lParam });
  } catch (error) {
    console.error("[tray]", error);
  } finally {
    if (m.copied) U.DestroyIcon(m.lParam as unknown as Pointer);
  }
}

/** Puts our tray first among the Shell_TrayWnd windows again (FindWindow returns the topmost one). */
function keepTrayOnTop() {
  const tray = windows.get("Shell_TrayWnd");
  if (!tray) return;
  const first = U.FindWindowW(trayClass, null);
  if (Number(first) !== Number(tray)) {
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
  if (worker) return;
  worker = startWorker<TrayWorkerMessage>(trayWorkerSource(), onWorkerMessage, (error) => console.error("[tray]", error), () => {
    if (threadId) U.PostThreadMessageW(threadId, 0x12 /* WM_QUIT */, 0n, 0n);
  });
}

export function stopTrayHost() {
  setAppBarRoute(null);
  clearTimeout(reannounce);
  worker?.terminate();
  worker = undefined;
  threadId = 0;
  windows.clear();
  handlers = null;
}

process.on("exit", () => {
  if (worker) stopTrayHost();
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
