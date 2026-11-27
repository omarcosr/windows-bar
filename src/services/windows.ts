import { store } from "@tarve/core";
import { basename, dirname, join } from "node:path";
import {
  storeAppId,
  packagedAppId,
  windowPid,
  activateWindow,
  foregroundWindow,
  listTaskbarWindows,
  minimizeWindow,
  closeWindow,
  activateDesktop,
  isWindowVisible,
  cloakedOff,
  isMinimized,
  ownerOf,
  appProcessOf,
  exePathOf,
  terminateProcess,
  type HWND,
  type TopWindow, monitorOf } from "../native/win32";
import { readFileSync, writeFileSync } from "node:fs";
import { configDir } from "../config";
import { windowAppId } from "../native/app-id";
import { openUri, showInFolder } from "../native/desktop";
import { fileDescription } from "../native/version-info";
import { explorerButtonRank } from "./explorer-buttons";
import { onShellEvent } from "../native/shell-events";
import { buttonsOnOwnDisplayOnly, onTaskbarPrefsChange, taskbarPrefs } from "./taskbar-prefs";
import { popupSystemMenu, sysCommand, SC_RESTORE } from "../native/system-menu";
import { programOfAppId } from "../native/shell-item";

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
  /** The window in front itself (0 for none), for per-window buttons when the taskbar does not combine. */
  activeHwnd: 0,
});

/** The window in front before the dock was clicked: set at start, then by foreground events (noteForeground). */
let lastForeground: HWND | null = foregroundWindow();
/** Keys in the order apps first appeared, so icons keep their place when focus changes. */
let appOrder: string[] = [];
let signature = "";
/** When each window was first seen, to keep a stable order inside an app. */
const firstSeen = new Map<HWND, number>();
/** The app each window was last grouped under, so an app keeps its place while its window is briefly unlisted. */
const keyOf = new Map<HWND, string>();
/** The windows of the last refresh, as listed (title, process). */
let lastListed = new Map<HWND, TopWindow>();

/**
 * The order of the windows inside each app, kept across dock restarts (an update, a crash): the
 * windows already open at start then keep the places they had instead of taking the z-order.
 * Keyed by window and process, so a reused handle does not inherit a place.
 */
const ORDER_FILE = join(configDir, "window-order.json");
const savedOrder = new Map<string, number>();
try {
  const list = JSON.parse(readFileSync(ORDER_FILE, "utf8")) as [string, number][];
  for (const [id, seq] of list) savedOrder.set(id, seq);
} catch {
  // No order saved yet.
}
let saveTimer: ReturnType<typeof setTimeout> | undefined;
function saveOrder(windows: readonly TopWindow[]) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const list = windows.filter((w) => firstSeen.has(w.hwnd)).map((w) => [`${Number(w.hwnd)}:${w.pid}`, firstSeen.get(w.hwnd)!]);
    try {
      writeFileSync(ORDER_FILE, JSON.stringify(list));
    } catch (error) {
      console.error("[windows] window order", error);
    }
  }, 2000);
}
/** After every saved place, so a new window always comes after them. */
let seenCounter = Math.max(-1, ...savedOrder.values()) + 1;

/** Store apps run inside ApplicationFrameHost.exe; each is told apart by its AppUserModelID. */
const appIdCache = new Map<HWND, string>();
/** Packaged desktop apps (their AppUserModelID, or "" for plain Win32), by process id and program (an id is reused by a later process). */
const packageCache = new Map<string, string>();
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
  const processKey = `${pid}:${exe}`;
  let packaged = packageCache.get(processKey);
  if (packaged === undefined) {
    packaged = packagedAppId(pid);
    packageCache.set(processKey, packaged);
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
  if (packaged) return { key: appIdKey(id), exe: `shell:AppsFolder\\${packaged}`, explicitId: true };
  // A window whose AppUserModelID belongs to another app than its process shows that app's Start
  // entry, as the taskbar does: Explorer's Control Panel windows (Network Connections) carry
  // Microsoft.Windows.ControlPanel and get the Control Panel's icon, not explorer.exe's folder.
  const program = programOfAppId(id);
  if (program && program !== exe.toLowerCase()) return { key: appIdKey(id), exe: `shell:AppsFolder\\${id}`, explicitId: true };
  return { key: appIdKey(id), exe, explicitId: true };
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
  const allDesktops = taskbarPrefs.allDesktops;
  const all = listTaskbarWindows(allDesktops);
  // A window already on the dock keeps its button while its title is empty for a moment (apps
  // clear it while they change it), as Explorer's taskbar does: measured, VS Code keeps its button
  // there with an empty title. Hidden, cloaked (another desktop) or destroyed windows still go.
  const seen = new Set(all.map((w) => w.hwnd));
  for (const [hwnd, info] of lastListed)
    if (!seen.has(hwnd) && isWindowVisible(hwnd) && !cloakedOff(hwnd, allDesktops)) all.push({ ...info, minimized: isMinimized(hwnd) });
  lastListed = new Map(all.map((w) => [w.hwnd, w]));
  const listed = new Set(all.map((w) => w.hwnd as unknown as number));
  for (const hwnd of closing) if (!listed.has(hwnd)) closing.delete(hwnd);
  const ownDisplay = buttonsOnOwnDisplayOnly();
  const windows = all.filter((w) => !closing.has(w.hwnd as unknown as number) && (!ownDisplay || onPrimaryDisplay(w.hwnd)));
  const groups = new Map<string, RunningApp>();
  // The app in front is the one owning the last non-dock foreground window; the desktop or a
  // window that is not on the taskbar leaves no app active, as on the Windows taskbar.
  let activeKey = "";
  let activeHwnd = 0;
  const front = buttonOf(lastForeground, (h) => windows.some((w) => w.hwnd === h));
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
    if (!firstSeen.has(w.hwnd)) {
      const saved = savedOrder.get(`${Number(w.hwnd)}:${w.pid}`);
      firstSeen.set(w.hwnd, saved ?? seenCounter++);
    }
    keyOf.set(w.hwnd, key);
    group.windows.push({ hwnd: w.hwnd, title: w.title, minimized: w.minimized });
    group.recent.push(w.hwnd);
    if (front && w.hwnd === front && !w.minimized) {
      activeKey = key;
      activeHwnd = Number(w.hwnd);
    }
  }
  const alive = new Set(windows.map((w) => w.hwnd));
  // A window still on screen but briefly off the list (cloaked while it starts or on another
  // desktop, a title that is empty for a moment, its app ID still resolving) keeps its place and
  // its app's: Explorer keeps a button until the window is hidden or destroyed. Without this it
  // came back at the end, and windows and icons swapped places.
  for (const hwnd of firstSeen.keys()) {
    if (alive.has(hwnd) || isWindowVisible(hwnd)) continue;
    firstSeen.delete(hwnd);
    keyOf.delete(hwnd);
  }
  for (const hwnd of appIdCache.keys()) if (!alive.has(hwnd)) appIdCache.delete(hwnd);
  for (const hwnd of windowIdCache.keys()) if (!alive.has(hwnd)) windowIdCache.delete(hwnd);
  const processes = new Set(windows.map((w) => `${w.pid}:${w.exe}`));
  for (const id of packageCache.keys()) if (!processes.has(id)) packageCache.delete(id);
  if (desktop.flashing.some((h) => !alive.has(h as unknown as HWND)))
    desktop.flashing = desktop.flashing.filter((h) => alive.has(h as unknown as HWND));
  for (const group of groups.values()) group.windows.sort((a, b) => firstSeen.get(a.hwnd)! - firstSeen.get(b.hwnd)!);
  const lingering = new Set(keyOf.values());
  appOrder = appOrder.filter((key) => groups.has(key) || lingering.has(key));
  if (!appOrder.length && groups.size) {
    // At start the apps already open take the places Explorer's own buttons have, not the z-order.
    const rank = explorerButtonRank();
    if (rank) {
      const ranks = new Map([...groups.values()].map((g) => [g.key, rank(g.exe)]));
      appOrder = [...groups.keys()].sort((a, b) => ranks.get(a)! - ranks.get(b)!);
    }
  }
  for (const key of groups.keys()) if (!appOrder.includes(key)) appOrder.push(key);
  const apps = appOrder.filter((key) => groups.has(key)).map((key) => groups.get(key)!);
  // Only touch the store when something visible changed, so idle polling paints nothing.
  const next =
    apps
      .map((a) => `${a.key}:${a.windows.map((w) => `${w.hwnd}${w.minimized ? "m" : ""}${w.title}`).join(",")}:${a.recent.join(",")}`)
      .join("|") +
    "#" +
    activeKey +
    "#" +
    activeHwnd;
  if (next !== signature) {
    signature = next;
    saveOrder(windows);
    desktop.apps = apps;
    desktop.activeKey = activeKey;
    desktop.activeHwnd = activeHwnd;
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
    // With buttons only on the display where the window is open, a window dragged (or Win+Shift+
    // arrowed) to another display leaves the dock, and a change of the setting relists them.
    const offMoved = onShellEvent((event) => {
      if (event.type === "moved" && buttonsOnOwnDisplayOnly()) scheduleRefresh();
    });
    const offPrefs = onTaskbarPrefsChange(scheduleRefresh);
    return () => {
      offMoved();
      offPrefs();
    };
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


/** The window whose taskbar button stands for `hwnd`: itself, or the first owner up its chain that has one. */
function buttonOf(hwnd: HWND | null, listed: (h: HWND) => boolean): HWND | null {
  for (let h = hwnd, i = 0; h && i < 8; h = ownerOf(h), i++) if (listed(h)) return h;
  return null;
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
  // Decide on the live state, not on the last refresh or a foreground event still on its way:
  // a window minimized, restored or activated a moment ago would flip the click's meaning.
  const fg = foregroundWindow();
  if (fg && countsAsApp(fg)) lastForeground = fg;
  refreshWindows();
  const app = desktop.apps.find((a) => a.key === key);
  if (!app || app.windows.length === 0) {
    if (launchPath) launch(launchPath);
    return;
  }
  // Like the Windows taskbar: the app in front hides on click, any other app comes forward.
  // A dialog in front counts for the window that owns it, as its taskbar button shows active.
  const front = buttonOf(lastForeground, (h) => app.windows.some((w) => w.hwnd === h));
  const inFront = app.windows.some((w) => w.hwnd === front && !w.minimized);
  if (inFront) {
    for (const w of app.windows) if (!w.minimized) minimizeWindow(w.hwnd);
    lastForeground = null;
    activateNext(app);
  } else {
    // The most recently used window comes forward (restored if it was minimized).
    const minimized = new Set(app.windows.filter((w) => w.minimized).map((w) => w.hwnd));
    const target = app.recent.find((h) => !minimized.has(h)) ?? app.recent[0]!;
    activateWindow(target);
    // Known at once, not when the foreground event arrives: a quick second click minimizes it.
    lastForeground = target;
  }
  setTimeout(refreshWindows, 120);
}

/**
 * After the app in front is minimized, the window under it takes the keyboard, as when the taskbar
 * minimizes it; the desktop when no window is left.
 */
function activateNext(app: RunningApp) {
  const mine = new Set(app.windows.map((w) => w.hwnd));
  // Top to bottom (EnumWindows order): the first app window still on screen is the one under it.
  const next = listTaskbarWindows().find((w) => !mine.has(w.hwnd) && !w.minimized && w.pid !== process.pid);
  if (next) {
    activateWindow(next.hwnd);
    lastForeground = next.hwnd;
  } else activateDesktop();
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
  lastForeground = hwnd;
  setTimeout(refreshWindows, 120);
}

export function openFileLocation(path: string) {
  if (!showInFolder(path)) console.error("[windows] Não foi possível abrir o local de", path);
}

/**
 * "Encerrar tarefa": ends the processes behind the app's windows at once, as the taskbar does
 * with End task on. File Explorer windows are left alone: their process is the shell itself.
 */
export function endTask(key: string) {
  const app = desktop.apps.find((a) => a.key === key);
  if (!app) return;
  const pids = new Set(app.windows.map((w) => appProcessOf(w.hwnd)));
  for (const pid of pids) {
    if (!pid || pid === process.pid || /\\explorer\.exe$/i.test(exePathOf(pid))) continue;
    if (!terminateProcess(pid)) console.error("[windows] Não foi possível encerrar o processo", pid);
  }
  setTimeout(refreshWindows, 300);
}

export function closeApp(key: string) {
  const app = desktop.apps.find((a) => a.key === key);
  app?.windows.forEach((w) => closeWindow(w.hwnd));
  setTimeout(refreshWindows, 400);
}
/**
 * Whether a window is on the primary display, where Explorer keeps its main taskbar (and the dock
 * stands in for it): the display MonitorFromWindow picks, which for a minimized window is the one
 * it will be restored to. The primary display is the one at the virtual screen's origin.
 */
function onPrimaryDisplay(hwnd: HWND): boolean {
  const { monitor } = monitorOf(hwnd);
  return monitor.left === 0 && monitor.top === 0;
}
/**
 * A click on one window's own button (the taskbar set to never combine): the window in front
 * minimizes, any other comes forward (restored if minimized), as Explorer's ungrouped button does.
 */
export function activateWindowButton(hwnd: HWND) {
  const fg = foregroundWindow();
  if (fg && countsAsApp(fg)) lastForeground = fg;
  refreshWindows();
  const app = desktop.apps.find((a) => a.windows.some((w) => w.hwnd === hwnd));
  const win = app?.windows.find((w) => w.hwnd === hwnd);
  if (!app || !win) return;
  const front = buttonOf(lastForeground, (h) => h === hwnd);
  if (front === hwnd && !win.minimized) {
    minimizeWindow(hwnd);
    lastForeground = null;
    activateNext({ ...app, windows: [win], recent: [hwnd] });
  } else {
    activateWindow(hwnd);
    lastForeground = hwnd;
  }
  setTimeout(refreshWindows, 120);
}
/** Ctrl+Shift+click: the pinned shortcut or program started with the shell's "runas" verb (UAC prompt), as the taskbar does. */
export function launchAsAdmin(path: string) {
  const directory = /^[a-z]:\\.*\.exe$/i.test(path) ? dirname(path) : undefined;
  if (!openUri(path, directory, "runas")) console.error("[windows] Não foi possível abrir como administrador", path);
}
/**
 * Ctrl+click, as on the taskbar: the app's windows take turns in front, in the button's order; the
 * first press brings the most recently used one. Nothing open: the app starts.
 */
export function cycleApp(key: string, launchPath?: string) {
  const fg = foregroundWindow();
  if (fg && countsAsApp(fg)) lastForeground = fg;
  refreshWindows();
  const app = desktop.apps.find((a) => a.key === key);
  if (!app || app.windows.length === 0) {
    if (launchPath) launch(launchPath);
    return;
  }
  const front = buttonOf(lastForeground, (h) => app.windows.some((w) => w.hwnd === h));
  const index = app.windows.findIndex((w) => w.hwnd === front && !w.minimized);
  const target = index < 0 ? (app.recent[0] ?? app.windows[0]!.hwnd) : app.windows[(index + 1) % app.windows.length]!.hwnd;
  activateWindow(target);
  lastForeground = target;
  setTimeout(refreshWindows, 120);
}
/**
 * Shift+right-click on a one-window button: that window's own system menu at the pointer
 * (WM_POPUPSYSTEMMENU, as Explorer posts it). False when the app has several windows (group menu).
 */
export function showWindowSystemMenu(key: string, x: number, y: number): boolean {
  const app = desktop.apps.find((a) => a.key === key);
  if (!app || app.windows.length !== 1) return false;
  const hwnd = app.windows[0]!.hwnd;
  lastForeground = hwnd;
  return popupSystemMenu(hwnd, x, y);
}
/** The group menu's "Restaurar todas as janelas": SC_RESTORE to each minimized window, as the taskbar sends it. */
export function restoreApp(key: string) {
  const app = desktop.apps.find((a) => a.key === key);
  for (const w of app?.windows ?? []) if (w.minimized) sysCommand(w.hwnd, SC_RESTORE);
  setTimeout(refreshWindows, 120);
}
/** The group menu's "Minimizar todas as janelas": SC_MINIMIZE to each window on screen. */
export function minimizeApp(key: string) {
  const app = desktop.apps.find((a) => a.key === key);
  for (const w of app?.windows ?? []) if (!w.minimized) minimizeWindow(w.hwnd);
  setTimeout(refreshWindows, 120);
}
