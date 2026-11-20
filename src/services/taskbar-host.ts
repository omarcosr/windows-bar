import { store } from "@tarve/core";
import { dlopen, type Pointer } from "../native/ffi";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { knownFolderPath } from "../native/shell-item";
import { configDir } from "../config";
import { cursorPos, exePathOf, listTaskbarWindows, mouseHoverTime } from "../native/win32";
import {
  broadcastTaskbarButtonCreated,
  broadcastTaskbarCreated,
  clickIcon,
  encodePng,
  NIF_SHOWTIP,
  popupIcon,
  startTrayHost,
  stopTrayHost,
  windowAlive,
  windowPidOf,
  type NotifyIconMessage,
  type TaskbandMessage, type ThumbBarCall } from "../native/tray-host";
import { hash } from "../runtime/proc";
import { onShellEvent, onWatchChange, watchDestroyed } from "../native/shell-events";
import { encodeWide, decodeWide } from "../native/wide";

/**
 * The dock as the session's taskbar host (see native/tray-host.ts): notification-area icons
 * and the overlay badges apps set with ITaskbarList3, both forwarded on to Explorer.
 * Runs only while a widget uses it.
 */

export interface TrayIcon {
  key: string;
  hwnd: number;
  uid: number;
  guid: string;
  callback: number;
  version: number;
  tip: string;
  /** PNG of the icon, in the cache folder. */
  image: string;
  hidden: boolean;
  exe: string;
  /** Windows 11 shows it on the taskbar (Settings > Personalization > Taskbar > Other icons). */
  promoted: boolean;
  /**
   * NIF_SHOWTIP came with the icon: a version-4 icon then gets the standard tooltip (tip); without
   * it Explorer shows no tooltip and sends NIN_POPUPOPEN / NIN_POPUPCLOSE so the app draws its own.
   */
  showTip: boolean;
}

export interface OverlayBadge {
  /** Lower-cased exe path of the window that set it: the key app icons use. */
  key: string;
  image: string;
}

/** ITaskbarList3 progress on a taskbar button. */
export interface ButtonProgress {
  key: string;
  /** TBPF_*: 1 indeterminate, 2 normal, 4 error, 8 paused. */
  state: number;
  /** 0..1 */
  value: number;
}

export const tray = store({ icons: [] as TrayIcon[] });
/** Overlay badges by window handle. */
export const overlays = store<Record<string, OverlayBadge>>({});
/** Progress (downloads, copies, installs) by window handle. */
export const progress = store<Record<string, ButtonProgress>>({});

/** The progress an app shows on its button (the first of its windows that has one), or undefined. */
export function progressFor(exe: string): ButtonProgress | undefined {
  const key = exe.toLowerCase();
  return Object.values(progress).find((p) => p.key === key);
}


/** A thumbnail toolbar button (ITaskbarList3::ThumbBarAddButtons), with its picture resolved to a PNG. */
export interface ThumbButton {
  id: number;
  /** PNG of hIcon (THB_ICON), or "" to use the image list's picture at bitmap. */
  icon: string;
  /** hIcon's width in pixels. */
  iconSize: number;
  bitmap: number;
  tip: string;
  /** THBF_*: 1 disabled, 2 dismiss on click, 4 no background, 8 hidden, 0x10 non-interactive. */
  flags: number;
}

/** What an app set for its window's thumbnail: toolbar, image list, tooltip, clip (client coordinates). */
export interface ThumbBar {
  buttons: ThumbButton[];
  images: string[];
  /** The image list's image width in pixels. */
  imageSize: number;
  tooltip: string;
  clip: { left: number; top: number; right: number; bottom: number } | null;
}

/** Thumbnail toolbars, tooltips and clips by window handle. */
export const thumbBars = store<Record<string, ThumbBar>>({});

/** The picture a thumbnail button shows: its own icon, else its image list entry. */
export function thumbButtonImage(bar: ThumbBar, button: ThumbButton): { src: string; size: number } | null {
  if (button.icon) return { src: button.icon, size: button.iconSize };
  const src = bar.images[button.bitmap];
  return src ? { src, size: bar.imageSize } : null;
}

const cacheDir = join(configDir, "tray");
mkdirSync(cacheDir, { recursive: true });

const written = new Set<string>();

function iconFile(px: { width: number; height: number; rgba: Uint8Array } | undefined): string {
  if (!px) return "";
  const name = `${hash(px.rgba).toString(16)}-${px.width}.png`;
  const path = join(cacheDir, name);
  if (!written.has(name)) {
    writeFileSync(path, encodePng(px.width, px.height, px.rgba));
    written.add(name);
  }
  return path;
}

// ---------- Promoted icons (registry) ----------

const advapi32 = dlopen("advapi32.dll", {
  RegOpenKeyExW: { args: ["u64", "ptr", "u32", "u32", "ptr"], returns: "i32" },
  RegEnumKeyExW: { args: ["ptr", "u32", "ptr", "ptr", "ptr", "ptr", "ptr", "ptr"], returns: "i32" },
  RegGetValueW: { args: ["ptr", "ptr", "ptr", "u32", "ptr", "ptr", "ptr"], returns: "i32" },
  RegSetValueExW: { args: ["ptr", "ptr", "u32", "u32", "ptr", "u32"], returns: "i32" },
  RegCloseKey: { args: ["ptr"], returns: "i32" },
});
const A = advapi32.symbols;
const wide = (s: string) => encodeWide(s);
const HKCU = 0x80000001n as unknown as number;
const NOTIFY_ICON_SETTINGS = "Control Panel\\NotifyIconSettings";

/**
 * One subkey of HKCU\Control Panel\NotifyIconSettings: Explorer's record of one tray icon, named
 * by IconGuid when the icon has a GUID, else by ExecutablePath + UID. IsPromoted 1 = on the taskbar
 * ("Mostrar na barra de tarefas" in Settings, or dragged out of the hidden-icons flyout).
 */
interface IconSetting {
  sub: string;
  /** Lower-case, no braces (as NotifyIconMessage.guid), or "". */
  guid: string;
  /** Full lower-cased path, known-folder prefix resolved. */
  exe: string;
  uid: number;
  promoted: boolean;
}

let settings: IconSetting[] = [];

function readPromoted() {
  const next: IconSetting[] = [];
  const key = new BigUint64Array(1);
  if (A.RegOpenKeyExW(HKCU, wide(NOTIFY_ICON_SETTINGS), 0, 0x20019 /* KEY_READ */, new Uint8Array(key.buffer)) !== 0) return;
  const root = Number(key[0]) as unknown as Pointer;
  const name = new Uint16Array(256);
  const len = new Uint32Array(1);
  const text = new Uint16Array(1024);
  const dword = new Uint32Array(1);
  const size = new Uint32Array(1);
  const readDword = (sub: string, value: string) => {
    size[0] = 4;
    dword[0] = 0;
    return A.RegGetValueW(root, wide(sub), wide(value), 0x10 /* RRF_RT_DWORD */, null, new Uint8Array(dword.buffer), new Uint8Array(size.buffer)) === 0 ? dword[0]! : 0;
  };
  const readText = (sub: string, value: string) => {
    size[0] = text.byteLength;
    if (A.RegGetValueW(root, wide(sub), wide(value), 0x2 /* RRF_RT_REG_SZ */, null, new Uint8Array(text.buffer), new Uint8Array(size.buffer)) !== 0) return "";
    return decodeWide(text.buffer, 0, Math.max(0, size[0]! - 2)).replace(/\0.*$/s, "");
  };
  try {
    for (let i = 0; ; i++) {
      len[0] = name.length;
      if (A.RegEnumKeyExW(root, i, new Uint8Array(name.buffer), new Uint8Array(len.buffer), null, null, null, null) !== 0) break;
      const sub = decodeWide(name.buffer, 0, len[0]! * 2);
      let path = readText(sub, "ExecutablePath");
      // Paths are stored like the shell's default AppUserModelIDs: a known-folder GUID prefix.
      const folder = /^\{[0-9A-F-]+\}/i.exec(path)?.[0];
      if (folder) {
        const base = knownFolderPath(folder);
        if (base) path = base + path.slice(folder.length);
      }
      next.push({
        sub,
        guid: readText(sub, "IconGuid").replace(/[{}]/g, "").toLowerCase(),
        exe: path.toLowerCase(),
        uid: readDword(sub, "UID"),
        promoted: readDword(sub, "IsPromoted") === 1,
      });
    }
  } finally {
    A.RegCloseKey(root);
  }
  settings = next;
}

/** Explorer's record for an icon: by IconGuid when it has one, else by ExecutablePath + UID. */
function settingOf(icon: { guid: string; exe: string; uid: number }): IconSetting | undefined {
  const guid = icon.guid.replace(/[{}]/g, "").toLowerCase();
  if (guid) {
    const hit = settings.find((s) => s.guid === guid);
    if (hit) return hit;
  }
  if (!icon.exe) return undefined;
  const exe = icon.exe.toLowerCase();
  return settings.find((s) => !s.guid && s.exe === exe && s.uid === icon.uid);
}

const isPromoted = (icon: { guid: string; exe: string; uid: number }) => !!settingOf(icon)?.promoted;

/**
 * Moves an icon between the taskbar and the hidden-icons flyout the way Windows 11 does: IsPromoted
 * in the icon's NotifyIconSettings subkey. The registry stays the source of truth: the key's change
 * notification (applyPromoted) moves the icon. Explorer creates the subkey when it first sees the
 * icon; one it has no record of cannot be moved (returns false).
 */
export function setTrayIconPromoted(icon: TrayIcon, promote: boolean): boolean {
  const setting = settingOf(icon);
  if (!setting) {
    console.warn("[tray] no NotifyIconSettings entry for", icon.guid || `${icon.exe}#${icon.uid}`);
    return false;
  }
  if (setting.promoted === promote) return true;
  const key = new BigUint64Array(1);
  if (A.RegOpenKeyExW(HKCU, wide(`${NOTIFY_ICON_SETTINGS}\\${setting.sub}`), 0, 0x2 /* KEY_SET_VALUE */, new Uint8Array(key.buffer)) !== 0) return false;
  const handle = Number(key[0]) as unknown as Pointer;
  try {
    const value = new Uint32Array([promote ? 1 : 0]);
    return A.RegSetValueExW(handle, wide("IsPromoted"), 0, 4 /* REG_DWORD */, new Uint8Array(value.buffer), 4) === 0;
  } finally {
    A.RegCloseKey(handle);
  }
}

// ---------- Messages from the host ----------

const NIF_ICON = 0x2;
const NIF_TIP = 0x4;
const NIF_STATE = 0x8;
const NIF_GUID = 0x20;
const NIS_HIDDEN = 0x1;

/**
 * Explorer's own volume (7820AE73), network (7820AE74) and power (7820AE75) icons. Its legacy
 * systray still registers them, but Windows 11 shows that state on the Quick Settings button,
 * never in the tray or its overflow; the dock's system button does the same.
 */
const QUICK_SETTINGS_ICONS = new Set(["73", "74", "75"].map((n) => `7820ae${n}-23e3-4229-82c1-e41cb67d5b9c`));
const quickSettingsIds = new Set<string>();

function onNotifyIcon(m: NotifyIconMessage) {
  // Later calls may name the icon by hwnd and uid alone: remember the pair.
  if (m.guid && QUICK_SETTINGS_ICONS.has(m.guid.toLowerCase())) quickSettingsIds.add(`${m.hwnd}:${m.uid}`);
  if (quickSettingsIds.has(`${m.hwnd}:${m.uid}`)) return;
  const key = m.flags & NIF_GUID && m.guid ? m.guid : `${m.hwnd}:${m.uid}`;
  const icons = tray.icons;
  const index = icons.findIndex((i) => i.key === key || (m.guid && i.guid === m.guid) || (i.hwnd === m.hwnd && i.uid === m.uid));
  if (m.message === 2 /* NIM_DELETE */) {
    if (index >= 0) tray.icons = icons.filter((_, i) => i !== index);
    return;
  }
  if (m.message !== 0 && m.message !== 1 && m.message !== 4) return;
  const prev = index >= 0 ? icons[index]! : undefined;
  if (!prev && m.message === 4) return;
  const exe = prev?.exe || exePathOf(windowPidOf(m.hwnd));
  const guid = m.guid || prev?.guid || "";
  const next: TrayIcon = {
    key,
    hwnd: m.hwnd || prev?.hwnd || 0,
    uid: m.uid,
    guid,
    callback: m.flags & 0x1 ? m.callback : (prev?.callback ?? 0),
    version: m.message === 4 ? m.version : (prev?.version ?? 0),
    tip: m.flags & NIF_TIP ? m.tip : (prev?.tip ?? ""),
    image: m.flags & NIF_ICON ? iconFile(m.icon) || prev?.image || "" : (prev?.image ?? ""),
    hidden: m.flags & NIF_STATE && m.stateMask & NIS_HIDDEN ? !!(m.state & NIS_HIDDEN) : (prev?.hidden ?? false),
    exe,
    promoted: isPromoted({ guid, exe, uid: m.uid }),
    // A behaviour flag, not a "member valid" bit: the add says it, and a modify that sets the tip
    // says it again (apps pass their whole uFlags); other modifies keep what the icon had.
    showTip: m.message === 0 || m.flags & NIF_TIP ? !!(m.flags & NIF_SHOWTIP) : (prev?.showTip ?? false),
  };
  if (prev && JSON.stringify(prev) === JSON.stringify(next)) return;
  tray.icons = prev ? icons.map((i, n) => (n === index ? next : i)) : [...icons, next];
}

// ITaskbarList3::SetOverlayIcon reaches the task band as WM_USER + 0x4f (seen on Windows 11):
// wParam the window, lParam the HICON, 0 to clear. The icon is the badge as the app drew it.
const TBL_SET_OVERLAY_ICON = 0x44f;
// SetProgressValue: WM_USER + 0x40, lParam the value scaled to 0..65535.
// SetProgressState: WM_USER + 0x41, lParam the TBPF_* flags (0 clears).
const TBL_SET_PROGRESS_VALUE = 0x440;
const TBL_SET_PROGRESS_STATE = 0x441;

function onProgress(hwnd: number, msg: number, lParam: number) {
  const id = String(hwnd);
  const prev = progress[id];
  if (msg === TBL_SET_PROGRESS_STATE) {
    if (!lParam) return void delete progress[id];
    if (prev?.state === lParam) return;
    progress[id] = { key: prev?.key ?? exePathOf(windowPidOf(hwnd)).toLowerCase(), state: lParam, value: prev?.value ?? 0 };
    return;
  }
  const value = Math.min(1, Math.max(0, lParam / 0xffff));
  if (prev && Math.abs(prev.value - value) < 0.005) return;
  // A value with no progress shown switches the button to normal progress, as Explorer does.
  const state = !prev || prev.state === 1 ? 2 : prev.state;
  progress[id] = { key: prev?.key ?? exePathOf(windowPidOf(hwnd)).toLowerCase(), state, value };
}

function onThumbBar(hwnd: number, call: ThumbBarCall) {
  const id = String(hwnd);
  const prev: ThumbBar = thumbBars[id] ?? { buttons: [], images: [], imageSize: 0, tooltip: "", clip: null };
  const next: ThumbBar = { ...prev };
  if (call.kind === "images") {
    next.images = call.images.map((px) => iconFile(px ?? undefined));
    next.imageSize = call.images.find((px) => px)?.width ?? 0;
  }
  else if (call.kind === "tooltip") next.tooltip = call.text ?? "";
  else if (call.kind === "clip") next.clip = call.rect;
  else if (call.kind === "add") {
    // Explorer takes the toolbar once per window; a second add replaces it here.
    next.buttons = call.buttons.map((b) => ({ id: b.id, icon: b.mask & 0x2 ? iconFile(b.icon ?? undefined) : "", iconSize: b.icon?.width ?? 0, bitmap: b.mask & 0x1 ? b.bitmap : 0, tip: b.mask & 0x4 ? b.tip : "", flags: b.mask & 0x8 ? b.flags : 0 }));
  } else {
    next.buttons = prev.buttons.map((old) => {
      const b = call.buttons.find((u) => u.id === old.id);
      if (!b) return old;
      return {
        id: old.id,
        icon: b.mask & 0x2 ? iconFile(b.icon ?? undefined) : old.icon,
        iconSize: b.mask & 0x2 ? (b.icon?.width ?? 0) : old.iconSize,
        bitmap: b.mask & 0x1 ? b.bitmap : old.bitmap,
        tip: b.mask & 0x4 ? b.tip : old.tip,
        flags: b.mask & 0x8 ? b.flags : old.flags,
      };
    });
  }
  if (JSON.stringify(prev) === JSON.stringify(next) && thumbBars[id]) return;
  thumbBars[id] = next;
}

function onTaskband(m: TaskbandMessage) {
  const hwnd = Number(m.wParam);
  if (m.thumbBar) return onThumbBar(hwnd, m.thumbBar);
  if (m.msg === TBL_SET_PROGRESS_VALUE || m.msg === TBL_SET_PROGRESS_STATE) return onProgress(hwnd, m.msg, m.lParam);
  if (m.msg !== TBL_SET_OVERLAY_ICON) return;
  const id = String(hwnd);
  if (!m.lParam) {
    delete overlays[id];
    return;
  }
  const image = iconFile(m.icon);
  if (!image) return;
  overlays[id] = { key: exePathOf(windowPidOf(hwnd)).toLowerCase(), image };
}

// ---------- Lifetime ----------

let users = 0;
let offEvents: (() => void)[] = [];
let pruneTimer: ReturnType<typeof setTimeout> | undefined;

/** Drops icons, badges and progress whose window is gone (an app that quit without NIM_DELETE). */
function prune() {
  const alive = tray.icons.filter((i) => windowAlive(i.hwnd));
  if (alive.length !== tray.icons.length) tray.icons = alive;
  for (const id of Object.keys(overlays)) if (!windowAlive(Number(id))) delete overlays[id];
  for (const id of Object.keys(progress)) if (!windowAlive(Number(id))) delete progress[id];
  for (const id of Object.keys(thumbBars)) if (!windowAlive(Number(id))) delete thumbBars[id];
}

/** "Mostrar na barra de tarefas" changed in Settings: the registry key's change notification. */
function applyPromoted() {
  readPromoted();
  const icons = tray.icons.map((i) => (i.promoted === isPromoted(i) ? i : { ...i, promoted: !i.promoted }));
  if (icons.some((i, n) => i !== tray.icons[n])) tray.icons = icons;
}

/** The windows behind icons, badges and progress: shell-events reports their destruction (watchDestroyed). */
function syncWatched() {
  watchDestroyed([...tray.icons.map((i) => i.hwnd), ...Object.keys(overlays).map(Number), ...Object.keys(progress).map(Number), ...Object.keys(thumbBars).map(Number)]);
}

/** A watched window was destroyed: drop what it owned, hidden tray windows included. */
function dropWindow(hwnd: number) {
  const icons = tray.icons.filter((i) => i.hwnd !== hwnd);
  if (icons.length !== tray.icons.length) tray.icons = icons;
  delete overlays[String(hwnd)];
  delete progress[String(hwnd)];
  delete thumbBars[String(hwnd)];
}

function start() {
  readPromoted();
  startTrayHost({
    onNotifyIcon: (m) => {
      onNotifyIcon(m);
      syncWatched();
    },
    onTaskband: (m) => {
      onTaskband(m);
      syncWatched();
    },
  });
  // Apps (re)apply overlay badges when told their taskbar button exists.
  setTimeout(() => broadcastTaskbarButtonCreated(listTaskbarWindows().map((w) => w.hwnd)), 500);
  // Settings come from their registry key's change notification. Dead icons are dropped when their
  // window is destroyed: an out-of-context EVENT_OBJECT_DESTROY hook (shell-events.ts) on the threads
  // of the windows that own an icon, badge or progress, so hidden windows count too
  // (an app that quits after closing to the tray, or without NIM_DELETE) and nothing is polled.
  // After an Explorer restart every icon is checked once.
  offEvents = [
    () => watchDestroyed([]),
    onWatchChange(["notifyIcons"], applyPromoted),
    onShellEvent((event) => {
      if (event.type === "destroyed") return dropWindow(event.hwnd);
      if (event.type !== "explorerRestarted") return;
      clearTimeout(pruneTimer);
      pruneTimer = setTimeout(() => {
        prune();
        syncWatched();
      }, 150);
    }),
  ];
}

/** Starts hosting the tray and task band; returns the release function. */
export function acquireTaskbarHost(): () => void {
  if (users++ === 0) start();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--users === 0) {
      for (const off of offEvents) off();
      offEvents = [];
      clearTimeout(pruneTimer);
      endTrayPopup();
      stopTrayHost();
      tray.icons = [];
      for (const id of Object.keys(overlays)) delete overlays[id];
              for (const id of Object.keys(progress)) delete progress[id];
        for (const id of Object.keys(thumbBars)) delete thumbBars[id];
    }
  };
}

/** Plays a click on a tray icon to the app that owns it, anchored at the pointer. */
export function clickTrayIcon(icon: TrayIcon, button: "left" | "right" | "double") {
  // A press puts the app's hover popup away first, as the pointer leaving would.
  endTrayPopup();
  clickIcon(icon, button, cursorPos());
}

/** Whether an icon's owner draws its own hover popup (v4 without NIF_SHOWTIP) instead of the standard tooltip. */
export const ownsPopup = (icon: TrayIcon) => icon.version >= 4 && !icon.showTip && !!icon.callback;

/** The icon whose app was told NIN_POPUPOPEN, and the pending one (hover not yet stable). */
let popupShown: TrayIcon | null = null;
let popupTimer: ReturnType<typeof setTimeout> | undefined;
let popupPending = "";
/** The icon under the pointer, and the short grace before a leave counts. */
let popupHover = "";
let popupLeave: ReturnType<typeof setTimeout> | undefined;

/**
 * The pointer entered or left a tray icon (on the bar or in the flyout). For an icon that draws its
 * own popup, Explorer waits for the system hover time (SPI_GETMOUSEHOVERTIME) and sends
 * NIN_POPUPOPEN, then NIN_POPUPCLOSE when the pointer leaves; the same here. Other icons: nothing
 * (their standard tooltip is the HoverTip's job).
 */
export function hoverTrayIcon(icon: TrayIcon, hovered: boolean) {
  if (!ownsPopup(icon)) return;
  if (!hovered) {
    if (popupHover !== icon.key) return;
    popupHover = "";
    // The icon and its HitReach both report hover: moving between them is not leaving the icon.
    clearTimeout(popupLeave);
    popupLeave = setTimeout(() => {
      if (popupHover === icon.key) return;
      if (popupPending === icon.key) {
        clearTimeout(popupTimer);
        popupPending = "";
      }
      if (popupShown?.key === icon.key) endTrayPopup();
    }, 50);
    return;
  }
  popupHover = icon.key;
  clearTimeout(popupLeave);
  if (popupShown?.key === icon.key || popupPending === icon.key) return;
  endTrayPopup();
  popupPending = icon.key;
  popupTimer = setTimeout(() => {
    popupPending = "";
    popupShown = icon;
    popupIcon(icon, true, cursorPos());
  }, mouseHoverTime());
}

/** Closes the open hover popup (pointer gone, click, drag), if any. */
export function endTrayPopup() {
  clearTimeout(popupTimer);
  popupPending = "";
  const shown = popupShown;
  popupShown = null;
  if (shown) popupIcon(shown, false, cursorPos());
}

/** Re-asks every app for its icons (after Explorer restarts, or to recover a lost one). */
export function refreshTray() {
  broadcastTaskbarCreated();
}
