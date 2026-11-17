import { runtime, dlopen } from "./ffi.ts";
import { startWorker } from "../runtime/worker.ts";
import { onExit } from "../services/exit.ts";
import type { RuntimeWorker } from "../runtime/worker.ts";

/**
 * Event-driven signals from Windows, the same ones the real taskbar listens to:
 *  - ABN_FULLSCREENAPP: Explorer tells every AppBar when a full-screen app takes a monitor.
 *  - Shell hook (RegisterShellHookWindow): window created/destroyed/activated, title redrawn,
 *    a full-screen ("rude") app activated, HSHELL_FLASH when an app asks for attention and
 *    HSHELL_LANGUAGE when the input language changes.
 *  - WinEvents: foreground changes, the foreground window resizing (F11, games), windows
 *    minimized/restored or cloaked, and Explorer showing its own taskbar again.
 *  - Broadcasts every top-level window gets: WM_SETTINGCHANGE (theme, accent, taskbar settings,
 *    work area, wallpaper), WM_POWERBROADCAST (battery), WM_DISPLAYCHANGE, "TaskbarCreated".
 *  - Change notifications on the registry keys and folders the taskbar reads its settings and
 *    pins from (RegNotifyChangeKeyValue, FindFirstChangeNotification).
 *
 * They arrive as window messages or signalled handles, so a thread has to wait for them. The JS
 * thread runs its own event loop, so a worker owns a hidden window and blocks in
 * MsgWaitForMultipleObjectsEx: nothing is polled, the worker sleeps until Windows has something to say.
 */

/** Registry keys (HKCU) and folders watched for changes, by id. */
const WATCHES = {
  taskband: { reg: "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Taskband" },
  pinned: { dir: `${process.env.APPDATA}\\Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar` },
  advanced: { reg: "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced" },
  search: { reg: "Software\\Microsoft\\Windows\\CurrentVersion\\Search" },
  personalize: { reg: "Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize" },
  dwm: { reg: "Software\\Microsoft\\Windows\\DWM" },
  notifyIcons: { reg: "Control Panel\\NotifyIconSettings", subtree: true },
  notifications: { dir: `${process.env.LOCALAPPDATA}\\Microsoft\\Windows\\Notifications` },
} as const;
export type WatchId = keyof typeof WATCHES;

export type ShellEvent =
  | { type: "fullscreen"; on: boolean }
  | { type: "shell"; code: number; hwnd: number }
  | { type: "foreground"; hwnd: number }
  | { type: "moved"; hwnd: number }
  /** A window was minimized, restored, cloaked or uncloaked. */
  | { type: "windowState"; hwnd: number }
  /** WM_SETTINGCHANGE: wParam the SPI_* action (0 for a named area), area the lParam string. */
  | { type: "setting"; action: number; area: string }
  /** The power source or the battery's charge changed. */
  | { type: "power" }
  | { type: "display" }
  /** Explorer restarted (a new Explorer process announced TaskbarCreated). */
  | { type: "explorerRestarted" }
  /** Explorer showed its own taskbar window. */
  | { type: "trayShown" }
  | { type: "changed"; id: WatchId };

export const HSHELL = {
  WINDOWCREATED: 1,
  WINDOWDESTROYED: 2,
  WINDOWACTIVATED: 4,
  REDRAW: 6,
  LANGUAGE: 8,
  RUDEAPPACTIVATED: 0x8004,
  FLASH: 0x8006,
} as const;
export const SPI_SETDESKWALLPAPER = 0x14;
export const SPI_SETWORKAREA = 0x2f;

let worker: RuntimeWorker | undefined;
const listeners = new Set<(event: ShellEvent) => void>();

/** Listens to every shell event; returns the unsubscribe function. */
export function onShellEvent(listener: (event: ShellEvent) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Runs `fn` after a watched key or folder changed, once per burst (writers touch several values
 * in a row); returns the unsubscribe function.
 */
export function onWatchChange(ids: readonly WatchId[], fn: () => void, settle = 150): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const off = onShellEvent((event) => {
    if (event.type !== "changed" || !ids.includes(event.id)) return;
    clearTimeout(timer);
    timer = setTimeout(fn, settle);
  });
  return () => {
    clearTimeout(timer);
    off();
  };
}

/**
 * Follows whether a window matching `test` (Start, a shell flyout) is in front, from foreground
 * events. `recently(ms)` is true while one is, or for `ms` after it lost the foreground: clicking
 * the dock takes the focus from it before the click handler runs, as with the taskbar's buttons.
 */
export function followForeground(test: (hwnd: number) => boolean, current: number | null) {
  let inFront = !!current && test(current);
  let leftAt = 0;
  onShellEvent((event) => {
    if (event.type !== "foreground") return;
    const next = !!event.hwnd && test(event.hwnd);
    if (inFront && !next) leftAt = Date.now();
    inFront = next;
  });
  return {
    recently: (ms: number) => inFront || Date.now() - leftAt < ms,
    reset() {
      inFront = false;
      leftAt = 0;
    },
  };
}

export function startShellEvents(onEvent: (event: ShellEvent) => void) {
  if (worker) return;
  let threadId = 0;
  const user = dlopen("user32.dll", { PostThreadMessageW: { args: ["u32", "u32", "u64", "i64"], returns: "i32" } });
  worker = startWorker<ShellEvent | { type: "ready"; threadId: number }>(shellWorkerSource(), data => {
    if (data.type === "ready") {
      threadId = data.threadId;
      return;
    }
    onEvent(data);
    for (const listener of listeners) {
      try {
        listener(data);
      } catch (error) {
        console.error("[shell-events]", error);
      }
    }
  }, error => console.error("[shell-events]", error), () => {
    if (threadId) user.symbols.PostThreadMessageW(threadId, 0x12, 0n, 0n);
  });
  onExit(() => { worker?.terminate(); worker = undefined; user.close(); });
}
/** Self-contained JS: workers cannot import the application's TypeScript facade. */
export function shellWorkerFfi(target: typeof runtime): string {
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
    'const callback = (fn,s) => { /* txiki 26.6 cannot marshal a void callback result; WinEventProc ignores the return register. */ const returnsVoid = !s.returns || s.returns === "void"; const cb = new ffi.JSCallback(returnsVoid ? types.i32 : types[s.returns], (s.args || []).map(t => types[t]), returnsVoid ? (...args) => { fn(...args); return 0; } : fn); callbacks.push(cb); return cb.addr; };\n';
  return 'const libraries = [], callbacks = [];\n' + backend +
    'const input = (t,v) => t === "ptr" ? nativePtr(v) : t === "i64" || t === "u64" ? BigInt(v) : v;\n' +
    'const output = (t,v) => t === "ptr" ? address(v) : t === "i64" || t === "u64" ? BigInt(v) : v;\n' +
    'const ptr = b => address(nativePtr(b));\n' +
    'const dlopen = (path,specs) => { const symbols = open(path,specs); return { symbols: Object.fromEntries(Object.entries(specs).map(([n,s]) => [n,(...args) => output(s.returns, symbols[n](...(s.args || []).map((t,i) => input(t,args[i]))))])) }; };\n' +
    'class JSCallback { constructor(fn,s) { this.ptr = address(callback((...args) => input(s.returns, fn(...(s.args || []).map((t,i) => output(t,args[i])))), s)); } }\n';
}
export function shellWorkerSource(target: typeof runtime = runtime): string {
  const watches = Object.entries(WATCHES).map(([id, w]) => ({ id, ...w }));
  return `
${shellWorkerFfi(target)}
const u = dlopen("user32.dll", {
  RegisterClassExW: { args: ["ptr"], returns: "u16" },
  CreateWindowExW: { args: ["u32", "ptr", "ptr", "u32", "i32", "i32", "i32", "i32", "ptr", "ptr", "ptr", "ptr"], returns: "ptr" },
  DefWindowProcW: { args: ["ptr", "u32", "u64", "i64"], returns: "i64" },
  PeekMessageW: { args: ["ptr", "ptr", "u32", "u32", "u32"], returns: "i32" },
  TranslateMessage: { args: ["ptr"], returns: "i32" },
  DispatchMessageW: { args: ["ptr"], returns: "i64" },
  MsgWaitForMultipleObjectsEx: { args: ["u32", "ptr", "u32", "u32", "u32"], returns: "u32" },
  RegisterWindowMessageW: { args: ["ptr"], returns: "u32" },
  RegisterShellHookWindow: { args: ["ptr"], returns: "i32" },
  SetWinEventHook: { args: ["u32", "u32", "ptr", "ptr", "u32", "u32", "u32"], returns: "ptr" },
  GetForegroundWindow: { args: [], returns: "ptr" },
  GetShellWindow: { args: [], returns: "ptr" },
  GetWindowThreadProcessId: { args: ["ptr", "ptr"], returns: "u32" },
  GetClassNameW: { args: ["ptr", "ptr", "i32"], returns: "i32" },
  DestroyWindow: { args: ["ptr"], returns: "i32" },
  UnhookWinEvent: { args: ["ptr"], returns: "i32" },
  DeregisterShellHookWindow: { args: ["ptr"], returns: "i32" },
  RegisterPowerSettingNotification: { args: ["ptr", "ptr", "u32"], returns: "ptr" },
}).symbols;
const shell = dlopen("shell32.dll", { SHAppBarMessage: { args: ["u32", "ptr"], returns: "u64" } }).symbols;
const k = dlopen("kernel32.dll", {
  GetModuleHandleW: { args: ["ptr"], returns: "ptr" },
  GetCurrentThreadId: { args: [], returns: "u32" },
  CreateEventW: { args: ["ptr", "i32", "i32", "ptr"], returns: "ptr" },
  FindFirstChangeNotificationW: { args: ["ptr", "i32", "u32"], returns: "ptr" },
  FindNextChangeNotification: { args: ["ptr"], returns: "i32" },
  lstrlenW: { args: ["ptr"], returns: "i32" },
  RtlMoveMemory: { args: ["ptr", "ptr", "u64"], returns: "void" },
}).symbols;
const reg = dlopen("advapi32.dll", {
  RegOpenKeyExW: { args: ["u64", "ptr", "u32", "u32", "ptr"], returns: "i32" },
  RegNotifyChangeKeyValue: { args: ["ptr", "i32", "u32", "ptr", "i32"], returns: "i32" },
}).symbols;
const wide = (s) => { const units = new Uint16Array(s.length + 1); for (let i = 0; i < s.length; i++) units[i] = s.charCodeAt(i); return new Uint8Array(units.buffer); };
const valid = (h) => typeof h === "number" && h > 0 && h < 0xffffffffffff;
function readWide(p, max) {
  if (!p) return "";
  const length = Math.min(max, k.lstrlenW(p));
  if (length <= 0) return "";
  const units = new Uint16Array(length);
  k.RtlMoveMemory(new Uint8Array(units.buffer), p, BigInt(length * 2));
  return String.fromCharCode(...units);
}
const classBuf = new Uint16Array(64);
function className(hwnd) {
  const n = u.GetClassNameW(hwnd, new Uint8Array(classBuf.buffer), 64);
  return n > 0 ? String.fromCharCode(...classBuf.subarray(0, n)) : "";
}
const pidBuf = new Uint32Array(1);
function explorerPid() {
  const shellWnd = u.GetShellWindow();
  if (!shellWnd) return 0;
  pidBuf[0] = 0;
  u.GetWindowThreadProcessId(shellWnd, new Uint8Array(pidBuf.buffer));
  return pidBuf[0];
}
const APPBAR_CALLBACK = 0x8000 + 0x51;
const WM_SETTINGCHANGE = 0x1a, WM_POWERBROADCAST = 0x218, WM_DISPLAYCHANGE = 0x7e;
let shellHook = 0;
const taskbarCreated = u.RegisterWindowMessageW(wide("TaskbarCreated"));
let explorer = 0;
let showHook = null;
const onShow = new JSCallback((hook, event, target, idObject) => {
  if (idObject !== 0 || !target) return;
  const cls = className(target);
  if (cls === "Shell_TrayWnd" || cls === "Shell_SecondaryTrayWnd") postMessage({ type: "trayShown" });
}, { args: ["ptr", "u32", "ptr", "i32", "i32", "u32", "u32"], returns: "void" });
/** EVENT_OBJECT_SHOW from Explorer's process only: its taskbar coming back. */
function hookExplorer() {
  const pid = explorerPid();
  if (!pid || pid === explorer) return false;
  const restarted = explorer !== 0;
  explorer = pid;
  if (showHook) u.UnhookWinEvent(showHook);
  showHook = u.SetWinEventHook(0x8002, 0x8002, null, onShow.ptr, pid, 0, 0);
  return restarted;
}
const proc = new JSCallback((hwnd, msg, wParam, lParam) => {
  if (msg === shellHook && shellHook) {
    postMessage({ type: "shell", code: Number(wParam) & 0xffff, hwnd: Number(lParam) });
    return 0n;
  }
  if (msg === APPBAR_CALLBACK) {
    if (Number(wParam) === 2) postMessage({ type: "fullscreen", on: Number(lParam) !== 0 });
    return 0n;
  }
  if (msg === WM_SETTINGCHANGE) {
    postMessage({ type: "setting", action: Number(wParam), area: readWide(Number(lParam), 128) });
    return 0n;
  }
  if (msg === WM_POWERBROADCAST) {
    // PBT_APMPOWERSTATUSCHANGE, PBT_POWERSETTINGCHANGE (battery percentage, AC/DC source).
    if (Number(wParam) === 0xa || Number(wParam) === 0x8013) postMessage({ type: "power" });
    return 1n;
  }
  if (msg === WM_DISPLAYCHANGE) postMessage({ type: "display" });
  // Our own tray host broadcasts TaskbarCreated too: only a new Explorer process counts.
  if (msg === taskbarCreated && taskbarCreated) {
    if (hookExplorer()) postMessage({ type: "explorerRestarted" });
    return 0n;
  }
  return u.DefWindowProcW(hwnd, msg, wParam, lParam);
}, { args: ["ptr", "u32", "u64", "i64"], returns: "i64" });
const name = wide("WindowsBarShellEvents");
const wc = new Uint8Array(80);
const v = new DataView(wc.buffer);
const inst = k.GetModuleHandleW(null);
v.setUint32(0, 80, true);
v.setBigUint64(8, BigInt(proc.ptr), true);
v.setBigUint64(24, BigInt(inst ?? 0), true);
v.setBigUint64(64, BigInt(ptr(name)), true);
u.RegisterClassExW(wc);
const hwnd = u.CreateWindowExW(0x80, name, wide("WindowsBar shell events"), 0x80000000, 0, 0, 0, 0, null, null, inst, null);
shellHook = u.RegisterWindowMessageW(wide("SHELLHOOK"));
u.RegisterShellHookWindow(hwnd);
// A second AppBar that reserves nothing: Explorer sends every AppBar ABN_FULLSCREENAPP.
const abd = new Uint8Array(48);
const a = new DataView(abd.buffer);
a.setUint32(0, 48, true);
a.setBigUint64(8, BigInt(hwnd), true);
a.setUint32(16, APPBAR_CALLBACK, true);
shell.SHAppBarMessage(0, abd);
const onEvent = new JSCallback((hook, event, target, idObject) => {
  if (idObject !== 0 || !target) return;
  if (event === 3) postMessage({ type: "foreground", hwnd: Number(target) });
  else if (event === 0x16 || event === 0x17 || event === 0x8017 || event === 0x8018) postMessage({ type: "windowState", hwnd: Number(target) });
  // Not throttled here: a trailing event could be lost while this thread sleeps. main.tsx coalesces them.
  else if (Number(target) === Number(u.GetForegroundWindow())) postMessage({ type: "moved", hwnd: Number(target) });
}, { args: ["ptr", "u32", "ptr", "i32", "i32", "u32", "u32"], returns: "void" });
// WINEVENT_OUTOFCONTEXT (| WINEVENT_SKIPOWNPROCESS); delivered to this thread's message queue.
const hooks = [
  // EVENT_SYSTEM_FOREGROUND, the dock's own windows included: clicking the dock is how a flyout or
  // Start loses the foreground, and followForeground() needs to see that.
  u.SetWinEventHook(0x0003, 0x0003, null, onEvent.ptr, 0, 0, 0),
  u.SetWinEventHook(0x800b, 0x800b, null, onEvent.ptr, 0, 0, 0x2), // EVENT_OBJECT_LOCATIONCHANGE
  u.SetWinEventHook(0x0016, 0x0017, null, onEvent.ptr, 0, 0, 0x2), // EVENT_SYSTEM_MINIMIZESTART/END
  u.SetWinEventHook(0x8017, 0x8018, null, onEvent.ptr, 0, 0, 0x2), // EVENT_OBJECT_CLOAKED/UNCLOAKED
];
hookExplorer();
// Every percent of charge and every plug/unplug, as the taskbar's battery icon follows them.
const guid = (s) => {
  const h = s.replace(/-/g, "");
  const b = new Uint8Array(16);
  const g = new DataView(b.buffer);
  g.setUint32(0, parseInt(h.slice(0, 8), 16), true);
  g.setUint16(4, parseInt(h.slice(8, 12), 16), true);
  g.setUint16(6, parseInt(h.slice(12, 16), 16), true);
  for (let i = 0; i < 8; i++) b[8 + i] = parseInt(h.slice(16 + i * 2, 18 + i * 2), 16);
  return b;
};
const powerGuids = [guid("A7AD8041-B45A-4CAE-87A3-EECBB468A9E1"), guid("5D3E9A59-E9D5-4B00-A6BD-FF34FF516548")];
for (const g of powerGuids) u.RegisterPowerSettingNotification(hwnd, g, 0 /* DEVICE_NOTIFY_WINDOW_HANDLE */);
// Change notifications: one auto-reset event per registry key, one change handle per folder.
const watches = [];
const out8 = new BigUint64Array(1);
const armKey = (w) => reg.RegNotifyChangeKeyValue(w.key, w.subtree ? 1 : 0, 0x5 /* NAME | LAST_SET */, w.handle, 1) === 0;
for (const w of ${JSON.stringify(watches)}) {
  if (w.reg) {
    out8[0] = 0n;
    if (reg.RegOpenKeyExW(0x80000001n, wide(w.reg), 0, 0x20019 /* KEY_READ */, new Uint8Array(out8.buffer)) !== 0) continue;
    const item = { id: w.id, key: Number(out8[0]), subtree: !!w.subtree, handle: k.CreateEventW(null, 0, 0, null) };
    if (valid(item.handle) && armKey(item)) watches.push(item);
  } else {
    // FILE_NOTIFY_CHANGE_FILE_NAME | SIZE | LAST_WRITE
    const handle = k.FindFirstChangeNotificationW(wide(w.dir), 0, 0x19);
    if (valid(handle)) watches.push({ id: w.id, handle });
  }
}
const handles = new BigUint64Array(Math.max(1, watches.length));
watches.forEach((w, i) => (handles[i] = BigInt(w.handle)));
const handleBytes = new Uint8Array(handles.buffer);
postMessage({ type: "ready", threadId: k.GetCurrentThreadId() });
const msg = new Uint8Array(48);
const mv = new DataView(msg.buffer);
let running = true;
while (running) {
  // QS_ALLINPUT, MWMO_INPUTAVAILABLE: wakes for a signalled handle or any message (sent ones too).
  const r = u.MsgWaitForMultipleObjectsEx(watches.length, watches.length ? handleBytes : null, 0xffffffff, 0x4ff, 0x4);
  if (r < watches.length) {
    const w = watches[r];
    if (w.key !== undefined) armKey(w);
    else k.FindNextChangeNotification(w.handle);
    postMessage({ type: "changed", id: w.id });
    continue;
  }
  if (r !== watches.length) break;
  while (u.PeekMessageW(msg, null, 0, 0, 1)) {
    if (mv.getUint32(8, true) === 0x12 /* WM_QUIT */) { running = false; break; }
    u.TranslateMessage(msg);
    u.DispatchMessageW(msg);
  }
}
for (const h of hooks) u.UnhookWinEvent(h);
if (showHook) u.UnhookWinEvent(showHook);
shell.SHAppBarMessage(1, abd);
u.DeregisterShellHookWindow(hwnd);
u.DestroyWindow(hwnd);
`;
}
