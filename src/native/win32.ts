import { CFunction, dlopen, JSCallback, ptr, type Pointer } from "bun:ffi";

/** Win32 bindings used by the dock. Everything here is synchronous and cheap enough to poll. */

const user32 = dlopen("user32.dll", {
  FindWindowExW: { args: ["ptr", "ptr", "ptr", "ptr"], returns: "ptr" },
  SetWindowPos: { args: ["ptr", "i64", "i32", "i32", "i32", "i32", "u32"], returns: "i32" },
  EnumWindows: { args: ["function", "ptr"], returns: "i32" },
  IsWindowVisible: { args: ["ptr"], returns: "i32" },
  IsIconic: { args: ["ptr"], returns: "i32" },
  IsZoomed: { args: ["ptr"], returns: "i32" },
  GetWindowTextLengthW: { args: ["ptr"], returns: "i32" },
  GetWindowTextW: { args: ["ptr", "ptr", "i32"], returns: "i32" },
  GetWindow: { args: ["ptr", "u32"], returns: "ptr" },
  GetWindowLongPtrW: { args: ["ptr", "i32"], returns: "i64" },
  GetWindowRect: { args: ["ptr", "ptr"], returns: "i32" },
  GetCursorPos: { args: ["ptr"], returns: "i32" },
  GetDC: { args: ["ptr"], returns: "ptr" },
  ReleaseDC: { args: ["ptr", "ptr"], returns: "i32" },
  GetClassNameW: { args: ["ptr", "ptr", "i32"], returns: "i32" },
  WindowFromPoint: { args: ["u64"], returns: "ptr" },
  GetAncestor: { args: ["ptr", "u32"], returns: "ptr" },
  GetWindowThreadProcessId: { args: ["ptr", "ptr"], returns: "u32" },
  GetForegroundWindow: { args: [], returns: "ptr" },
  SetForegroundWindow: { args: ["ptr"], returns: "i32" },
  ShowWindow: { args: ["ptr", "i32"], returns: "i32" },
  PostMessageW: { args: ["ptr", "u32", "u64", "i64"], returns: "i32" },
  MonitorFromWindow: { args: ["ptr", "u32"], returns: "ptr" },
  GetMonitorInfoW: { args: ["ptr", "ptr"], returns: "i32" },
  keybd_event: { args: ["u8", "u8", "u32", "u64"], returns: "void" },
  SwitchToThisWindow: { args: ["ptr", "i32"], returns: "void" },
});

const kernel32 = dlopen("kernel32.dll", {
  OpenProcess: { args: ["u32", "i32", "u32"], returns: "ptr" },
  CloseHandle: { args: ["ptr"], returns: "i32" },
  QueryFullProcessImageNameW: { args: ["ptr", "u32", "ptr", "ptr"], returns: "i32" },
  GlobalMemoryStatusEx: { args: ["ptr"], returns: "i32" },
  GetSystemTimes: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
  GetSystemPowerStatus: { args: ["ptr"], returns: "i32" },
  LoadLibraryW: { args: ["ptr"], returns: "ptr" },
  GetProcAddress: { args: ["ptr", "u64"], returns: "ptr" },
  GetApplicationUserModelId: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
});

const dwmapi = dlopen("dwmapi.dll", {
  DwmGetWindowAttribute: { args: ["ptr", "u32", "ptr", "u32"], returns: "i32" },
  DwmRegisterThumbnail: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
  DwmUnregisterThumbnail: { args: ["ptr"], returns: "i32" },
  DwmUpdateThumbnailProperties: { args: ["ptr", "ptr"], returns: "i32" },
  DwmQueryThumbnailSourceSize: { args: ["ptr", "ptr"], returns: "i32" },
});

const gdi32 = dlopen("gdi32.dll", {
  GetPixel: { args: ["ptr", "i32", "i32"], returns: "u32" },
});

const shell32 = dlopen("shell32.dll", {
  SHAppBarMessage: { args: ["u32", "ptr"], returns: "u64" },
  SHQueryUserNotificationState: { args: ["ptr"], returns: "i32" },
});

const U = user32.symbols;
const K = kernel32.symbols;

export type HWND = Pointer;

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const wide = (s: string) => Buffer.from(s + "\0", "utf16le");

/**
 * Explorer's taskbar window. FindWindow("Shell_TrayWnd") is not enough: the dock's own tray
 * host registers a window of that class on top, so it would be found first.
 */
export function explorerTray(): HWND | null {
  const cls = wide("Shell_TrayWnd");
  let h: HWND | null = null;
  while ((h = U.FindWindowExW(null, h, cls, null) as HWND | null)) {
    U.GetWindowThreadProcessId(h, pidBuf);
    if (pidBuf[0] !== process.pid) return h;
  }
  return null;
}

export const HWND_TOPMOST = -1;
const SWP_NOACTIVATE = 0x0010;
const SWP_NOSIZE = 0x0001;

/** Moves and sizes a window, keeping it topmost, without activating it (physical px). */
export function placeWindow(hwnd: HWND, x: number, y: number, width: number, height: number) {
  U.SetWindowPos(hwnd, HWND_TOPMOST, Math.round(x), Math.round(y), Math.round(width), Math.round(height), SWP_NOACTIVATE);
}

/** Drops a topmost window to just behind `front` (or back on top with null), without hiding it. */
export function setBehind(hwnd: HWND, front: HWND | null) {
  const HWND_NOTOPMOST = -2;
  const flags = SWP_NOACTIVATE | SWP_NOSIZE | 0x2; /* SWP_NOMOVE */
  if (!front) {
    U.SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, flags);
    return;
  }
  U.SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, flags);
  U.SetWindowPos(hwnd, Number(front), 0, 0, 0, 0, flags);
}

function readRect(view: DataView, offset: number): Rect {
  return {
    left: view.getInt32(offset, true),
    top: view.getInt32(offset + 4, true),
    right: view.getInt32(offset + 8, true),
    bottom: view.getInt32(offset + 12, true),
  };
}

/** Physical bounds and work area of the monitor the window is on. */
export function monitorOf(hwnd: HWND): { monitor: Rect; work: Rect } {
  const mon = U.MonitorFromWindow(hwnd, 2 /* MONITOR_DEFAULTTONEAREST */);
  const buf = new Uint8Array(40);
  const view = new DataView(buf.buffer);
  view.setUint32(0, 40, true);
  U.GetMonitorInfoW(mon, buf);
  return { monitor: readRect(view, 4), work: readRect(view, 20) };
}

export function windowRect(hwnd: HWND): Rect {
  const r = new Int32Array(4);
  U.GetWindowRect(hwnd, r);
  return { left: r[0]!, top: r[1]!, right: r[2]!, bottom: r[3]! };
}

export function cursorPos(): { x: number; y: number } {
  const p = new Int32Array(2);
  U.GetCursorPos(p);
  return { x: p[0]!, y: p[1]! };
}

/** The top-level window under a physical screen point. */
export function topWindowAt(x: number, y: number): HWND | null {
  // POINT passed by value: x in the low 32 bits, y in the high ones.
  const packed = (BigInt(Math.round(y) >>> 0) << 32n) | BigInt(Math.round(x) >>> 0);
  const h = U.WindowFromPoint(packed) as HWND | null;
  return h ? (U.GetAncestor(h, 2 /* GA_ROOT */) as HWND | null) : null;
}

export function windowClass(hwnd: HWND): string {
  const len = U.GetClassNameW(hwnd, textBuf, textBuf.length);
  return len > 0 ? Buffer.from(textBuf.buffer, 0, len * 2).toString("utf16le") : "";
}

/** Colours on screen at the given physical points, as [r, g, b]; null where unreadable. */
export function screenPixels(points: { x: number; y: number }[]): ([number, number, number] | null)[] {
  const dc = U.GetDC(null);
  if (!dc) return points.map(() => null);
  const out = points.map(({ x, y }) => {
    const c = gdi32.symbols.GetPixel(dc, Math.round(x), Math.round(y));
    return c === 0xffffffff ? null : ([c & 0xff, (c >> 8) & 0xff, (c >> 16) & 0xff] as [number, number, number]);
  });
  U.ReleaseDC(null, dc);
  return out;
}

export function isWindowVisible(hwnd: HWND) {
  return !!U.IsWindowVisible(hwnd);
}

// ---------- AppBar (reserves screen space like the taskbar does) ----------

/**
 * Who SHAppBarMessage reaches: it finds the tray with FindWindow("Shell_TrayWnd"), which is the
 * dock's own tray host while that runs (tray-host.ts). The host installs a route that hands the
 * call to Explorer directly; relayed through the host, Explorer accepts the AppBar but at times
 * never applies its work area.
 */
let appBarRoute: (<T>(call: () => T) => T) | null = null;

export function setAppBarRoute(route: (<T>(call: () => T) => T) | null) {
  appBarRoute = route;
}

function appBarMessage(message: number, data: Uint8Array) {
  const call = () => shell32.symbols.SHAppBarMessage(message, data);
  return appBarRoute ? appBarRoute(call) : call();
}

const ABM_NEW = 0;
const ABM_REMOVE = 1;
const ABM_QUERYPOS = 2;
const ABM_SETPOS = 3;
const ABM_GETSTATE = 4;
const ABM_SETSTATE = 10;
export const ABE_BOTTOM = 3;
export const ABS_AUTOHIDE = 1;
export const ABS_ALWAYSONTOP = 2;

function appBarData(hwnd: HWND | null, edge = 0, rect?: Rect, lParam = 0) {
  const buf = new Uint8Array(48);
  const view = new DataView(buf.buffer);
  view.setUint32(0, 48, true);
  if (hwnd) view.setBigUint64(8, BigInt(hwnd), true);
  view.setUint32(20, edge, true);
  if (rect) {
    view.setInt32(24, rect.left, true);
    view.setInt32(28, rect.top, true);
    view.setInt32(32, rect.right, true);
    view.setInt32(36, rect.bottom, true);
  }
  view.setBigInt64(40, BigInt(lParam), true);
  return { buf, view };
}

export function appBarRegister(hwnd: HWND): boolean {
  return Number(appBarMessage(ABM_NEW, appBarData(hwnd).buf)) !== 0;
}

/** The rect Windows would grant for `rect` on `edge`, without reserving anything. */
export function appBarQuery(hwnd: HWND, edge: number, rect: Rect): Rect {
  const data = appBarData(hwnd, edge, rect);
  appBarMessage(ABM_QUERYPOS, data.buf);
  const granted = readRect(data.view, 24);
  if (edge === ABE_BOTTOM) granted.top = granted.bottom - (rect.bottom - rect.top);
  return granted;
}

/** Reserves `rect` on `edge`; returns the rect Windows granted. */
export function appBarSetPos(hwnd: HWND, edge: number, rect: Rect): Rect {
  const data = appBarData(hwnd, edge, rect);
  appBarMessage(ABM_QUERYPOS, data.buf);
  const granted = readRect(data.view, 24);
  // Keep the requested thickness against the edge Windows pushed us to.
  if (edge === ABE_BOTTOM) granted.top = granted.bottom - (rect.bottom - rect.top);
  const final = appBarData(hwnd, edge, granted);
  appBarMessage(ABM_SETPOS, final.buf);
  return readRect(final.view, 24);
}

export function appBarRemove(hwnd: HWND) {
  appBarMessage(ABM_REMOVE, appBarData(hwnd).buf);
}

export function taskbarState(): number {
  return Number(appBarMessage(ABM_GETSTATE, appBarData(null).buf));
}

export function setTaskbarState(state: number) {
  appBarMessage(ABM_SETSTATE, appBarData(null, 0, undefined, state).buf);
}

const qunsBuf = new Int32Array(1);

const frameBuf = new Int32Array(4);

/**
 * True while a full-screen app, game, video or presentation owns the screen `dock` is on.
 * The shell's own answer (SHQueryUserNotificationState) misses many borderless full-screen
 * windows (browsers on F11, players, most games), so the window in front is checked as well:
 * not maximized, and its visible frame covers the whole monitor.
 */
export function fullscreenAppActive(dock?: HWND | null): boolean {
  if (shell32.symbols.SHQueryUserNotificationState(qunsBuf) === 0) {
    const state = qunsBuf[0]!;
    if (state === 2 || state === 3 || state === 4) return true; // BUSY, D3D full screen, presentation
  }
  const fg = U.GetForegroundWindow() as HWND | null;
  if (!fg || U.IsZoomed(fg)) return false;
  U.GetWindowThreadProcessId(fg, pidBuf);
  if (pidBuf[0] === process.pid) return false;
  const cls = windowClass(fg);
  if (cls === "Progman" || cls === "WorkerW" || cls === "Shell_TrayWnd") return false;
  if (dwmapi.symbols.DwmGetWindowAttribute(fg, 9 /* DWMWA_EXTENDED_FRAME_BOUNDS */, frameBuf, 16) !== 0) {
    U.GetWindowRect(fg, frameBuf);
  }
  const { monitor } = monitorOf(dock ?? fg);
  const { monitor: own } = monitorOf(fg);
  if (own.left !== monitor.left || own.top !== monitor.top) return false; // another screen
  return frameBuf[0]! <= monitor.left && frameBuf[1]! <= monitor.top && frameBuf[2]! >= monitor.right && frameBuf[3]! >= monitor.bottom;
}

export const SW_HIDE = 0;
export const SW_SHOWNA = 8;
export const SW_RESTORE = 9;
export const SW_MINIMIZE = 6;

export function showWindow(hwnd: HWND, cmd: number) {
  U.ShowWindow(hwnd, cmd);
}

// ---------- Top-level windows ----------

export interface TopWindow {
  hwnd: HWND;
  title: string;
  pid: number;
  exe: string;
  minimized: boolean;
}

const GW_OWNER = 4;
const GWL_EXSTYLE = -20;
const WS_EX_TOOLWINDOW = 0x80;
const WS_EX_APPWINDOW = 0x40000;
const DWMWA_CLOAKED = 14;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

const textBuf = new Uint16Array(512);
const pidBuf = new Uint32Array(1);
const cloakBuf = new Uint32Array(1);
const exeCache = new Map<number, string>();

export function exePathOf(pid: number): string {
  const cached = exeCache.get(pid);
  if (cached !== undefined) return cached;
  let path = "";
  const handle = K.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
  if (handle) {
    const size = new Uint32Array([textBuf.length]);
    if (K.QueryFullProcessImageNameW(handle, 0, textBuf, size)) {
      path = Buffer.from(textBuf.buffer, 0, size[0]! * 2).toString("utf16le");
    }
    K.CloseHandle(handle);
  }
  exeCache.set(pid, path);
  return path;
}

function windowTitle(hwnd: HWND): string {
  const len = U.GetWindowTextW(hwnd, textBuf, textBuf.length);
  return len > 0 ? Buffer.from(textBuf.buffer, 0, len * 2).toString("utf16le") : "";
}

/** Windows that belong on a taskbar: visible, unowned, not tool windows, not cloaked. */
let collected: TopWindow[] = [];
const ownTaskbarTitles = new Set<string>();

/** Titles of this app's windows that appear on the taskbar like any app's. */
/** Whether a top-level window with this exact title exists (any process). */
export function windowExists(title: string): boolean {
  return U.FindWindowExW(null, null, null, wide(title)) !== null;
}

export function showOwnWindowOnTaskbar(title: string) {
  ownTaskbarTitles.add(title);
}
let enumCallback: JSCallback | null = null;

export function listTaskbarWindows(): TopWindow[] {
  collected = [];
  enumCallback ??= new JSCallback(
    (hwnd: HWND) => {
      if (!U.IsWindowVisible(hwnd)) return 1;
      if (U.GetWindowTextLengthW(hwnd) === 0) return 1;
      const ex = Number(U.GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
      const owned = U.GetWindow(hwnd, GW_OWNER) !== null;
      if (ex & WS_EX_TOOLWINDOW && !(ex & WS_EX_APPWINDOW)) return 1;
      if (owned && !(ex & WS_EX_APPWINDOW)) return 1;
      cloakBuf[0] = 0;
      dwmapi.symbols.DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, cloakBuf, 4);
      if (cloakBuf[0]) return 1;
      U.GetWindowThreadProcessId(hwnd, pidBuf);
      const pid = pidBuf[0]!;
      // Of this app's own windows only the ones registered (the settings/widgets window) belong on
      // the taskbar: the menu and preview windows look like app windows to Windows too.
      if (pid === process.pid && !ownTaskbarTitles.has(windowTitle(hwnd))) return 1;
      collected.push({ hwnd, title: windowTitle(hwnd), pid, exe: exePathOf(pid), minimized: !!U.IsIconic(hwnd) });
      return 1;
    },
    { args: ["ptr", "ptr"], returns: "i32" },
  );
  U.EnumWindows(enumCallback.ptr, null);
  if (exeCache.size > 512) exeCache.clear();
  return collected;
}

export function foregroundWindow(): HWND | null {
  return U.GetForegroundWindow() as HWND | null;
}

export function activateWindow(hwnd: HWND) {
  if (U.IsIconic(hwnd)) U.ShowWindow(hwnd, SW_RESTORE);
  // Windows of elevated apps (run as administrator) refuse ShowWindow from this process;
  // SwitchToThisWindow goes through the shell, restores them and brings them forward.
  if (U.IsIconic(hwnd)) {
    U.SwitchToThisWindow(hwnd, 1);
    return;
  }
  // An ALT tap lifts the foreground lock so SetForegroundWindow is honoured.
  U.keybd_event(0x12, 0, 0, 0);
  U.keybd_event(0x12, 0, 2, 0);
  if (!U.SetForegroundWindow(hwnd)) U.SwitchToThisWindow(hwnd, 1);
}

export function windowPid(hwnd: HWND): number {
  U.GetWindowThreadProcessId(hwnd, pidBuf);
  return pidBuf[0]!;
}

let livePreview: ((on: number, target: HWND | null, keepOnTop: HWND | null, kind: number, extra: number) => number) | null | undefined;

/**
 * Aero Peek, as the taskbar does it: every other window fades to glass outlines and `target`
 * shows in place. `keepOnTop` stays visible above it. Undocumented (dwmapi ordinal 113).
 */
export function peekWindow(target: HWND | null, keepOnTop: HWND | null = null) {
  if (livePreview === undefined) {
    const mod = K.LoadLibraryW(wide("dwmapi.dll"));
    const fn = mod ? K.GetProcAddress(mod, 113) : null;
    livePreview = fn ? (CFunction({ ptr: fn, args: ["i32", "ptr", "ptr", "u32", "u64"], returns: "i32" }) as never) : null;
  }
  livePreview?.(target ? 1 : 0, target, keepOnTop, 1, 0);
}

export function minimizeWindow(hwnd: HWND) {
  // Windows of elevated apps (run as administrator) refuse ShowWindow from this process, but
  // still take the system menu's Minimize command.
  if (!U.ShowWindow(hwnd, SW_MINIMIZE) && !U.IsIconic(hwnd)) {
    U.PostMessageW(hwnd, 0x0112 /* WM_SYSCOMMAND */, 0xf020 /* SC_MINIMIZE */, 0);
  }
}

export function closeWindow(hwnd: HWND) {
  // Elevated apps may refuse WM_CLOSE from this process; the system menu's Close still works.
  if (!U.PostMessageW(hwnd, 0x0010 /* WM_CLOSE */, 0, 0)) {
    U.PostMessageW(hwnd, 0x0112 /* WM_SYSCOMMAND */, 0xf060 /* SC_CLOSE */, 0);
  }
}

// ---------- App identity (Store apps share one host exe) ----------

/**
 * The AppUserModelID of a Store app window. Such apps all show up as ApplicationFrameHost.exe;
 * the app itself owns the CoreWindow inside the frame, and its process knows its ID. The ID
 * opens the app again and finds its icon through shell:AppsFolder\\<id>.
 */
export function storeAppId(frame: HWND): string {
  const core = U.FindWindowExW(frame, null, wide("Windows.UI.Core.CoreWindow"), null) as HWND | null;
  if (!core) return "";
  U.GetWindowThreadProcessId(core, pidBuf);
  const handle = K.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pidBuf[0]!);
  if (!handle) return "";
  try {
    const len = new Uint32Array([textBuf.length]);
    if (K.GetApplicationUserModelId(handle, len, textBuf) !== 0) return "";
    return Buffer.from(textBuf.buffer, 0, Math.max(0, len[0]! - 1) * 2).toString("utf16le");
  } finally {
    K.CloseHandle(handle);
  }
}

// ---------- Live window thumbnails (what the taskbar previews use) ----------

export type Thumbnail = bigint;

/** Shows a live picture of `source` inside `dest` (a window of this process). */
export function registerThumbnail(dest: HWND, source: HWND): Thumbnail | null {
  const out = new BigUint64Array(1);
  return dwmapi.symbols.DwmRegisterThumbnail(dest, source, out) === 0 ? out[0]! : null;
}

export function unregisterThumbnail(thumb: Thumbnail) {
  dwmapi.symbols.DwmUnregisterThumbnail(Number(thumb) as unknown as Pointer);
}

export function thumbnailSourceSize(thumb: Thumbnail): { width: number; height: number } {
  const size = new Int32Array(2);
  dwmapi.symbols.DwmQueryThumbnailSourceSize(Number(thumb) as unknown as Pointer, size);
  return { width: size[0]!, height: size[1]! };
}

/** Places the thumbnail at `rect` (physical px in the destination's client area). */
export function placeThumbnail(thumb: Thumbnail, rect: Rect, visible = true) {
  const buf = new Uint8Array(48);
  const view = new DataView(buf.buffer);
  view.setUint32(0, 0x1 | 0x4 | 0x8 | 0x10, true); // destination, opacity, visible, client area only
  view.setInt32(4, Math.round(rect.left), true);
  view.setInt32(8, Math.round(rect.top), true);
  view.setInt32(12, Math.round(rect.right), true);
  view.setInt32(16, Math.round(rect.bottom), true);
  view.setUint8(36, 255);
  view.setInt32(40, visible ? 1 : 0, true);
  view.setInt32(44, 1, true);
  dwmapi.symbols.DwmUpdateThumbnailProperties(Number(thumb) as unknown as Pointer, buf);
}

// ---------- Keyboard ----------

export const VK = {
  LWIN: 0x5b,
  MEDIA_NEXT: 0xb0,
  MEDIA_PREV: 0xb1,
  MEDIA_PLAY_PAUSE: 0xb3,
  VOLUME_MUTE: 0xad,
} as const;

/** Presses keys together, like a shortcut (Win+N): down in order, up in reverse. */
export function tapKeys(...vks: number[]) {
  for (const vk of vks) U.keybd_event(vk, 0, 0, 0);
  for (const vk of vks.toReversed()) U.keybd_event(vk, 0, 2 /* KEYEVENTF_KEYUP */, 0);
}

export function tapKey(vk: number) {
  U.keybd_event(vk, 0, 0, 0);
  U.keybd_event(vk, 0, 2 /* KEYEVENTF_KEYUP */, 0);
}

// ---------- System metrics ----------

const memBuf = new Uint8Array(64);
const memView = new DataView(memBuf.buffer);

export function memoryStatus() {
  memView.setUint32(0, 64, true);
  K.GlobalMemoryStatusEx(memBuf);
  const total = Number(memView.getBigUint64(8, true));
  const avail = Number(memView.getBigUint64(16, true));
  return { load: memView.getUint32(4, true), total, used: total - avail };
}

const times = new BigUint64Array(3);
let lastTimes: [bigint, bigint, bigint] | null = null;

/** CPU usage 0..100 since the previous call. */
export function cpuUsage(): number {
  K.GetSystemTimes(ptr(times, 0), ptr(times, 8), ptr(times, 16));
  const now: [bigint, bigint, bigint] = [times[0]!, times[1]!, times[2]!];
  const prev = lastTimes;
  lastTimes = now;
  if (!prev) return 0;
  const idle = Number(now[0] - prev[0]);
  const total = Number(now[1] - prev[1] + (now[2] - prev[2]));
  return total > 0 ? Math.max(0, Math.min(100, (1 - idle / total) * 100)) : 0;
}

const powerBuf = new Uint8Array(12);

export function powerStatus(): { hasBattery: boolean; percent: number; charging: boolean } {
  K.GetSystemPowerStatus(powerBuf);
  const flag = powerBuf[1]!;
  const percent = powerBuf[2]!;
  return { hasBattery: flag !== 128 && flag !== 255 && percent !== 255, percent, charging: powerBuf[0] === 1 };
}
