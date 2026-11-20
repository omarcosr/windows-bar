import { dlopen, JSCallback, type Pointer, CFunction, read } from "./ffi";
import { encodeWide, decodeWide } from "./wide";

/** Win32 bindings used by the dock. Everything here is synchronous and cheap enough to poll. */

const user32 = dlopen("user32.dll", {
  FindWindowExW: { args: ["ptr", "ptr", "ptr", "ptr"], returns: "ptr" },
  GetShellWindow: { args: [], returns: "ptr" },
  SetWindowPos: { args: ["ptr", "i64", "i32", "i32", "i32", "i32", "u32"], returns: "i32" },
  EnumWindows: { args: ["function", "ptr"], returns: "i32" },
  IsWindowVisible: { args: ["ptr"], returns: "i32" },
  IsIconic: { args: ["ptr"], returns: "i32" },
  IsZoomed: { args: ["ptr"], returns: "i32" },
  GetWindowTextLengthW: { args: ["ptr"], returns: "i32" },
  GetWindowTextW: { args: ["ptr", "ptr", "i32"], returns: "i32" },
  InternalGetWindowText: { args: ["ptr", "ptr", "i32"], returns: "i32" },
  GetSystemMetrics: { args: ["i32"], returns: "i32" },
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
  ShowWindowAsync: { args: ["ptr", "i32"], returns: "i32" },
  PostMessageW: { args: ["ptr", "u32", "u64", "i64"], returns: "i32" },
  MonitorFromWindow: { args: ["ptr", "u32"], returns: "ptr" },
  GetMonitorInfoW: { args: ["ptr", "ptr"], returns: "i32" },
  keybd_event: { args: ["u8", "u8", "u32", "u64"], returns: "void" },
  SwitchToThisWindow: { args: ["ptr", "i32"], returns: "void" },
  SystemParametersInfoW: { args: ["u32", "u32", "ptr", "u32"], returns: "i32" },
  GetAsyncKeyState: { args: ["i32"], returns: "i16" },
});

const kernel32 = dlopen("kernel32.dll", {
  OpenProcess: { args: ["u32", "i32", "u32"], returns: "ptr" },
  CloseHandle: { args: ["ptr"], returns: "i32" },
  QueryFullProcessImageNameW: { args: ["ptr", "u32", "ptr", "ptr"], returns: "i32" },
  GlobalMemoryStatusEx: { args: ["ptr"], returns: "i32" },
  GetSystemTimes: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
  GetSystemPowerStatus: { args: ["ptr"], returns: "i32" },
  GetApplicationUserModelId: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
  TerminateProcess: { args: ["ptr", "u32"], returns: "i32" },
});

const dwmapi = dlopen("dwmapi.dll", {
  DwmGetWindowAttribute: { args: ["ptr", "u32", "ptr", "u32"], returns: "i32" },
});

const gdi32 = dlopen("gdi32.dll", {
  CreateCompatibleDC: { args: ["ptr"], returns: "ptr" },
  CreateCompatibleBitmap: { args: ["ptr", "i32", "i32"], returns: "ptr" },
  SelectObject: { args: ["ptr", "ptr"], returns: "ptr" },
  BitBlt: { args: ["ptr", "i32", "i32", "i32", "i32", "ptr", "i32", "i32", "u32"], returns: "i32" },
  GetDIBits: { args: ["ptr", "ptr", "u32", "u32", "ptr", "ptr", "u32"], returns: "i32" },
  DeleteObject: { args: ["ptr"], returns: "i32" },
  DeleteDC: { args: ["ptr"], returns: "i32" },
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

const wide = (s: string) => encodeWide(s);
const trayClass = wide("Shell_TrayWnd");

/**
 * Explorer's taskbar window. FindWindow("Shell_TrayWnd") is not enough: the dock's own tray
 * host registers a window of that class on top, so it would be found first.
 */
export function explorerTray(): HWND | null {
  let h: HWND | null = null;
  while ((h = U.FindWindowExW(null, h, trayClass, null) as HWND | null)) {
    U.GetWindowThreadProcessId(h, pidBytes);
    if (pidBuf[0] !== process.pid) return h;
  }
  return null;
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
  U.GetWindowRect(hwnd, new Uint8Array(r.buffer));
  return { left: r[0]!, top: r[1]!, right: r[2]!, bottom: r[3]! };
}

export function cursorPos(): { x: number; y: number } {
  const p = new Int32Array(2);
  U.GetCursorPos(new Uint8Array(p.buffer));
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
  const len = U.GetClassNameW(hwnd, textBytes, textBuf.length);
  return len > 0 ? decodeWide(textBuf.buffer, 0, len * 2) : "";
}

const pixelInfo = new Uint8Array(40);
{
  const v = new DataView(pixelInfo.buffer);
  v.setUint32(0, 40, true); // BITMAPINFOHEADER: 32 bpp, top-down; width set per row
  v.setInt32(8, -1, true);
  v.setUint16(12, 1, true);
  v.setUint16(14, 32, true);
}

/**
 * Colours on screen at the given physical points, as [r, g, b]; null where unreadable (off every
 * monitor). GetPixel on the screen asks DWM for one pixel per call (~4 ms each, measured: 16 points
 * 66.7 ms); each row of points is copied once instead (BitBlt + GetDIBits, 16 points ~4 ms), same colours.
 */
export function screenPixels(points: { x: number; y: number }[]): ([number, number, number] | null)[] {
  const out: ([number, number, number] | null)[] = points.map(() => null);
  // The virtual screen (every monitor): GetPixel answered CLR_INVALID outside it.
  const vx = U.GetSystemMetrics(76 /* SM_XVIRTUALSCREEN */);
  const vy = U.GetSystemMetrics(77);
  const vw = U.GetSystemMetrics(78);
  const vh = U.GetSystemMetrics(79);
  const rows = new Map<number, number[]>();
  points.forEach(({ x, y }, i) => {
    const px = Math.round(x);
    const py = Math.round(y);
    if (px < vx || py < vy || px >= vx + vw || py >= vy + vh) return;
    let row = rows.get(py);
    if (!row) rows.set(py, (row = []));
    row.push(i);
  });
  if (!rows.size) return out;
  const screen = U.GetDC(null);
  if (!screen) return out;
  const G = gdi32.symbols;
  const mem = G.CreateCompatibleDC(screen);
  try {
    for (const [y, indexes] of rows) {
      const xs = indexes.map((i) => Math.round(points[i]!.x));
      const left = Math.min(...xs);
      const width = Math.max(...xs) - left + 1;
      const bitmap = G.CreateCompatibleBitmap(screen, width, 1);
      if (!bitmap) continue;
      const previous = G.SelectObject(mem, bitmap);
      try {
        if (!G.BitBlt(mem, 0, 0, width, 1, screen, left, y, 0x00cc0020 /* SRCCOPY */)) continue;
        G.SelectObject(mem, previous);
        new DataView(pixelInfo.buffer).setInt32(4, width, true);
        const bgra = new Uint8Array(width * 4);
        if (!G.GetDIBits(mem, bitmap, 0, 1, bgra, pixelInfo, 0 /* DIB_RGB_COLORS */)) continue;
        indexes.forEach((i, n) => {
          const o = (xs[n]! - left) * 4;
          out[i] = [bgra[o + 2]!, bgra[o + 1]!, bgra[o]!];
        });
      } finally {
        G.SelectObject(mem, previous);
        G.DeleteObject(bitmap);
      }
    }
  } finally {
    G.DeleteDC(mem);
    U.ReleaseDC(null, screen);
  }
  return out;
}

export function isWindowVisible(hwnd: HWND) {
  return !!U.IsWindowVisible(hwnd);
}

// ---------- Taskbar state (ABM_GETSTATE/ABM_SETSTATE; the dock's own AppBar is app.appBar) ----------

/**
 * Who SHAppBarMessage reaches: it finds the tray with FindWindow("Shell_TrayWnd"), which is the
 * dock's own tray host while that runs (tray-host.ts). The host installs a route that hands the
 * call to Explorer directly.
 */
let appBarRoute: (<T>(call: () => T) => T) | null = null;

export function setAppBarRoute(route: (<T>(call: () => T) => T) | null) {
  appBarRoute = route;
}

function appBarMessage(message: number, data: Uint8Array) {
  const call = () => shell32.symbols.SHAppBarMessage(message, data);
  return appBarRoute ? appBarRoute(call) : call();
}

const ABM_GETSTATE = 4;
const ABM_SETSTATE = 10;
export const ABS_AUTOHIDE = 1;
export const ABS_ALWAYSONTOP = 2;

/** APPBARDATA with no window: the taskbar's own state, `lParam` the state to set. */
function appBarData(lParam = 0) {
  const buf = new Uint8Array(48);
  const view = new DataView(buf.buffer);
  view.setUint32(0, 48, true);
  view.setBigInt64(40, BigInt(lParam), true);
  return buf;
}

export function taskbarState(): number {
  return Number(appBarMessage(ABM_GETSTATE, appBarData()));
}

export function setTaskbarState(state: number) {
  appBarMessage(ABM_SETSTATE, appBarData(state));
}

const qunsBuf = new Int32Array(1);
let qunsAt = -Infinity;
let qunsBusy = false;

/**
 * SHQueryUserNotificationState asks Explorer across processes: ~7 ms a call (measured). The window
 * moves of a drag check full screen up to 20 times a second, so its answer is reused for 1 s; the
 * geometry check below and ABN_FULLSCREENAPP (shell-events.ts) still react at once.
 */
function shellBusy(): boolean {
  const now = performance.now();
  if (now - qunsAt < 1000) return qunsBusy;
  qunsAt = now;
  const state = shell32.symbols.SHQueryUserNotificationState(new Uint8Array(qunsBuf.buffer)) === 0 ? qunsBuf[0]! : 0;
  qunsBusy = state === 2 || state === 3 || state === 4; // BUSY, D3D full screen, presentation
  return qunsBusy;
}

const frameBuf = new Int32Array(4);

/**
 * True while a full-screen app, game, video or presentation owns the screen `dock` is on.
 * The shell's own answer (SHQueryUserNotificationState) misses many borderless full-screen
 * windows (browsers on F11, players, most games), so the window in front is checked as well:
 * not maximized, and its visible frame covers the whole monitor.
 */
export function fullscreenAppActive(dock?: HWND | null): boolean {
  if (shellBusy()) return true;
  const fg = U.GetForegroundWindow() as HWND | null;
  if (!fg) return false;
  // A maximized window with a title bar fills the work area, not the screen (with the taskbar on
  // auto-hide they are the same). Borderless maximized windows (many games, players) are full screen.
  const WS_CAPTION = 0xc00000;
  if (U.IsZoomed(fg) && (Number(U.GetWindowLongPtrW(fg, -16 /* GWL_STYLE */)) & WS_CAPTION) === WS_CAPTION) return false;
  U.GetWindowThreadProcessId(fg, pidBytes);
  if (pidBuf[0] === process.pid) return false;
  const cls = windowClass(fg);
  if (cls === "Progman" || cls === "WorkerW" || cls === "Shell_TrayWnd") return false;
  if (dwmapi.symbols.DwmGetWindowAttribute(fg, 9 /* DWMWA_EXTENDED_FRAME_BOUNDS */, new Uint8Array(frameBuf.buffer), 16) !== 0) {
    U.GetWindowRect(fg, new Uint8Array(frameBuf.buffer));
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

/** Whether a mouse button (left, right or middle) is held down now. */
export function mouseButtonDown() {
  return [0x01, 0x02, 0x04].some((vk) => (U.GetAsyncKeyState(vk) & 0x8000) !== 0);
}

/** Puts a topmost window above the other topmost ones, without activating, moving or sizing it. */
export function raiseTopmost(hwnd: HWND) {
  U.SetWindowPos(hwnd, -1 /* HWND_TOPMOST */, 0, 0, 0, 0, 0x1 | 0x2 | 0x10 /* SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE */);
}

/** ShowWindow for another process's window without waiting for its thread (it may be busy). */
export function showWindowAsync(hwnd: HWND, cmd: number) {
  U.ShowWindowAsync(hwnd, cmd);
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
// Byte views made once: the list callback runs for every top-level window (300+), and a view per
// call is an allocation each time.
const textBytes = new Uint8Array(textBuf.buffer);
const pidBytes = new Uint8Array(pidBuf.buffer);
const cloakBytes = new Uint8Array(cloakBuf.buffer);
const exeCache = new Map<number, string>();

export function exePathOf(pid: number): string {
  const cached = exeCache.get(pid);
  if (cached !== undefined) return cached;
  let path = "";
  const handle = K.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
  if (handle) {
    const size = new Uint32Array([textBuf.length]);
    if (K.QueryFullProcessImageNameW(handle, 0, textBytes, new Uint8Array(size.buffer))) {
      path = decodeWide(textBuf.buffer, 0, size[0]! * 2);
    }
    K.CloseHandle(handle);
  }
  exeCache.set(pid, path);
  return path;
}

/**
 * A window's title. For another process's window GetWindowText reads the text Windows keeps and
 * sends nothing (a hung window answered in 0.04 ms, measured). For this process's windows it sends
 * WM_GETTEXT to their thread, Tarve's UI thread, which waited 31-44 ms while the UI was busy:
 * InternalGetWindowText reads the kept text for those (it costs ~10 µs a call, so only there).
 */
function windowTitle(hwnd: HWND, own: boolean): string {
  const len = own ? U.InternalGetWindowText(hwnd, textBytes, textBuf.length) : U.GetWindowTextW(hwnd, textBytes, textBuf.length);
  return len > 0 ? decodeWide(textBuf.buffer, 0, len * 2) : "";
}

/** Windows that belong on a taskbar: visible, unowned, not tool windows, not cloaked. */
let collected: TopWindow[] = [];
const ownTaskbarTitles = new Set<string>();

/** Titles of this app's windows that appear on the taskbar like any app's. */
/** Whether a top-level window with this exact title exists (any process). */
export function windowExists(title: string): boolean {
  return U.FindWindowExW(null, null, null, wide(title)) !== null;
}


const popupMenuClass = wide("#32768");

/** Whether a standard Win32 popup menu (class #32768, e.g. a tray icon's context menu) is on screen. */
export function popupMenuVisible(): boolean {
  let h: HWND | null = null;
  while ((h = U.FindWindowExW(null, h, popupMenuClass, null) as HWND | null)) {
    if (U.IsWindowVisible(h)) return true;
  }
  return false;
}

export function showOwnWindowOnTaskbar(title: string) {
  ownTaskbarTitles.add(title);
}
let enumCallback: JSCallback | null = null;

/** Read by the cached EnumWindows callback: list windows of every virtual desktop. */
let listAllDesktops = false;

export function listTaskbarWindows(allDesktops = false): TopWindow[] {
  collected = [];
  listAllDesktops = allDesktops;
  enumCallback ??= new JSCallback(
    (hwnd: HWND) => {
      if (!U.IsWindowVisible(hwnd)) return 1;
      U.GetWindowThreadProcessId(hwnd, pidBytes);
      const pid = pidBuf[0]!;
      const own = pid === process.pid;
      // GetWindowTextLength would message the dock's own windows (see windowTitle).
      if (!own && U.GetWindowTextLengthW(hwnd) === 0) return 1;
      const ex = Number(U.GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
      const owned = U.GetWindow(hwnd, GW_OWNER) !== null;
      if (ex & WS_EX_TOOLWINDOW && !(ex & WS_EX_APPWINDOW)) return 1;
      if (owned && !(ex & WS_EX_APPWINDOW)) return 1;
      cloakBuf[0] = 0;
      dwmapi.symbols.DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, cloakBytes, 4);
      const cloaked = !!cloakBuf[0];
      if (cloaked && !listAllDesktops) return 1;
      const title = windowTitle(hwnd, own);
      if (!title) return 1;
      // Virtual desktops, as the taskbar filters them (VirtualDesktopTaskbarFilter): only the
      // current desktop's windows, or every desktop's (those are cloaked by the shell while away).
      if (cloaked ? !onOtherDesktop(hwnd) : !listAllDesktops && onOtherDesktop(hwnd)) return 1;
      // Of this app's own windows only the ones registered (the settings/widgets window) belong on
      // the taskbar: the menu and preview windows look like app windows to Windows too.
      if (own && !ownTaskbarTitles.has(title)) return 1;
      collected.push({ hwnd, title, pid, exe: exePathOf(pid), minimized: !!U.IsIconic(hwnd) });
      return 1;
    },
    { args: ["ptr", "ptr"], returns: "i32" },
  );
  U.EnumWindows(enumCallback, null);
  if (exeCache.size > 512) exeCache.clear();
  return collected;
}


/** Hidden by DWM (another virtual desktop, a Store app suspended): not on the taskbar then. */
export function isCloaked(hwnd: HWND): boolean {
  cloakBuf[0] = 0;
  dwmapi.symbols.DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, cloakBytes, 4);
  return !!cloakBuf[0];
}


const ole32 = dlopen("ole32.dll", {
  CoInitializeEx: { args: ["ptr", "u32"], returns: "i32" },
  CoCreateInstance: { args: ["ptr", "ptr", "u32", "ptr", "ptr"], returns: "i32" },
});

function guidBytes(s: string) {
  const h = s.replace(/[{}-]/g, "");
  const b = new Uint8Array(16);
  const v = new DataView(b.buffer);
  v.setUint32(0, parseInt(h.slice(0, 8), 16), true);
  v.setUint16(4, parseInt(h.slice(8, 12), 16), true);
  v.setUint16(6, parseInt(h.slice(12, 16), 16), true);
  for (let i = 0; i < 8; i++) b[8 + i] = parseInt(h.slice(16 + i * 2, 18 + i * 2), 16);
  return b;
}

/**
 * IVirtualDesktopManager, the documented part of the virtual desktop API (shobjidl_core.h):
 * vtable 3 IsWindowOnCurrentVirtualDesktop(HWND, BOOL*), 4 GetWindowDesktopId(HWND, GUID*).
 * 0 = not created yet, null = unavailable (no COM, an old build).
 */
let vdm: Pointer | null | 0 = 0;
let vdmCurrent: ((obj: Pointer, hwnd: HWND, out: Uint8Array) => number) | null = null;
let vdmDesktopId: ((obj: Pointer, hwnd: HWND, out: Uint8Array) => number) | null = null;
const vdmBool = new Uint32Array(1);
const vdmGuid = new Uint8Array(16);

function desktopManager(): Pointer | null {
  if (vdm !== 0) return vdm;
  vdm = null;
  ole32.symbols.CoInitializeEx(null, 2 /* COINIT_APARTMENTTHREADED */);
  const out = new BigUint64Array(1);
  const hr = ole32.symbols.CoCreateInstance(
    guidBytes("aa509086-5ca9-4c25-8f95-589d3c07b48a"), // CLSID_VirtualDesktopManager
    null,
    0x17 /* CLSCTX_ALL */,
    guidBytes("a5cd92ff-29be-454c-8d04-d82879fb3f1b"), // IID_IVirtualDesktopManager
    new Uint8Array(out.buffer),
  );
  if (hr !== 0 || !out[0]) return null;
  const obj = Number(out[0]) as Pointer;
  const vtbl = read.ptr(obj, 0) as Pointer;
  const slot = (i: number) => new CFunction({ ptr: read.ptr(vtbl, i * 8) as Pointer, args: ["ptr", "ptr", "ptr"], returns: "i32" }) as never;
  vdmCurrent = slot(3);
  vdmDesktopId = slot(4);
  vdm = obj;
  return vdm;
}

/**
 * Whether the window sits on a virtual desktop other than the one shown, the way the taskbar
 * tells (IVirtualDesktopManager::IsWindowOnCurrentVirtualDesktop). A window no desktop tracks
 * (GetWindowDesktopId fails or gives GUID_NULL: a suspended Store frame, a shell surface) is not
 * on another desktop.
 */
export function onOtherDesktop(hwnd: HWND): boolean {
  const m = desktopManager();
  if (!m) return false;
  vdmBool[0] = 1;
  if (vdmCurrent!(m, hwnd, new Uint8Array(vdmBool.buffer)) !== 0 || vdmBool[0]) return false;
  vdmGuid.fill(0);
  if (vdmDesktopId!(m, hwnd, vdmGuid) !== 0) return false;
  return vdmGuid.some((b) => b !== 0);
}

/**
 * Whether the window is left off the taskbar for being cloaked. Windows on another virtual
 * desktop are cloaked by the shell; with "show windows on all desktops" (allDesktops) the
 * taskbar lists them anyway, while windows cloaked for any other reason stay off.
 */
export function cloakedOff(hwnd: HWND, allDesktops: boolean): boolean {
  if (!isCloaked(hwnd)) return !allDesktops && onOtherDesktop(hwnd);
  return !(allDesktops && onOtherDesktop(hwnd));
}

export function isMinimized(hwnd: HWND): boolean {
  return !!U.IsIconic(hwnd);
}

export function foregroundWindow(): HWND | null {
  return U.GetForegroundWindow() as HWND | null;
}

export function activateWindow(hwnd: HWND) {
  // As the taskbar does it: no synthetic keys. The click on the dock makes this process the one
  // that received the last input, so Windows lets it hand the foreground over. (An ALT tap here
  // would make the app show focus rectangles and keyboard cues on its controls.)
  if (U.IsIconic(hwnd)) U.ShowWindow(hwnd, SW_RESTORE);
  // Windows of elevated apps (run as administrator) refuse ShowWindow from this process;
  // SwitchToThisWindow goes through the shell, restores them and brings them forward.
  if (U.IsIconic(hwnd) || !U.SetForegroundWindow(hwnd)) U.SwitchToThisWindow(hwnd, 1);
}


const hoverTimeBuf = new Uint32Array(1);

/**
 * How long the pointer must rest for a hover to count (SPI_GETMOUSEHOVERTIME, 400 ms by default):
 * the wait of the taskbar before a button that files are dragged over brings its window forward.
 * Read each time, so a change in the system setting applies at once.
 */
export function mouseHoverTime(): number {
  return U.SystemParametersInfoW(0x66 /* SPI_GETMOUSEHOVERTIME */, 0, hoverTimeBuf, 0) ? hoverTimeBuf[0]! : 400;
}

/** The desktop takes the foreground (nothing left to activate), as after the last window minimizes. */
export function activateDesktop() {
  const desktop = U.GetShellWindow() as HWND | null;
  if (desktop) U.SetForegroundWindow(desktop);
}

export function windowPid(hwnd: HWND): number {
  U.GetWindowThreadProcessId(hwnd, pidBytes);
  return pidBuf[0]!;
}


/** The window that owns `hwnd` (a dialog's main window), or null. */
export function ownerOf(hwnd: HWND): HWND | null {
  return U.GetWindow(hwnd, GW_OWNER) as HWND | null;
}

export function minimizeWindow(hwnd: HWND) {
  // The system menu's Minimize, as the taskbar sends it: the app minimizes itself (with its own
  // animation and state handling) and Windows activates the next window. Also works for elevated apps.
  if (!U.PostMessageW(hwnd, 0x0112 /* WM_SYSCOMMAND */, 0xf020 /* SC_MINIMIZE */, 0)) U.ShowWindow(hwnd, SW_MINIMIZE);
}

export function closeWindow(hwnd: HWND) {
  // "Fechar janela" on the taskbar is the system menu's Close (SC_CLOSE): the app handles it as if
  // its own close button was used (apps that close to the tray keep doing so); elevated apps take it too.
  if (!U.PostMessageW(hwnd, 0x0112 /* WM_SYSCOMMAND */, 0xf060 /* SC_CLOSE */, 0)) U.PostMessageW(hwnd, 0x0010 /* WM_CLOSE */, 0, 0);
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
  U.GetWindowThreadProcessId(core, new Uint8Array(pidBuf.buffer));
  const handle = K.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pidBuf[0]!);
  if (!handle) return "";
  try {
    const len = new Uint32Array([textBuf.length]);
    if (K.GetApplicationUserModelId(handle, new Uint8Array(len.buffer), new Uint8Array(textBuf.buffer)) !== 0) return "";
    return decodeWide(textBuf.buffer, 0, Math.max(0, len[0]! - 1) * 2);
  } finally {
    K.CloseHandle(handle);
  }
}


/**
 * The process that owns what a window shows: for a Store app frame (ApplicationFrameHost), the app
 * in its CoreWindow, not the frame host shared by every Store app; otherwise the window's own.
 */
export function appProcessOf(hwnd: HWND): number {
  const core = U.FindWindowExW(hwnd, null, wide("Windows.UI.Core.CoreWindow"), null) as HWND | null;
  return windowPid(core ?? hwnd);
}

/**
 * Ends a process at once, as the taskbar's "End task" (Settings > System > For developers) does:
 * TerminateProcess, no close request, so a hung app goes too. False when Windows refuses (an
 * elevated app from a normal dock).
 */
export function terminateProcess(pid: number): boolean {
  const handle = K.OpenProcess(0x1 /* PROCESS_TERMINATE */, 0, pid);
  if (!handle) return false;
  try {
    return !!K.TerminateProcess(handle, 1);
  } finally {
    K.CloseHandle(handle);
  }
}

/**
 * The AppUserModelID of a packaged process (MSIX desktop apps such as ChatGPT), or "" for a plain
 * Win32 one. The taskbar shows such apps as their package entry: its name and its logo assets
 * (sized for the taskbar, unplated) instead of the exe's embedded icon.
 */
export function packagedAppId(pid: number): string {
  const handle = K.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
  if (!handle) return "";
  try {
    const len = new Uint32Array([textBuf.length]);
    if (K.GetApplicationUserModelId(handle, new Uint8Array(len.buffer), new Uint8Array(textBuf.buffer)) !== 0) return "";
    return decodeWide(textBuf.buffer, 0, Math.max(0, len[0]! - 1) * 2);
  } finally {
    K.CloseHandle(handle);
  }
}

/**
 * The visible part of a window inside its window rect: Windows 10/11 frames carry invisible resize
 * borders that a thumbnail would show as empty margins. Null for a minimized window.
 */
export function visibleFrame(hwnd: HWND): Rect | null {
  if (U.IsIconic(hwnd)) return null;
  const outer = windowRect(hwnd);
  const r = new Int32Array(4);
  if (dwmapi.symbols.DwmGetWindowAttribute(hwnd, 9 /* DWMWA_EXTENDED_FRAME_BOUNDS */, new Uint8Array(r.buffer), 16) !== 0) return null;
  const frame = { left: r[0]! - outer.left, top: r[1]! - outer.top, right: r[2]! - outer.left, bottom: r[3]! - outer.top };
  return frame.right > frame.left && frame.bottom > frame.top ? frame : null;
}


const clientToScreen = dlopen("user32.dll", { ClientToScreen: { args: ["ptr", "ptr"], returns: "i32" } }).symbols.ClientToScreen;

/**
 * A rectangle of the window's client area (ITaskbarList3::SetThumbnailClip's coordinates) inside
 * its window rect, as a DWM thumbnail's source takes it. Null for a minimized window.
 */
export function clientRectInWindow(hwnd: HWND, rect: Rect): Rect | null {
  if (U.IsIconic(hwnd)) return null;
  const outer = windowRect(hwnd);
  const p = new Int32Array(2);
  if (!clientToScreen(hwnd, new Uint8Array(p.buffer))) return null;
  const dx = p[0]! - outer.left;
  const dy = p[1]! - outer.top;
  return { left: rect.left + dx, top: rect.top + dy, right: rect.right + dx, bottom: rect.bottom + dy };
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
const timeArgs = [0, 8, 16].map((offset) => new Uint8Array(times.buffer, offset, 8));
let lastTimes: [bigint, bigint, bigint] | null = null;

/** CPU usage 0..100 since the previous call. */
export function cpuUsage(): number {
  K.GetSystemTimes(timeArgs[0], timeArgs[1], timeArgs[2]);
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
