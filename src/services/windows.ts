import { store } from "@tarve/core";
import { basename, dirname } from "node:path";
import {
  storeAppId,
  packagedAppId,
  windowPid,
  activateWindow,
  foregroundWindow,
  listTaskbarWindows,
  minimizeWindow,
  closeWindow,
  type HWND,
} from "../native/win32";
import { windowAppId } from "../native/app-id";
import { openUri, showInFolder } from "../native/desktop";
import { fileDescription } from "../native/version-info";

export interface AppWindow {
  hwnd: HWND;
  title: string;
  minimized: boolean;
}

export interface RunningApp {
  /**
   * The app's identity as the taskbar groups it: its AppUserModelID (from the window, the package or
   * the Store frame) as "shell:appsfolder\\<id>", lower-cased; the exe path for plain Win32 apps.
   */
  key: string;
  /** What its icon is read from and what starts it again: the package entry or the exe. */
  exe: string;
  /** The lower-cased program path behind the windows. */
  program: string;
  /** Grouped by an AppUserModelID the window or package sets, not by the program path. */
  explicitId: boolean;
  name: string;
  /** In the order they opened, so previews and menus list them in a stable order. */
  windows: AppWindow[];
  /** The same windows front to back (most recently used first), for activation. */
  recent: HWND[];
}

export const desktop = store({
  apps: [] as RunningApp[],
  /** Windows asking for attention (FlashWindowEx), until they are activated. */
  flashing: [] as number[],
  /** Key of the app whose window was last in front (the dock itself excluded). */
  activeKey: "",
});

/** The window in front before the dock was clicked: set at start, then by foreground events (noteForeground). */
let lastForeground: HWND | null = foregroundWindow();
/** Keys in the order apps first appeared, so icons keep their place when focus changes. */
let appOrder: string[] = [];
let signature = "";
/** When each window was first seen, to keep a stable order inside an app. */
const firstSeen = new Map<HWND, number>();
let seenCounter = 0;

/** Store apps run inside ApplicationFrameHost.exe; each is told apart by its AppUserModelID. */
const appIdCache = new Map<HWND, string>();
/** Packaged desktop apps (their AppUserModelID, or "" for plain Win32), by process id. */
const packageCache = new Map<number, string>();
/** AppUserModelIDs set on the windows themselves ("" when none), by window. */
const windowIdCache = new Map<HWND, string>();

/** The taskbar's key for an AppUserModelID. */
export const appIdKey = (id: string) => `shell:appsfolder\\${id}`.toLowerCase();

/**
 * The app a window belongs to, resolved as the taskbar does: the window's own AppUserModelID
 * (Chrome profiles and web apps, the Store frame), then its process's package, then the exe path.
 */
function identityOf(hwnd: HWND, exe: string, pid: number): { key: string; exe: string; explicitId: boolean } {
  if (/\\ApplicationFrameHost\.exe$/i.test(exe)) {
    // The frame's own AppUserModelID first: it is there even while the app is minimized and its
    // CoreWindow (the process asked by storeAppId) is gone.
    let id = appIdCache.get(hwnd);
    if (!id) {
      id = windowAppId(hwnd) || storeAppId(hwnd);
      if (id) appIdCache.set(hwnd, id);
    }
    return id ? { key: appIdKey(id), exe: `shell:AppsFolder\\${id}`, explicitId: true } : { key: exe.toLowerCase(), exe, explicitId: false };
  }
  let packaged = packageCache.get(pid);
  if (packaged === undefined) {
    packaged = packagedAppId(pid);
    packageCache.set(pid, packaged);
  }
  let own = windowIdCache.get(hwnd);
  if (own === undefined) {
    // Not for the dock's own windows (the widgets window): the property store asks the window's
    // thread, which is this one, busy right then, and it stalled the dock ~300 ms on every open.
    own = pid === process.pid ? "" : windowAppId(hwnd);
    windowIdCache.set(hwnd, own);
  }
  const id = own || packaged;
  if (!id) return { key: exe.toLowerCase(), exe, explicitId: false };
  // A packaged app shows its package entry (name, logo); a Win32 app keeps its exe for the icon.
  return { key: appIdKey(id), exe: packaged ? `shell:AppsFolder\\${packaged}` : exe, explicitId: true };
}

/** The program's name as the taskbar shows it (its FileDescription); the file name only without one. */
export const prettyName = (exe: string) => {
  const described = /\.exe$/i.test(exe) ? fileDescription(exe) : "";
  if (described) return described;
  const raw = basename(exe).replace(/\.(exe|lnk)$/i, "");
  return raw.charAt(0).toUpperCase() + raw.slice(1);
};

/**
 * Windows the shell said are going away (HSHELL_WINDOWDESTROYED, sent while the window still
 * exists, and also when it is hidden). Explorer drops the button right then; the list skips them
 * the same way instead of waiting for the window to be gone, until the shell shows one again.
 */
const closing = new Set<number>();

/** HSHELL_WINDOWDESTROYED: the button goes at once, as on the taskbar. */
export function windowGone(hwnd: number) {
  closing.add(hwnd);
  scheduleRefresh();
}

/** HSHELL_WINDOWCREATED: a hidden window shown again gets its button back. */
export function windowShown(hwnd: number) {
  closing.delete(hwnd);
  scheduleRefresh();
}

export function refreshWindows() {
  const all = listTaskbarWindows();
  const listed = new Set(all.map((w) => w.hwnd as unknown as number));
  for (const hwnd of closing) if (!listed.has(hwnd)) closing.delete(hwnd);
  const windows = all.filter((w) => !closing.has(w.hwnd as unknown as number));
  const groups = new Map<string, RunningApp>();
  // The app in front is the one owning the last non-dock foreground window; the desktop or a
  // window that is not on the taskbar leaves no app active, as on the Windows taskbar.
  let activeKey = "";
  for (const w of windows) {
    if (!w.exe) continue;
    const program = w.exe.toLowerCase();
    const identity = identityOf(w.hwnd, w.exe, w.pid);
    const key = identity.key;
    let group = groups.get(key);
    if (!group) {
      const exe = identity.exe;
      group = { key, exe, program, explicitId: identity.explicitId, name: exe.startsWith("shell:") ? w.title : prettyName(exe), windows: [], recent: [] };
      groups.set(key, group);
    }
    if (!firstSeen.has(w.hwnd)) firstSeen.set(w.hwnd, seenCounter++);
    group.windows.push({ hwnd: w.hwnd, title: w.title, minimized: w.minimized });
    group.recent.push(w.hwnd);
    if (lastForeground && w.hwnd === lastForeground && !w.minimized) activeKey = key;
  }
  const alive = new Set(windows.map((w) => w.hwnd));
  for (const hwnd of firstSeen.keys()) if (!alive.has(hwnd)) firstSeen.delete(hwnd);
  for (const hwnd of appIdCache.keys()) if (!alive.has(hwnd)) appIdCache.delete(hwnd);
  for (const hwnd of windowIdCache.keys()) if (!alive.has(hwnd)) windowIdCache.delete(hwnd);
  const pids = new Set(windows.map((w) => w.pid));
  for (const pid of packageCache.keys()) if (!pids.has(pid)) packageCache.delete(pid);
  if (desktop.flashing.some((h) => !alive.has(h as unknown as HWND)))
    desktop.flashing = desktop.flashing.filter((h) => alive.has(h as unknown as HWND));
  for (const group of groups.values()) group.windows.sort((a, b) => firstSeen.get(a.hwnd)! - firstSeen.get(b.hwnd)!);
  appOrder = appOrder.filter((key) => groups.has(key));
  for (const key of groups.keys()) if (!appOrder.includes(key)) appOrder.push(key);
  const apps = appOrder.map((key) => groups.get(key)!);
  // Only touch the store when something visible changed, so idle polling paints nothing.
  const next =
    apps
      .map((a) => `${a.key}:${a.windows.map((w) => `${w.hwnd}${w.minimized ? "m" : ""}${w.title}`).join(",")}:${a.recent.join(",")}`)
      .join("|") +
    "#" +
    activeKey;
  if (next !== signature) {
    signature = next;
    desktop.apps = apps;
    desktop.activeKey = activeKey;
  }
}

/**
 * The list follows the shell's own signals (main.tsx): the shell hook (created, destroyed,
 * activated, title redrawn) and WinEvents (foreground, minimized/restored, cloaked), as
 * Explorer's task band does. Acquiring it reads the list once; nothing is polled.
 */
export const windowsPoller = {
  acquire(): () => void {
    refreshWindows();
    return () => {};
  },
};

let refreshTimer: ReturnType<typeof setTimeout> | undefined;

/** Coalesces bursts of shell events (a window opening fires several) into one refresh. */
export function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshWindows, 30);
}

/** An app called FlashWindowEx: its icon asks for attention until the window is activated. */
export function markFlashing(hwnd: number) {
  if (!desktop.flashing.includes(hwnd)) desktop.flashing.push(hwnd);
}

export function clearFlashing(hwnd: number) {
  const i = desktop.flashing.indexOf(hwnd);
  if (i >= 0) desktop.flashing.splice(i, 1);
}


/** Other apps' windows, and this app's own taskbar windows (settings); not the dock or its popups. */
function countsAsApp(hwnd: HWND) {
  return windowPid(hwnd) !== process.pid || desktop.apps.some((a) => a.windows.some((w) => w.hwnd === hwnd));
}

/**
 * Starts a program, a pinned shortcut, a document or a URI (ms-settings:, shell:AppsFolder\\…) with
 * ShellExecute, as the taskbar does; a bare program starts in its own folder.
 */
export function launch(path: string) {
  const directory = /^[a-z]:\\.*\.exe$/i.test(path) ? dirname(path) : undefined;
  if (!openUri(path, directory)) console.error("[windows] Não foi possível abrir", path);
}

/** Taskbar click: open, bring forward, cycle windows or minimize, as Windows does. */
export function activateApp(key: string, launchPath?: string) {
  const app = desktop.apps.find((a) => a.key === key);
  if (!app || app.windows.length === 0) {
    if (launchPath) launch(launchPath);
    return;
  }
  // Like the Windows taskbar: the app in front hides on click, any other app comes forward.
  const inFront = app.windows.some((w) => w.hwnd === lastForeground && !w.minimized);
  if (inFront) {
    for (const w of app.windows) if (!w.minimized) minimizeWindow(w.hwnd);
    lastForeground = null;
  } else {
    // The most recently used window comes forward (restored if it was minimized).
    const minimized = new Set(app.windows.filter((w) => w.minimized).map((w) => w.hwnd));
    activateWindow(app.recent.find((h) => !minimized.has(h)) ?? app.recent[0]!);
  }
  setTimeout(refreshWindows, 120);
}

/** A foreground change reported by the shell; the dock's own windows do not count. */
export function noteForeground(hwnd: number) {
  const h = hwnd as unknown as HWND;
  if (countsAsApp(h)) lastForeground = h;
}

/** The last window in front that is not one of the dock's own. */
export function foregroundApp(): HWND | null {
  return lastForeground;
}

export function focusWindow(hwnd: HWND) {
  activateWindow(hwnd);
  setTimeout(refreshWindows, 120);
}

export function openFileLocation(path: string) {
  if (!showInFolder(path)) console.error("[windows] Não foi possível abrir o local de", path);
}

export function closeApp(key: string) {
  const app = desktop.apps.find((a) => a.key === key);
  app?.windows.forEach((w) => closeWindow(w.hwnd));
  setTimeout(refreshWindows, 400);
}
