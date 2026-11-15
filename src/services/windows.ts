import { store } from "@tarve/core";
import { basename, dirname } from "node:path";
import { windowPid, activateWindow, foregroundWindow, listTaskbarWindows, minimizeWindow, closeWindow, type HWND } from "../native/win32";
import { createPoller } from "./poller";

export interface AppWindow {
  hwnd: HWND;
  title: string;
  minimized: boolean;
}

export interface RunningApp {
  /** Lower-cased exe path: the key pinned apps match against. */
  key: string;
  exe: string;
  name: string;
  /** In the order they opened, so previews and menus list them in a stable order. */
  windows: AppWindow[];
  /** The same windows front to back (most recently used first), for activation. */
  recent: HWND[];
}

export const desktop = store({
  apps: [] as RunningApp[],
  /** Key of the app whose window was last in front (the dock itself excluded). */
  activeKey: "",
});

let lastForeground: HWND | null = null;
/** Keys in the order apps first appeared, so icons keep their place when focus changes. */
let appOrder: string[] = [];
let signature = "";
/** When each window was first seen, to keep a stable order inside an app. */
const firstSeen = new Map<HWND, number>();
let seenCounter = 0;

export const prettyName = (exe: string) => {
  const raw = basename(exe).replace(/\.(exe|lnk)$/i, "");
  return raw.charAt(0).toUpperCase() + raw.slice(1);
};

export function refreshWindows() {
  const windows = listTaskbarWindows();
  const fg = foregroundWindow();
  const groups = new Map<string, RunningApp>();
  let activeKey = desktop.activeKey;
  for (const w of windows) {
    if (!w.exe) continue;
    const key = w.exe.toLowerCase();
    let group = groups.get(key);
    if (!group) {
      group = { key, exe: w.exe, name: prettyName(w.exe), windows: [], recent: [] };
      groups.set(key, group);
    }
    if (!firstSeen.has(w.hwnd)) firstSeen.set(w.hwnd, seenCounter++);
    group.windows.push({ hwnd: w.hwnd, title: w.title, minimized: w.minimized });
    group.recent.push(w.hwnd);
    if (fg && w.hwnd === fg) activeKey = key;
  }
  const alive = new Set(windows.map((w) => w.hwnd));
  for (const hwnd of firstSeen.keys()) if (!alive.has(hwnd)) firstSeen.delete(hwnd);
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

export const windowsPoller = createPoller(1000, refreshWindows);

/**
 * The window that was in front before the dock was clicked. Clicking the dock brings the dock
 * forward, so the click handler cannot ask Windows; this follows the foreground closely instead.
 */
setInterval(() => {
  const fg = foregroundWindow();
  if (fg && windowPid(fg) !== process.pid) lastForeground = fg;
}, 150);

/** Starts a program, a document or a ms-settings: link, from the program's own folder. */
export function launch(path: string) {
  const isFile = /^[a-z]:\\/i.test(path);
  const args = isFile ? ["cmd.exe", "/c", "start", "", "/D", dirname(path), path] : ["cmd.exe", "/c", "start", "", path];
  Bun.spawn(args, { windowsHide: true, stdout: "ignore", stderr: "ignore" });
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

export function focusWindow(hwnd: HWND) {
  activateWindow(hwnd);
  setTimeout(refreshWindows, 120);
}

export function openFileLocation(path: string) {
  Bun.spawn(["explorer.exe", `/select,${path}`], { windowsHide: true, stdout: "ignore", stderr: "ignore" });
}

export function closeApp(key: string) {
  const app = desktop.apps.find((a) => a.key === key);
  app?.windows.forEach((w) => closeWindow(w.hwnd));
  setTimeout(refreshWindows, 400);
}
