import { messageWindow, threadsafeCallback, type MessageWindow, type MessageWindowEvent, type MessageWindowWinEvent, type ThreadsafeCallback } from "@tarve/core";
import { existsSync } from "node:fs";
import { dlopen } from "./ffi.ts";
import { encodeWide } from "./wide.ts";
import { onExit } from "../services/exit.ts";

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
 * Tarve's messageWindow() owns the hidden windows and the hooks on native threads of their own and
 * delivers what arrives to the JS thread: nothing is polled. Hooks needed only for a while (or
 * scoped to one thread or process) get a window of their own, opened and disposed as needed.
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

type WatchSpec = { reg?: string; dir?: string; subtree?: boolean; lazy?: boolean; rest?: number };
const watchSpecs = Object.entries(WATCHES) as [WatchId, WatchSpec][];

const APPBAR_CALLBACK = 0x8000 + 0x51;
const WM_SETTINGCHANGE = 0x1a, WM_POWERBROADCAST = 0x218, WM_DISPLAYCHANGE = 0x7e, WM_WTSSESSION_CHANGE = 0x2b1, WM_TIMECHANGE = 0x1e;
// SHChangeNotifyRegister callback messages: the Recycle Bin, and drives' free space.
const MSG_RECYCLE = 0x8070, MSG_FREESPACE = 0x8071;
const EVENT_SYSTEM_FOREGROUND = 0x0003;
const OBJID_CURSOR = -9, OBJID_CARET = -8;

const openNative = () => ({
  user: dlopen("user32.dll", {
    GetForegroundWindow: { args: [], returns: "ptr" },
    GetShellWindow: { args: [], returns: "ptr" },
    GetWindowThreadProcessId: { args: ["ptr", "ptr"], returns: "u32" },
    GetClassNameW: { args: ["ptr", "ptr", "i32"], returns: "i32" },
    GetAncestor: { args: ["ptr", "u32"], returns: "ptr" },
    GetCursorPos: { args: ["ptr"], returns: "i32" },
    WindowFromPoint: { args: ["u64"], returns: "ptr" },
    RegisterPowerSettingNotification: { args: ["ptr", "ptr", "u32"], returns: "ptr" },
    UnregisterPowerSettingNotification: { args: ["ptr"], returns: "i32" },
  }),
  shell: dlopen("shell32.dll", {
    SHAppBarMessage: { args: ["u32", "ptr"], returns: "u64" },
    SHGetSpecialFolderLocation: { args: ["ptr", "i32", "ptr"], returns: "i32" },
    SHChangeNotifyRegister: { args: ["ptr", "i32", "i32", "u32", "i32", "ptr"], returns: "u32" },
    SHChangeNotifyDeregister: { args: ["u32"], returns: "i32" },
    SHChangeNotification_Lock: { args: ["ptr", "u32", "ptr", "ptr"], returns: "ptr" },
    SHChangeNotification_Unlock: { args: ["ptr"], returns: "i32" },
    ILCreateFromPathW: { args: ["ptr"], returns: "ptr" },
  }),
  wts: dlopen("wtsapi32.dll", {
    WTSRegisterSessionNotification: { args: ["ptr", "u32"], returns: "i32" },
    WTSUnRegisterSessionNotification: { args: ["ptr"], returns: "i32" },
  }),
  ip: dlopen("iphlpapi.dll", {
    NotifyUnicastIpAddressChange: { args: ["u16", "ptr", "ptr", "u8", "ptr"], returns: "u32" },
    CancelMibChangeNotify2: { args: ["ptr"], returns: "u32" },
  }),
  kernel: dlopen("kernel32.dll", {
    GetLogicalDrives: { args: [], returns: "u32" },
    GetDriveTypeW: { args: ["ptr"], returns: "u32" },
  }),
  reg: dlopen("advapi32.dll", {
    RegOpenKeyExW: { args: ["u64", "ptr", "u32", "u32", "ptr"], returns: "i32" },
    RegCloseKey: { args: ["ptr"], returns: "i32" },
  }),
});
let native: ReturnType<typeof openNative> | undefined;
const N = () => (native ??= openNative());

let sink: ((event: ShellEvent) => void) | undefined;
function emit(event: ShellEvent) {
  sink?.(event);
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (error) {
      console.error("[shell-events]", error);
    }
  }
}

const out = new Uint32Array(2);
const outBytes = new Uint8Array(out.buffer);
/** The thread that owns hwnd (0 when gone) and its process. */
function ownerOf(hwnd: number) {
  out[0] = 0;
  const thread = hwnd ? N().user.symbols.GetWindowThreadProcessId(hwnd, outBytes) as number : 0;
  return { thread, pid: out[0]! };
}
const classBuf = new Uint16Array(64);
function className(hwnd: number) {
  const n = N().user.symbols.GetClassNameW(hwnd, new Uint8Array(classBuf.buffer), 64) as number;
  return n > 0 ? String.fromCharCode(...classBuf.subarray(0, n)) : "";
}
const foreground = () => Number(N().user.symbols.GetForegroundWindow() ?? 0);

/** A message-only window that only hooks `winEvents` (out of context, on its own thread). */
function hookWindow(winEvents: MessageWindowWinEvent[], onEvent: (event: Extract<MessageWindowEvent, { type: "winEvent" }>) => void): MessageWindow | null {
  try {
    return messageWindow({ messageOnly: true, winEvents, onMessage: (event) => void (event.type === "winEvent" && onEvent(event)) });
  } catch (error) {
    console.error("[shell-events]", error);
    return null;
  }
}

let core: MessageWindow | undefined;
const closers: (() => void)[] = [];

// ---------- Change notifications on registry keys and folders ----------

function watchExists(spec: WatchSpec) {
  if (spec.dir) return existsSync(spec.dir);
  const key = new BigUint64Array(1);
  const reg = N().reg.symbols;
  if (reg.RegOpenKeyExW(0x80000001n, encodeWide(spec.reg!), 0, 0x20019 /* KEY_READ */, new Uint8Array(key.buffer)) !== 0) return false;
  reg.RegCloseKey(Number(key[0]));
  return true;
}
const registryWatch = (spec: WatchSpec) => ({ key: `HKCU\\${spec.reg}`, subtree: !!spec.subtree });
// FILE_NOTIFY_CHANGE_FILE_NAME | SIZE | LAST_WRITE
const folderWatch = (spec: WatchSpec) => ({ path: spec.dir!, subtree: !!spec.subtree, filter: 0x19 });

const restUntil = new Map<WatchId, number>();
const restTimers = new Map<WatchId, ReturnType<typeof setTimeout>>();
/** One change of a watch; a watch with `rest` reports at most one per rest, then the last one held back. */
function watchChanged(id: WatchId) {
  const rest = WATCHES[id] && (WATCHES[id] as WatchSpec).rest;
  if (!rest) return emit({ type: "changed", id });
  const now = Date.now();
  const until = restUntil.get(id) ?? 0;
  if (now >= until) {
    restUntil.set(id, now + rest);
    return emit({ type: "changed", id });
  }
  if (restTimers.has(id)) return;
  restTimers.set(id, setTimeout(() => {
    restTimers.delete(id);
    restUntil.set(id, Date.now() + rest);
    emit({ type: "changed", id });
  }, until - now));
}

const watchUsers = new Map<WatchId, number>();
const lazyWindows = new Map<WatchId, MessageWindow | null>();
function openLazy(id: WatchId) {
  const spec = WATCHES[id] as WatchSpec;
  let window: MessageWindow | null = null;
  if (watchExists(spec)) {
    try {
      window = messageWindow({
        messageOnly: true,
        registry: spec.reg ? [registryWatch(spec)] : [],
        folders: spec.dir ? [folderWatch(spec)] : [],
        onMessage: (event) => void ((event.type === "registry" || event.type === "folder") && !event.ended && watchChanged(id)),
      });
    } catch (error) {
      console.error("[shell-events]", error);
    }
  }
  lazyWindows.set(id, window);
}
function closeLazy(id: WatchId) {
  lazyWindows.get(id)?.dispose();
  lazyWindows.delete(id);
  clearTimeout(restTimers.get(id));
  restTimers.delete(id);
}

/** Waits on a lazy watch (WATCHES[id].lazy) while held; returns the release function. */
export function acquireWatch(id: WatchId): () => void {
  const n = (watchUsers.get(id) ?? 0) + 1;
  watchUsers.set(id, n);
  if (n === 1 && core) openLazy(id);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const left = (watchUsers.get(id) ?? 0) - 1;
    if (left > 0) return void watchUsers.set(id, left);
    watchUsers.delete(id);
    closeLazy(id);
  };
}

// ---------- Hooks held only while someone asks ----------

/** The windows watchDestroyed() follows, with the thread each belongs to. */
const destroyWatched = new Map<number, number>();
let destroyHook: MessageWindow | null = null;
let destroyThreads = "";
/**
 * EVENT_OBJECT_DESTROY hooked on the threads that own the watched windows only (one hook each),
 * so only their windows' destruction wakes the JS thread.
 */
function syncDestroyHook() {
  if (!core) return;
  // A window can die without its EVENT_OBJECT_DESTROY reaching us (its process killed, Explorer
  // restarting): drop it here and report it, since SetWinEventHook fails for a thread that no
  // longer exists, and one dead thread made the whole hook fail.
  for (const [hwnd, thread] of [...destroyWatched]) {
    if (ownerOf(hwnd).thread === thread) continue;
    destroyWatched.delete(hwnd);
    queueMicrotask(() => emit({ type: "destroyed", hwnd }));
  }
  const threads = [...new Set(destroyWatched.values())].sort((a, b) => a - b);
  const key = threads.join(",");
  if (key === destroyThreads) return;
  destroyThreads = key;
  destroyHook?.dispose();
  destroyHook = threads.length ? hookWindow(threads.map((thread) => ({ min: 0x8001, thread })), (event) => {
    const hwnd = Number(event.hwnd);
    if (event.idObject !== 0 || !destroyWatched.delete(hwnd)) return;
    emit({ type: "destroyed", hwnd });
    queueMicrotask(syncDestroyHook);
  }) : null;
  // A thread can still end between the check and the hook: try again on the next change.
  if (!destroyHook && threads.length) destroyThreads = "";
}

/**
 * The windows whose destruction should be reported ({ type: "destroyed" }); hidden windows count
 * too, which the shell hook never reports. The dock's own windows are not reported.
 */
export function watchDestroyed(hwnds: Iterable<number>) {
  const next = new Set([...hwnds].filter((h) => h > 0));
  for (const h of destroyWatched.keys()) if (!next.has(h)) destroyWatched.delete(h);
  for (const h of next) {
    if (destroyWatched.has(h)) continue;
    const owner = ownerOf(h);
    if (owner.thread && owner.pid !== process.pid) destroyWatched.set(h, owner.thread);
  }
  syncDestroyHook();
}

const pointerOwners = new Map<number, number>();
let awaitingInput = false;
let pointerHook: MessageWindow | null = null;
const cursor = new Int32Array(2);
/** EVENT_OBJECT_LOCATIONCHANGE everywhere (the dock's own process included), while someone waits. */
function syncPointerHook() {
  if (!core) return;
  const want = awaitingInput || pointerOwners.size > 0;
  if (want && !pointerHook) pointerHook = hookWindow([{ min: 0x800b }], onPointer);
  else if (!want && pointerHook) {
    pointerHook.dispose();
    pointerHook = null;
  }
}
function onPointer(event: { idObject: number }) {
  // OBJID_CURSOR, OBJID_CARET: the pointer moved, or the user typed somewhere.
  if (event.idObject !== OBJID_CURSOR && event.idObject !== OBJID_CARET) return;
  if (awaitingInput) {
    awaitingInput = false;
    emit({ type: "input" });
  }
  if (event.idObject === OBJID_CURSOR && pointerOwners.size) {
    const user = N().user.symbols;
    user.GetCursorPos(new Uint8Array(cursor.buffer));
    const at = user.WindowFromPoint((BigInt(cursor[1]! >>> 0) << 32n) | BigInt(cursor[0]! >>> 0));
    const root = at ? Number(user.GetAncestor(at, 2 /* GA_ROOT */)) : 0;
    for (const owner of [...pointerOwners.keys()]) {
      if (owner === root) continue;
      pointerOwners.delete(owner);
      emit({ type: "pointerLeft", owner });
    }
  }
  queueMicrotask(syncPointerHook);
}

/**
 * Reports { type: "pointerLeft", owner } once the pointer moves over another top-level window: an
 * out-of-context EVENT_OBJECT_LOCATIONCHANGE hook on OBJID_CURSOR, installed only while someone
 * waits. Returns the cancel function.
 */
export function watchPointerLeave(owner: number): () => void {
  pointerOwners.set(owner, (pointerOwners.get(owner) ?? 0) + 1);
  syncPointerHook();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const n = (pointerOwners.get(owner) ?? 0) - 1;
    if (n > 0) return void pointerOwners.set(owner, n);
    pointerOwners.delete(owner);
    syncPointerHook();
  };
}

/** Reports { type: "input" } once, at the next pointer or caret movement (cursor/caret WinEvents). */
export function awaitInput() {
  if (awaitingInput) return;
  awaitingInput = true;
  syncPointerHook();
}

let menuUsers = 0;
let menuHook: MessageWindow | null = null;
function syncMenuHook() {
  if (!core) return;
  // EVENT_SYSTEM_MENUPOPUPSTART..END
  if (menuUsers && !menuHook) menuHook = hookWindow([{ min: 0x0006, max: 0x0007, skipOwnProcess: true }], (event) => emit({ type: "menuPopup", start: event.event === 0x0006 }));
  else if (!menuUsers && menuHook) {
    menuHook.dispose();
    menuHook = null;
  }
}

/** Holds the { type: "menuPopup" } events (EVENT_SYSTEM_MENUPOPUPSTART/END); returns the release function. */
export function watchMenuPopups(): () => void {
  menuUsers++;
  syncMenuHook();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    menuUsers--;
    syncMenuHook();
  };
}

// Scrolling reports many events a second: one now, then the last of the burst once SCROLL_REST passed.
const SCROLL_REST = 100;
let scrollUsers = 0;
let scrollHook: MessageWindow | null = null;
let scrollLast = 0;
let scrollTimer: ReturnType<typeof setTimeout> | undefined;
function postScroll() {
  scrollTimer = undefined;
  scrollLast = Date.now();
  emit({ type: "scrolled" });
}
function onScroll(event: { hwnd: bigint }) {
  const target = Number(event.hwnd);
  if (!target) return;
  const fg = foreground();
  if (!fg || (target !== fg && Number(N().user.symbols.GetAncestor(target, 2 /* GA_ROOT */)) !== fg)) return;
  const wait = scrollLast + SCROLL_REST - Date.now();
  if (wait <= 0) postScroll();
  else scrollTimer ??= setTimeout(postScroll, wait);
}
function syncScrollHook() {
  if (!core) return;
  // EVENT_OBJECT_CONTENTSCROLLED; EVENT_SYSTEM_SCROLLINGEND (two ranges: one would take every event between).
  if (scrollUsers && !scrollHook) scrollHook = hookWindow([{ min: 0x8015, skipOwnProcess: true }, { min: 0x0013, skipOwnProcess: true }], onScroll);
  else if (!scrollUsers && scrollHook) {
    scrollHook.dispose();
    scrollHook = null;
    clearTimeout(scrollTimer);
    scrollTimer = undefined;
  }
}

/**
 * Holds the { type: "scrolled" } events: EVENT_OBJECT_CONTENTSCROLLED and EVENT_SYSTEM_SCROLLINGEND
 * are hooked only while someone holds them, and those of the foreground window kept.
 * Returns the release function.
 */
export function watchScrolled(): () => void {
  scrollUsers++;
  syncScrollHook();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    scrollUsers--;
    syncScrollHook();
  };
}

// ---------- Hooks scoped to a thread or process that changes ----------

/**
 * EVENT_OBJECT_LOCATIONCHANGE of the foreground window: hooked on its thread only, moved along at
 * each foreground change, so other windows moving never wake the JS thread.
 */
let moveHook: MessageWindow | null = null;
let moveThread = 0;
function followMoves(hwnd: number) {
  const owner = ownerOf(hwnd);
  const thread = owner.thread && owner.pid !== process.pid ? owner.thread : 0;
  if (thread === moveThread) return;
  moveThread = thread;
  moveHook?.dispose();
  // Not throttled here: main.tsx coalesces them.
  moveHook = thread ? hookWindow([{ min: 0x800b, thread }], (event) => {
    const target = Number(event.hwnd);
    if (event.idObject === 0 && target && target === foreground()) emit({ type: "moved", hwnd: target });
  }) : null;
}

/** EVENT_OBJECT_SHOW from Explorer's process only: its taskbar coming back. */
let showHook: MessageWindow | null = null;
let explorer = 0;
function hookExplorer() {
  const shellWnd = Number(N().user.symbols.GetShellWindow() ?? 0);
  const pid = shellWnd ? ownerOf(shellWnd).pid : 0;
  if (!pid || pid === explorer) return false;
  const restarted = explorer !== 0;
  explorer = pid;
  showHook?.dispose();
  showHook = hookWindow([{ min: 0x8002, process: pid }], (event) => {
    if (event.idObject !== 0 || !event.hwnd) return;
    const cls = className(Number(event.hwnd));
    if (cls === "Shell_TrayWnd" || cls === "Shell_SecondaryTrayWnd") emit({ type: "trayShown" });
  });
  return restarted;
}

// ---------- The main window ----------

function onCoreMessage(event: MessageWindowEvent, registryIds: WatchId[], folderIds: WatchId[]) {
  switch (event.type) {
    case "shell":
      return emit({ type: "shell", code: event.code & 0xffff, hwnd: Number(event.lParam) });
    case "registry":
    case "folder":
      if (!event.ended) watchChanged((event.type === "registry" ? registryIds : folderIds)[event.index]!);
      return;
    case "winEvent": {
      const hwnd = Number(event.hwnd);
      if (event.idObject !== 0 || !hwnd) return;
      if (event.event === EVENT_SYSTEM_FOREGROUND) {
        followMoves(hwnd);
        emit({ type: "foreground", hwnd });
      } else emit({ type: "windowState", hwnd });
      return;
    }
    case "message":
      break;
  }
  const msg = event.message;
  const code = Number(event.wParam);
  if (msg === APPBAR_CALLBACK) {
    if (code === 2 /* ABN_FULLSCREENAPP */) emit({ type: "fullscreen", on: event.lParam !== 0n });
  } else if (msg === WM_SETTINGCHANGE) emit({ type: "setting", action: code, area: event.text ?? "" });
  else if (msg === WM_POWERBROADCAST) {
    if (code === 0xa /* PBT_APMPOWERSTATUSCHANGE */) emit({ type: "power" });
    else if (code === 0x12 /* PBT_APMRESUMEAUTOMATIC */ || code === 0x7 /* PBT_APMRESUMESUSPEND */) emit({ type: "resume" });
    else if (code === 0x8013 /* PBT_POWERSETTINGCHANGE */ && event.data && event.data.length >= 24) {
      // POWERBROADCAST_SETTING: PowerSetting (GUID), DataLength, Data (a DWORD for these settings).
      const view = new DataView(event.data.buffer, event.data.byteOffset, event.data.byteLength);
      const id = view.getUint32(0, true), value = view.getUint32(20, true);
      if (id === 0x8ffee2c6) emit({ type: "brightness", level: value });
      else if (id === 0x6fe69556) emit({ type: "screen", on: value !== 0 });
      else emit({ type: "power" });
    }
  } else if (msg === WM_WTSSESSION_CHANGE) {
    if (code === 7 || code === 8) emit({ type: "session", locked: code === 7 }); // WTS_SESSION_LOCK / UNLOCK
  } else if (msg === MSG_RECYCLE || msg === MSG_FREESPACE) {
    // SHCNRF_NewDelivery: wParam a shared-memory handle, lParam the process; locking and unlocking frees it.
    const out = new BigUint64Array(2);
    const lock = N().shell.symbols.SHChangeNotification_Lock(event.wParam, Number(event.lParam), new Uint8Array(out.buffer, 0, 8), new Uint8Array(out.buffer, 8, 8));
    if (lock) N().shell.symbols.SHChangeNotification_Unlock(lock);
    emit({ type: msg === MSG_RECYCLE ? "recycleBin" : "freeSpace" });
  }
  else if (msg === WM_TIMECHANGE) emit({ type: "time" });
  else if (msg === WM_DISPLAYCHANGE) emit({ type: "display" });
  // Our own tray host broadcasts TaskbarCreated too: only a new Explorer process counts.
  else if (msg === core?.messageIds.TaskbarCreated && hookExplorer()) emit({ type: "explorerRestarted" });
}

const guid = (s: string) => {
  const h = s.replace(/-/g, "");
  const b = new Uint8Array(16);
  const g = new DataView(b.buffer);
  g.setUint32(0, parseInt(h.slice(0, 8), 16), true);
  g.setUint16(4, parseInt(h.slice(8, 12), 16), true);
  g.setUint16(6, parseInt(h.slice(12, 16), 16), true);
  for (let i = 0; i < 8; i++) b[8 + i] = parseInt(h.slice(16 + i * 2, 18 + i * 2), 16);
  return b;
};

export function startShellEvents(onEvent: (event: ShellEvent) => void) {
  if (core) return;
  sink = onEvent;
  const { user, shell, wts, ip, kernel } = N();
  const fixed = watchSpecs.filter(([, spec]) => !spec.lazy && watchExists(spec));
  const registryIds = fixed.filter(([, spec]) => spec.reg).map(([id]) => id);
  const folderIds = fixed.filter(([, spec]) => spec.dir).map(([id]) => id);
  core = messageWindow({
    className: "WindowsBarShellEvents",
    windowName: "WindowsBar shell events",
    messages: [APPBAR_CALLBACK, WM_SETTINGCHANGE, WM_POWERBROADCAST, WM_DISPLAYCHANGE, WM_WTSSESSION_CHANGE, WM_TIMECHANGE, MSG_RECYCLE, MSG_FREESPACE, "TaskbarCreated"],
    replies: { [WM_POWERBROADCAST]: 1 },
    shellHook: true,
    winEvents: [
      // EVENT_SYSTEM_FOREGROUND, the dock's own windows included: clicking the dock is how a flyout or
      // Start loses the foreground, and followForeground() needs to see that.
      { min: EVENT_SYSTEM_FOREGROUND },
      { min: 0x0016, max: 0x0017, skipOwnProcess: true }, // EVENT_SYSTEM_MINIMIZESTART/END
      { min: 0x8017, max: 0x8018, skipOwnProcess: true }, // EVENT_OBJECT_CLOAKED/UNCLOAKED
    ],
    registry: fixed.filter(([, spec]) => spec.reg).map(([, spec]) => registryWatch(spec)),
    folders: fixed.filter(([, spec]) => spec.dir).map(([, spec]) => folderWatch(spec)),
    onMessage: (event) => onCoreMessage(event, registryIds, folderIds),
  });
  const hwnd = Number(core.hwnd);
  closers.push(() => core?.dispose());
  // A second AppBar that reserves nothing: Explorer sends every AppBar ABN_FULLSCREENAPP.
  const abd = new Uint8Array(48);
  const a = new DataView(abd.buffer);
  a.setUint32(0, 48, true);
  a.setBigUint64(8, core.hwnd, true);
  a.setUint32(16, APPBAR_CALLBACK, true);
  shell.symbols.SHAppBarMessage(0 /* ABM_NEW */, abd);
  closers.push(() => shell.symbols.SHAppBarMessage(1 /* ABM_REMOVE */, abd));
  // Every percent of charge and every plug/unplug, as the taskbar's battery icon follows them; the panel
  // brightness the quick settings slider follows, and the display turning off or on. Windows sends each
  // setting's current value right away, then every change.
  for (const id of [
    "A7AD8041-B45A-4CAE-87A3-EECBB468A9E1", // GUID_BATTERY_PERCENTAGE_REMAINING
    "5D3E9A59-E9D5-4B00-A6BD-FF34FF516548", // GUID_ACDC_POWER_SOURCE
    "8FFEE2C6-2D01-46BE-ADB9-398ADDC5B4FF", // GUID_VIDEO_CURRENT_MONITOR_BRIGHTNESS
    "6FE69556-704A-47A0-8F24-C28D936FDA47", // GUID_CONSOLE_DISPLAY_STATE
  ]) {
    const handle = user.symbols.RegisterPowerSettingNotification(hwnd, guid(id), 0 /* DEVICE_NOTIFY_WINDOW_HANDLE */);
    if (handle) closers.push(() => user.symbols.UnregisterPowerSettingNotification(handle));
  }
  // Lock and unlock of this session.
  if (wts.symbols.WTSRegisterSessionNotification(hwnd, 0 /* NOTIFY_FOR_THIS_SESSION */)) closers.push(() => wts.symbols.WTSUnRegisterSessionNotification(hwnd));
  // The shell's own change notifications (SHChangeNotifyRegister), as Explorer's Recycle Bin and This PC
  // follow them. Recycling reports SHCNE_DELETE of the file and SHCNE_CREATE of its copy under the drive's
  // $Recycle.Bin folder (a file system path, not the CSIDL_BITBUCKET namespace), so each fixed drive's
  // $Recycle.Bin is registered, recursive, for SHCNE_RENAMEITEM | CREATE | DELETE | MKDIR | RMDIR |
  // UPDATEDIR | UPDATEITEM | UPDATEIMAGE | RENAMEFOLDER; the bin itself too, for emptying it.
  // SHCNE_FREESPACE | DRIVEADD | DRIVEREMOVED | MEDIAINSERTED | MEDIAREMOVED from anywhere.
  // SHCNRF_NewDelivery: the window lives on another thread, which the default delivery refuses.
  const changeNotify = (pidl: number | null, sources: number, events: number, message: number) => {
    if (!pidl) return;
    sources |= 0x8000;
    const entry = new Uint8Array(16), e = new DataView(entry.buffer);
    e.setBigUint64(0, BigInt(pidl), true);
    e.setInt32(8, 1, true); // fRecursive
    const id = shell.symbols.SHChangeNotifyRegister(hwnd, sources, events, message, 1, entry);
    if (id) closers.push(() => shell.symbols.SHChangeNotifyDeregister(id));
  };
  const specialFolder = (csidl: number) => {
    const pidl = new BigUint64Array(1);
    return shell.symbols.SHGetSpecialFolderLocation(null, csidl, new Uint8Array(pidl.buffer)) === 0 ? Number(pidl[0]) : null;
  };
  const drives = kernel.symbols.GetLogicalDrives() as number;
  for (let i = 0; i < 26; i++) {
    if (!(drives & (1 << i))) continue;
    const root = String.fromCharCode(65 + i) + ":\\";
    if (kernel.symbols.GetDriveTypeW(encodeWide(root)) !== 3 /* DRIVE_FIXED */) continue;
    changeNotify(shell.symbols.ILCreateFromPathW(encodeWide(root + "$Recycle.Bin")), 0x3 /* InterruptLevel | ShellLevel */, 0x2b01f, MSG_RECYCLE);
  }
  changeNotify(specialFolder(0x000a /* CSIDL_BITBUCKET */), 0x2 /* ShellLevel */, 0x2b01f, MSG_RECYCLE);
  changeNotify(specialFolder(0x0000 /* CSIDL_DESKTOP */), 0x2 /* ShellLevel */, 0x401e0, MSG_FREESPACE);
  // IPv4 address changes (a network came or went), as NotifyAddrChange reports them: Windows calls back
  // on a thread pool, once per address; a burst is reported once.
  let networkPending = false;
  const onAddress: ThreadsafeCallback = threadsafeCallback(() => {
    if (networkPending) return;
    networkPending = true;
    setTimeout(() => {
      networkPending = false;
      emit({ type: "network" });
    }, 0);
  }, { args: ["ptr", "ptr", "u32"] });
  const addrHandle = new BigUint64Array(1);
  if (ip.symbols.NotifyUnicastIpAddressChange(2 /* AF_INET */, onAddress.pointer, null, 0, new Uint8Array(addrHandle.buffer)) === 0) {
    closers.push(() => ip.symbols.CancelMibChangeNotify2(addrHandle[0]!));
  }
  closers.push(() => onAddress.close());
  hookExplorer();
  followMoves(foreground());
  // Everything asked before the window existed.
  for (const id of watchUsers.keys()) openLazy(id);
  syncDestroyHook();
  syncPointerHook();
  syncMenuHook();
  syncScrollHook();
  onExit(stopShellEvents);
}

function stopShellEvents() {
  for (const window of [moveHook, showHook, destroyHook, pointerHook, menuHook, scrollHook, ...lazyWindows.values()]) window?.dispose();
  moveHook = showHook = destroyHook = pointerHook = menuHook = scrollHook = null;
  lazyWindows.clear();
  for (const close of closers.splice(0).reverse()) {
    try {
      close();
    } catch (error) {
      console.error("[shell-events]", error);
    }
  }
  core = undefined;
  moveThread = explorer = 0;
  destroyThreads = "";
  clearTimeout(scrollTimer);
  for (const timer of restTimers.values()) clearTimeout(timer);
  restTimers.clear();
}
