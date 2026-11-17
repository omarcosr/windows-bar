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

const HOME = process.env.USERPROFILE ?? process.env.HOME ?? "";

/**
 * Registry keys (HKCU) and folders watched for changes, by id. A `lazy` watch is waited on only while
 * acquireWatch() holds it; `rest` (ms) is the least time between two of its events (a log appended to
 * many times a second reports once, then the change waiting in the handle when the rest ends).
 */
const WATCHES = {
  taskband: { reg: "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Taskband" },
  pinned: { dir: `${process.env.APPDATA}\\Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar` },
  // Subtree: the developer settings (End task) live in Advanced\TaskbarDeveloperSettings.
  advanced: { reg: "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced", subtree: true },
  search: { reg: "Software\\Microsoft\\Windows\\CurrentVersion\\Search" },
  personalize: { reg: "Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize" },
  dwm: { reg: "Software\\Microsoft\\Windows\\DWM" },
  notifyIcons: { reg: "Control Panel\\NotifyIconSettings", subtree: true },
  notifications: { dir: `${process.env.LOCALAPPDATA}\\Microsoft\\Windows\\Notifications` },
  // The local logs the AI widgets read (ai-usage.ts): Claude Code transcripts, Codex sessions, OpenCode's database.
  claudeProjects: { dir: `${process.env.CLAUDE_CONFIG_DIR || `${HOME}\\.claude`}\\projects`, subtree: true, lazy: true, rest: 10_000 },
  codexSessions: { dir: `${process.env.CODEX_HOME || `${HOME}\\.codex`}\\sessions`, subtree: true, lazy: true, rest: 10_000 },
  opencode: { dir: `${process.env.XDG_DATA_HOME || `${HOME}\\.local\\share`}\\opencode`, lazy: true, rest: 10_000 },
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
  /** The built-in panel's brightness changed (GUID_VIDEO_CURRENT_MONITOR_BRIGHTNESS), 0..100. */
  | { type: "brightness"; level: number }
  /** The console display turned off or on (GUID_CONSOLE_DISPLAY_STATE; dimmed counts as on). */
  | { type: "screen"; on: boolean }
  /** The session was locked or unlocked (WM_WTSSESSION_CHANGE). */
  | { type: "session"; locked: boolean }
  /** Something went into or out of the Recycle Bin (SHChangeNotify on CSIDL_BITBUCKET). */
  | { type: "recycleBin" }
  /** A drive's free space changed, or a drive or medium came or went (SHCNE_FREESPACE, SHCNE_DRIVE*). */
  | { type: "freeSpace" }
  /** A window passed to watchDestroyed() was destroyed (EVENT_OBJECT_DESTROY). */
  | { type: "destroyed"; hwnd: number }
  /** A standard popup menu opened or closed, while watchMenuPopups() holds it (EVENT_SYSTEM_MENUPOPUPSTART/END). */
  | { type: "menuPopup"; start: boolean }
  /** The pointer moved off the top-level window given to watchPointerLeave(). */
  | { type: "pointerLeft"; owner: number }
  /** The first pointer or caret movement after awaitInput(). */
  | { type: "input" }
  | { type: "display" }
  /** Explorer restarted (a new Explorer process announced TaskbarCreated). */
  | { type: "explorerRestarted" }
  /** Explorer showed its own taskbar window. */
  | { type: "trayShown" }
  /** The system time or time zone was set (WM_TIMECHANGE). */
  | { type: "time" }
  /** The PC woke from sleep or hibernation (PBT_APMRESUMEAUTOMATIC / PBT_APMRESUMESUSPEND; both may arrive). */
  | { type: "resume" }
  /** An IP address was added, removed or changed (NotifyAddrChange): a network came or went. */
  | { type: "network" }
  /**
   * The foreground window scrolled its content (EVENT_OBJECT_CONTENTSCROLLED, EVENT_SYSTEM_SCROLLINGEND),
   * while watchScrolled() holds it; at most one every 100 ms plus the last of a burst.
   */
  | { type: "scrolled" }
  | { type: "changed"; id: WatchId };

export const HSHELL = {
  WINDOWCREATED: 1,
  WINDOWDESTROYED: 2,
  WINDOWACTIVATED: 4,
  REDRAW: 6,
  LANGUAGE: 8,
  /** A WM_APPCOMMAND no window handled (media, volume and microphone keys); hwnd carries its lParam. */
  APPCOMMAND: 12,
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

// Requests to the worker: thread messages its loop reads before dispatching (WM_APP + 0x60..).
const CTL_DESTROY = 0x8060, CTL_POINTER = 0x8061, CTL_INPUT = 0x8062, CTL_WATCH = 0x8063, CTL_MENU = 0x8064, CTL_SCROLL = 0x8065;
let threadId = 0;
let user: ReturnType<typeof openUser> | undefined;
const openUser = () => dlopen("user32.dll", { PostThreadMessageW: { args: ["u32", "u32", "u64", "i64"], returns: "i32" } });
const destroyWatched = new Set<number>();
const pointerOwners = new Map<number, number>();
const watchUsers = new Map<WatchId, number>();
let menuUsers = 0;
let scrollUsers = 0;
let awaitingInput = false;

function send(msg: number, wParam: number, lParam: number) {
  if (threadId && user) user.symbols.PostThreadMessageW(threadId, msg, BigInt(wParam), BigInt(lParam));
}

/** Tells a worker that just started (or restarted) everything asked of it so far. */
function resend() {
  for (const hwnd of destroyWatched) send(CTL_DESTROY, hwnd, 1);
  for (const owner of pointerOwners.keys()) send(CTL_POINTER, owner, 1);
  for (const id of watchUsers.keys()) send(CTL_WATCH, Object.keys(WATCHES).indexOf(id), 1);
  if (menuUsers) send(CTL_MENU, 0, 1);
  if (scrollUsers) send(CTL_SCROLL, 0, 1);
  if (awaitingInput) send(CTL_INPUT, 0, 1);
}

/**
 * The windows whose destruction should be reported ({ type: "destroyed" }): the worker hooks
 * EVENT_OBJECT_DESTROY only while the set is not empty and filters it, so the JS thread wakes only
 * for these. Hidden windows count too, which the shell hook never reports.
 */
export function watchDestroyed(hwnds: Iterable<number>) {
  const next = new Set([...hwnds].filter((h) => h > 0));
  for (const h of destroyWatched) if (!next.has(h)) send(CTL_DESTROY, h, 0);
  for (const h of next) if (!destroyWatched.has(h)) send(CTL_DESTROY, h, 1);
  destroyWatched.clear();
  for (const h of next) destroyWatched.add(h);
}

onShellEvent((event) => {
  if (event.type === "destroyed") destroyWatched.delete(event.hwnd);
  else if (event.type === "pointerLeft") pointerOwners.delete(event.owner);
  else if (event.type === "input") awaitingInput = false;
});

/**
 * Reports { type: "pointerLeft", owner } once the pointer moves over another top-level window: an
 * out-of-context EVENT_OBJECT_LOCATIONCHANGE hook on OBJID_CURSOR, installed only while someone
 * waits. Returns the cancel function.
 */
export function watchPointerLeave(owner: number): () => void {
  pointerOwners.set(owner, (pointerOwners.get(owner) ?? 0) + 1);
  if (pointerOwners.get(owner) === 1) send(CTL_POINTER, owner, 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const n = (pointerOwners.get(owner) ?? 0) - 1;
    if (n > 0) return void pointerOwners.set(owner, n);
    if (pointerOwners.delete(owner)) send(CTL_POINTER, owner, 0);
  };
}

/** Reports { type: "input" } once, at the next pointer or caret movement (cursor/caret WinEvents). */
export function awaitInput() {
  if (awaitingInput) return;
  awaitingInput = true;
  send(CTL_INPUT, 0, 1);
}

/** Holds the { type: "menuPopup" } events (EVENT_SYSTEM_MENUPOPUPSTART/END); returns the release function. */
export function watchMenuPopups(): () => void {
  if (menuUsers++ === 0) send(CTL_MENU, 0, 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    if (--menuUsers === 0) send(CTL_MENU, 0, 0);
  };
}

/**
 * Holds the { type: "scrolled" } events: the worker hooks EVENT_OBJECT_CONTENTSCROLLED and
 * EVENT_SYSTEM_SCROLLINGEND only while someone holds them and keeps those of the foreground window.
 * Returns the release function.
 */
export function watchScrolled(): () => void {
  if (scrollUsers++ === 0) send(CTL_SCROLL, 0, 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    if (--scrollUsers === 0) send(CTL_SCROLL, 0, 0);
  };
}

/** Waits on a lazy watch (WATCHES[id].lazy) while held; returns the release function. */
export function acquireWatch(id: WatchId): () => void {
  const n = (watchUsers.get(id) ?? 0) + 1;
  watchUsers.set(id, n);
  if (n === 1) send(CTL_WATCH, Object.keys(WATCHES).indexOf(id), 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const left = (watchUsers.get(id) ?? 0) - 1;
    if (left > 0) return void watchUsers.set(id, left);
    watchUsers.delete(id);
    send(CTL_WATCH, Object.keys(WATCHES).indexOf(id), 0);
  };
}

export function startShellEvents(onEvent: (event: ShellEvent) => void) {
  if (worker) return;
  user ??= openUser();
  worker = startWorker<ShellEvent | { type: "ready"; threadId: number }>(shellWorkerSource(), data => {
    if (data.type === "ready") {
      threadId = data.threadId;
      resend();
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
    if (threadId) user?.symbols.PostThreadMessageW(threadId, 0x12, 0n, 0n);
  });
  onExit(() => {
    worker?.terminate();
    worker = undefined;
    threadId = 0;
    user?.close();
    user = undefined;
  });
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
  GetCursorPos: { args: ["ptr"], returns: "i32" },
  WindowFromPoint: { args: ["u64"], returns: "ptr" },
  GetAncestor: { args: ["ptr", "u32"], returns: "ptr" },
}).symbols;
const shell = dlopen("shell32.dll", {
  SHAppBarMessage: { args: ["u32", "ptr"], returns: "u64" },
  SHGetSpecialFolderLocation: { args: ["ptr", "i32", "ptr"], returns: "i32" },
  SHChangeNotifyRegister: { args: ["ptr", "i32", "i32", "u32", "i32", "ptr"], returns: "u32" },
  SHChangeNotifyDeregister: { args: ["u32"], returns: "i32" },
  ILCreateFromPathW: { args: ["ptr"], returns: "ptr" },
}).symbols;
const wts = dlopen("wtsapi32.dll", {
  WTSRegisterSessionNotification: { args: ["ptr", "u32"], returns: "i32" },
  WTSUnRegisterSessionNotification: { args: ["ptr"], returns: "i32" },
}).symbols;
const ip = dlopen("iphlpapi.dll", {
  NotifyAddrChange: { args: ["ptr", "ptr"], returns: "u32" },
  CancelIPChangeNotify: { args: ["ptr"], returns: "i32" },
}).symbols;
const k = dlopen("kernel32.dll", {
  GetModuleHandleW: { args: ["ptr"], returns: "ptr" },
  GetCurrentThreadId: { args: [], returns: "u32" },
  CreateEventW: { args: ["ptr", "i32", "i32", "ptr"], returns: "ptr" },
  FindFirstChangeNotificationW: { args: ["ptr", "i32", "u32"], returns: "ptr" },
  FindNextChangeNotification: { args: ["ptr"], returns: "i32" },
  lstrlenW: { args: ["ptr"], returns: "i32" },
  GetLogicalDrives: { args: [], returns: "u32" },
  GetDriveTypeW: { args: ["ptr"], returns: "u32" },
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
const WM_SETTINGCHANGE = 0x1a, WM_POWERBROADCAST = 0x218, WM_DISPLAYCHANGE = 0x7e, WM_WTSSESSION_CHANGE = 0x2b1, WM_TIMECHANGE = 0x1e;
// SHChangeNotifyRegister callback messages: the Recycle Bin, and drives' free space.
const MSG_RECYCLE = 0x8070, MSG_FREESPACE = 0x8071;
const setting = new Uint8Array(24), settingView = new DataView(setting.buffer);
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
    const code = Number(wParam);
    if (code === 0xa /* PBT_APMPOWERSTATUSCHANGE */) postMessage({ type: "power" });
    else if (code === 0x12 /* PBT_APMRESUMEAUTOMATIC */ || code === 0x7 /* PBT_APMRESUMESUSPEND */) postMessage({ type: "resume" });
    else if (code === 0x8013 /* PBT_POWERSETTINGCHANGE */ && lParam) {
      // POWERBROADCAST_SETTING: PowerSetting (GUID), DataLength, Data (a DWORD for these settings).
      k.RtlMoveMemory(setting, Number(lParam), 24n);
      const id = settingView.getUint32(0, true), value = settingView.getUint32(20, true);
      if (id === 0x8ffee2c6) postMessage({ type: "brightness", level: value });
      else if (id === 0x6fe69556) postMessage({ type: "screen", on: value !== 0 });
      else postMessage({ type: "power" });
    }
    return 1n;
  }
  if (msg === WM_WTSSESSION_CHANGE) {
    const code = Number(wParam);
    if (code === 7 || code === 8) postMessage({ type: "session", locked: code === 7 }); // WTS_SESSION_LOCK / UNLOCK
    return 0n;
  }
  if (msg === MSG_RECYCLE) {
    postMessage({ type: "recycleBin" });
    return 0n;
  }
  if (msg === MSG_FREESPACE) {
    postMessage({ type: "freeSpace" });
    return 0n;
  }
  if (msg === WM_TIMECHANGE) {
    postMessage({ type: "time" });
    return 0n;
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
// Then the panel brightness the quick settings slider follows, and the display turning off or on.
// Windows sends each setting's current value right away, then every change.
const powerGuids = [
  guid("A7AD8041-B45A-4CAE-87A3-EECBB468A9E1"), // GUID_BATTERY_PERCENTAGE_REMAINING
  guid("5D3E9A59-E9D5-4B00-A6BD-FF34FF516548"), // GUID_ACDC_POWER_SOURCE
  guid("8FFEE2C6-2D01-46BE-ADB9-398ADDC5B4FF"), // GUID_VIDEO_CURRENT_MONITOR_BRIGHTNESS
  guid("6FE69556-704A-47A0-8F24-C28D936FDA47"), // GUID_CONSOLE_DISPLAY_STATE
];
for (const g of powerGuids) u.RegisterPowerSettingNotification(hwnd, g, 0 /* DEVICE_NOTIFY_WINDOW_HANDLE */);
// Lock and unlock of this session.
wts.WTSRegisterSessionNotification(hwnd, 0 /* NOTIFY_FOR_THIS_SESSION */);
const winEventArgs = { args: ["ptr", "u32", "ptr", "i32", "i32", "u32", "u32"], returns: "void" };
// Hooks installed only while the JS thread asks for them (thread messages, see control()).
const destroyWatch = new Set();
let destroyHook = null;
const onDestroy = new JSCallback((hook, event, target, idObject) => {
  if (idObject !== 0 || !target) return;
  const h = Number(target);
  if (!destroyWatch.delete(h)) return;
  postMessage({ type: "destroyed", hwnd: h });
  syncHooks();
}, winEventArgs);
let menuWanted = false, menuHook = null;
const onMenu = new JSCallback((hook, event) => { postMessage({ type: "menuPopup", start: event === 6 }); }, winEventArgs);
const pointerOwners = new Set();
let awaitingInput = false, pointerHook = null;
const cursor = new Int32Array(2);
const onPointer = new JSCallback((hook, event, target, idObject) => {
  // OBJID_CURSOR, OBJID_CARET: the pointer moved, or the user typed somewhere.
  if (idObject !== -9 && idObject !== -8) return;
  if (awaitingInput) {
    awaitingInput = false;
    postMessage({ type: "input" });
  }
  if (idObject === -9 && pointerOwners.size) {
    u.GetCursorPos(new Uint8Array(cursor.buffer));
    const at = u.WindowFromPoint((BigInt(cursor[1] >>> 0) << 32n) | BigInt(cursor[0] >>> 0));
    const root = at ? Number(u.GetAncestor(at, 2 /* GA_ROOT */)) : 0;
    for (const owner of pointerOwners) {
      if (owner === root) continue;
      pointerOwners.delete(owner);
      postMessage({ type: "pointerLeft", owner });
    }
  }
  syncHooks();
}, winEventArgs);
// Scrolling reports many events a second: one now, then the last of the burst once SCROLL_REST passed
// (the wait loop's timeout flushes it).
const SCROLL_REST = 100;
let scrollWanted = false, scrollHooks = null, scrollLast = 0, scrollPending = false;
const onScroll = new JSCallback((hook, event, target) => {
  if (!target) return;
  const fg = Number(u.GetForegroundWindow());
  if (!fg || (Number(target) !== fg && Number(u.GetAncestor(target, 2 /* GA_ROOT */)) !== fg)) return;
  if (Date.now() - scrollLast >= SCROLL_REST) postScroll();
  else scrollPending = true;
}, winEventArgs);
function postScroll() {
  scrollLast = Date.now();
  scrollPending = false;
  postMessage({ type: "scrolled" });
}
function syncHook(hook, want, install) {
  if (want && !hook) return install();
  if (!want && hook) u.UnhookWinEvent(hook);
  return want ? hook : null;
}
function syncHooks() {
  // EVENT_OBJECT_DESTROY; EVENT_SYSTEM_MENUPOPUPSTART..END; EVENT_OBJECT_LOCATIONCHANGE, own process included.
  destroyHook = syncHook(destroyHook, destroyWatch.size > 0, () => u.SetWinEventHook(0x8001, 0x8001, null, onDestroy.ptr, 0, 0, 0x2));
  menuHook = syncHook(menuHook, menuWanted, () => u.SetWinEventHook(0x0006, 0x0007, null, onMenu.ptr, 0, 0, 0x2));
  pointerHook = syncHook(pointerHook, awaitingInput || pointerOwners.size > 0, () => u.SetWinEventHook(0x800b, 0x800b, null, onPointer.ptr, 0, 0, 0));
  // EVENT_OBJECT_CONTENTSCROLLED; EVENT_SYSTEM_SCROLLINGEND (two hooks: one range would take every event between).
  if (scrollWanted && !scrollHooks) scrollHooks = [u.SetWinEventHook(0x8015, 0x8015, null, onScroll.ptr, 0, 0, 0x2), u.SetWinEventHook(0x0013, 0x0013, null, onScroll.ptr, 0, 0, 0x2)];
  else if (!scrollWanted && scrollHooks) {
    for (const h of scrollHooks) if (h) u.UnhookWinEvent(h);
    scrollHooks = null;
    scrollPending = false;
  }
}
/** A request from the JS thread (watchDestroyed, watchPointerLeave, awaitInput, acquireWatch, watchMenuPopups, watchScrolled). */
function control(m, w, l) {
  if (m === 0x8060) l ? destroyWatch.add(w) : destroyWatch.delete(w);
  else if (m === 0x8061) l ? pointerOwners.add(w) : pointerOwners.delete(w);
  else if (m === 0x8062) awaitingInput = !!l;
  else if (m === 0x8063) { for (const x of watches) if (x.index === w) x.enabled = !!l; }
  else if (m === 0x8064) menuWanted = !!l;
  else if (m === 0x8065) scrollWanted = !!l;
  syncHooks();
}
// Change notifications: one auto-reset event per registry key, one change handle per folder.
const watches = [];
const out8 = new BigUint64Array(1);
const armKey = (w) => reg.RegNotifyChangeKeyValue(w.key, w.subtree ? 1 : 0, 0x5 /* NAME | LAST_SET */, w.handle, 1) === 0;
${JSON.stringify(watches)}.forEach((w, index) => {
  const base = { id: w.id, index, enabled: !w.lazy, rest: w.rest || 0, restUntil: 0 };
  if (w.reg) {
    out8[0] = 0n;
    if (reg.RegOpenKeyExW(0x80000001n, wide(w.reg), 0, 0x20019 /* KEY_READ */, new Uint8Array(out8.buffer)) !== 0) return;
    const item = { ...base, key: Number(out8[0]), subtree: !!w.subtree, handle: k.CreateEventW(null, 0, 0, null) };
    if (valid(item.handle) && armKey(item)) watches.push(item);
  } else {
    // FILE_NOTIFY_CHANGE_FILE_NAME | SIZE | LAST_WRITE
    const handle = k.FindFirstChangeNotificationW(wide(w.dir), w.subtree ? 1 : 0, 0x19);
    if (valid(handle)) watches.push({ ...base, handle });
  }
});
// The shell's own change notifications (SHChangeNotifyRegister), as Explorer's Recycle Bin and This PC
// follow them. Recycling reports SHCNE_DELETE of the file and SHCNE_CREATE of its copy under the drive's
// $Recycle.Bin folder (a file system path, not the CSIDL_BITBUCKET namespace), so each fixed drive's
// $Recycle.Bin is registered, recursive, for SHCNE_RENAMEITEM | CREATE | DELETE | MKDIR | RMDIR |
// UPDATEDIR | UPDATEITEM | UPDATEIMAGE | RENAMEFOLDER; the bin itself too, for emptying it.
// SHCNE_FREESPACE | DRIVEADD | DRIVEREMOVED | MEDIAINSERTED | MEDIAREMOVED from anywhere.
const notifyIds = [];
function changeNotify(pidl, sources, events, message) {
  if (!pidl) return;
  const entry = new Uint8Array(16), e = new DataView(entry.buffer);
  e.setBigUint64(0, BigInt(pidl), true);
  e.setInt32(8, 1, true); // fRecursive
  const id = shell.SHChangeNotifyRegister(hwnd, sources, events, message, 1, entry);
  if (id) notifyIds.push(id);
}
function folder(csidl) {
  out8[0] = 0n;
  return shell.SHGetSpecialFolderLocation(null, csidl, new Uint8Array(out8.buffer)) === 0 ? Number(out8[0]) : 0;
}
const drives = k.GetLogicalDrives();
for (let i = 0; i < 26; i++) {
  if (!(drives & (1 << i))) continue;
  const root = String.fromCharCode(65 + i) + ":\\\\";
  if (k.GetDriveTypeW(wide(root)) !== 3 /* DRIVE_FIXED */) continue;
  changeNotify(shell.ILCreateFromPathW(wide(root + "$Recycle.Bin")), 0x3 /* InterruptLevel | ShellLevel */, 0x2b01f, MSG_RECYCLE);
}
changeNotify(folder(0x000a /* CSIDL_BITBUCKET */), 0x2 /* ShellLevel */, 0x2b01f, MSG_RECYCLE);
changeNotify(folder(0x0000 /* CSIDL_DESKTOP */), 0x2 /* ShellLevel */, 0x401e0, MSG_FREESPACE);
// IP address changes (a network came or went): NotifyAddrChange with an OVERLAPPED completes by
// signalling its event, waited with the watches; it is asked again after each signal. The OVERLAPPED
// lives as long as the worker (CancelIPChangeNotify at the end).
const overlapped = new Uint8Array(32), addrHandle = new BigUint64Array(1);
const armAddr = () => ip.NotifyAddrChange(new Uint8Array(addrHandle.buffer), overlapped) === 997 /* ERROR_IO_PENDING */;
const addrEvent = k.CreateEventW(null, 0, 0, null);
let addrArmed = false;
if (valid(addrEvent)) {
  new DataView(overlapped.buffer).setBigUint64(24, BigInt(addrEvent), true); // hEvent
  addrArmed = armAddr();
  if (addrArmed) watches.push({ id: null, network: true, enabled: true, rest: 0, restUntil: 0, handle: addrEvent });
}
const handles = new BigUint64Array(Math.max(1, watches.length));
const handleBytes = new Uint8Array(handles.buffer);
postMessage({ type: "ready", threadId: k.GetCurrentThreadId() });
const msg = new Uint8Array(48);
const mv = new DataView(msg.buffer);
let running = true;
while (running) {
  if (scrollPending && Date.now() - scrollLast >= SCROLL_REST) postScroll();
  // Lazy watches nobody holds and watches resting after an event are left out of the wait.
  const now = Date.now();
  const live = [];
  let timeout = 0xffffffff;
  if (scrollPending) timeout = Math.max(0, scrollLast + SCROLL_REST - now);
  for (const w of watches) {
    if (!w.enabled) continue;
    if (w.restUntil > now) { timeout = Math.min(timeout, w.restUntil - now); continue; }
    handles[live.length] = BigInt(w.handle);
    live.push(w);
  }
  // QS_ALLINPUT, MWMO_INPUTAVAILABLE: wakes for a signalled handle or any message (sent ones too).
  const r = u.MsgWaitForMultipleObjectsEx(live.length, live.length ? handleBytes : null, timeout, 0x4ff, 0x4);
  if (r === 0x102 /* WAIT_TIMEOUT: a rest ended */) continue;
  if (r < live.length) {
    const w = live[r];
    if (w.network) {
      armAddr();
      postMessage({ type: "network" });
      continue;
    }
    if (w.key !== undefined) armKey(w);
    else k.FindNextChangeNotification(w.handle);
    if (w.rest) w.restUntil = Date.now() + w.rest;
    postMessage({ type: "changed", id: w.id });
    continue;
  }
  if (r !== live.length) break;
  while (u.PeekMessageW(msg, null, 0, 0, 1)) {
    const m = mv.getUint32(8, true);
    if (m === 0x12 /* WM_QUIT */) { running = false; break; }
    if (mv.getBigUint64(0, true) === 0n && m >= 0x8060 && m <= 0x806f) {
      control(m, Number(mv.getBigUint64(16, true)), Number(mv.getBigInt64(24, true)));
      continue;
    }
    u.TranslateMessage(msg);
    u.DispatchMessageW(msg);
  }
}
for (const h of hooks) u.UnhookWinEvent(h);
for (const h of [destroyHook, menuHook, pointerHook, ...(scrollHooks ?? [])]) if (h) u.UnhookWinEvent(h);
if (addrArmed) ip.CancelIPChangeNotify(overlapped);
for (const id of notifyIds) shell.SHChangeNotifyDeregister(id);
wts.WTSUnRegisterSessionNotification(hwnd);
if (showHook) u.UnhookWinEvent(showHook);
shell.SHAppBarMessage(1, abd);
u.DeregisterShellHookWindow(hwnd);
u.DestroyWindow(hwnd);
`;
}
