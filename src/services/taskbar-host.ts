import { store } from "@tarve/core";
import { dlopen, type Pointer } from "../native/ffi";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { configDir } from "../config";
import { cursorPos, exePathOf, listTaskbarWindows } from "../native/win32";
import {
  broadcastTaskbarButtonCreated,
  broadcastTaskbarCreated,
  clickIcon,
  encodePng,
  iconPixels,
  startTrayHost,
  stopTrayHost,
  windowAlive,
  windowPidOf,
  type NotifyIconMessage,
  type TaskbandMessage,
} from "../native/tray-host";
import { hash } from "../runtime/proc";
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
}

export interface OverlayBadge {
  /** Lower-cased exe path of the window that set it: the key app icons use. */
  key: string;
  image: string;
}

export const tray = store({ icons: [] as TrayIcon[] });
/** Overlay badges by window handle. */
export const overlays = store<Record<string, OverlayBadge>>({});

const cacheDir = join(configDir, "tray");
mkdirSync(cacheDir, { recursive: true });

const written = new Set<string>();

function iconFile(hicon: number): string {
  const px = iconPixels(hicon);
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
  RegCloseKey: { args: ["ptr"], returns: "i32" },
});
const A = advapi32.symbols;
const wide = (s: string) => encodeWide(s);
const knownFolders: Record<string, string | undefined> = {
  "{6D809377-6AF0-444B-8957-A3773F02200E}": process.env.ProgramFiles,
  "{7C5A40EF-A0FB-4BFC-874A-C0F2E0B9FA8E}": process.env["ProgramFiles(x86)"],
  "{F38BF404-1D43-42F2-9305-67DE0B28FC23}": process.env.windir,
  "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}": process.env.windir && join(process.env.windir, "System32"),
  "{F1B32785-6FBA-4FCF-9D55-7B8E7F157091}": process.env.LOCALAPPDATA,
  "{3EB685DB-65F9-4CF6-A03A-E3EF65729F3D}": process.env.APPDATA,
};

/** Promoted exes: full lower-cased paths, and bare file names as a fallback. */
let promoted = new Set<string>();

function readPromoted() {
  const next = new Set<string>();
  const key = new BigUint64Array(1);
  if (A.RegOpenKeyExW(0x80000001n /* HKCU */ as unknown as number, wide("Control Panel\\NotifyIconSettings"), 0, 0x20019, new Uint8Array(key.buffer)) !== 0)
    return;
  const root = Number(key[0]) as unknown as Pointer;
  const name = new Uint16Array(256);
  const len = new Uint32Array(1);
  const pathBuf = new Uint16Array(1024);
  const dword = new Uint32Array(1);
  const size = new Uint32Array(1);
  try {
    for (let i = 0; ; i++) {
      len[0] = name.length;
      if (A.RegEnumKeyExW(root, i, new Uint8Array(name.buffer), new Uint8Array(len.buffer), null, null, null, null) !== 0) break;
      const sub = decodeWide(name.buffer, 0, len[0]! * 2);
      size[0] = 4;
      dword[0] = 0;
      A.RegGetValueW(root, wide(sub), wide("IsPromoted"), 0x10 /* RRF_RT_DWORD */, null, new Uint8Array(dword.buffer), new Uint8Array(size.buffer));
      if (!dword[0]) continue;
      size[0] = pathBuf.byteLength;
      if (A.RegGetValueW(root, wide(sub), wide("ExecutablePath"), 0x2 /* RRF_RT_REG_SZ */, null, new Uint8Array(pathBuf.buffer), new Uint8Array(size.buffer)) !== 0) continue;
      let path = decodeWide(pathBuf.buffer, 0, Math.max(0, size[0]! - 2));
      const folder = /^\{[0-9A-F-]+\}/i.exec(path)?.[0];
      if (folder && knownFolders[folder.toUpperCase()]) path = knownFolders[folder.toUpperCase()] + path.slice(folder.length);
      next.add(path.toLowerCase());
      next.add(basename(path).toLowerCase());
    }
  } finally {
    A.RegCloseKey(root);
  }
  promoted = next;
}

const isPromoted = (exe: string) => !!exe && (promoted.has(exe.toLowerCase()) || promoted.has(basename(exe).toLowerCase()));

// ---------- Messages from the host ----------

const NIF_ICON = 0x2;
const NIF_TIP = 0x4;
const NIF_STATE = 0x8;
const NIF_GUID = 0x20;
const NIS_HIDDEN = 0x1;

function onNotifyIcon(m: NotifyIconMessage) {
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
  const next: TrayIcon = {
    key,
    hwnd: m.hwnd || prev?.hwnd || 0,
    uid: m.uid,
    guid: m.guid || prev?.guid || "",
    callback: m.flags & 0x1 ? m.callback : (prev?.callback ?? 0),
    version: m.message === 4 ? m.version : (prev?.version ?? 0),
    tip: m.flags & NIF_TIP ? m.tip : (prev?.tip ?? ""),
    image: m.flags & NIF_ICON ? iconFile(m.hicon) || prev?.image || "" : (prev?.image ?? ""),
    hidden: m.flags & NIF_STATE && m.stateMask & NIS_HIDDEN ? !!(m.state & NIS_HIDDEN) : (prev?.hidden ?? false),
    exe,
    promoted: isPromoted(exe),
  };
  if (prev && JSON.stringify(prev) === JSON.stringify(next)) return;
  tray.icons = prev ? icons.map((i, n) => (n === index ? next : i)) : [...icons, next];
}

// ITaskbarList3::SetOverlayIcon reaches the task band as WM_USER + 0x4f (seen on Windows 11):
// wParam the window, lParam the HICON, 0 to clear. The icon is the badge as the app drew it.
const TBL_SET_OVERLAY_ICON = 0x44f;

function onTaskband(m: TaskbandMessage) {
  if (m.msg !== TBL_SET_OVERLAY_ICON) return;
  const hwnd = Number(m.wParam);
  const id = String(hwnd);
  if (!m.lParam) {
    delete overlays[id];
    return;
  }
  const image = iconFile(m.lParam);
  if (!image) return;
  overlays[id] = { key: exePathOf(windowPidOf(hwnd)).toLowerCase(), image };
}

// ---------- Lifetime ----------

let users = 0;
let sweep: ReturnType<typeof setInterval> | undefined;

function start() {
  readPromoted();
  startTrayHost({ onNotifyIcon, onTaskband });
  // Apps (re)apply overlay badges when told their taskbar button exists.
  setTimeout(() => broadcastTaskbarButtonCreated(listTaskbarWindows().map((w) => w.hwnd)), 500);
  sweep = setInterval(() => {
    readPromoted();
    const alive = tray.icons.filter((i) => windowAlive(i.hwnd));
    const icons = alive.map((i) => (i.promoted === isPromoted(i.exe) ? i : { ...i, promoted: !i.promoted }));
    if (icons.length !== tray.icons.length || icons.some((i, n) => i !== tray.icons[n])) tray.icons = icons;
    for (const id of Object.keys(overlays)) if (!windowAlive(Number(id))) delete overlays[id];
  }, 5000);
}

/** Starts hosting the tray and task band; returns the release function. */
export function acquireTaskbarHost(): () => void {
  if (users++ === 0) start();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--users === 0) {
      clearInterval(sweep);
      stopTrayHost();
      tray.icons = [];
      for (const id of Object.keys(overlays)) delete overlays[id];
    }
  };
}

/** Plays a click on a tray icon to the app that owns it, anchored at the pointer. */
export function clickTrayIcon(icon: TrayIcon, button: "left" | "right" | "double") {
  clickIcon(icon, button, cursorPos());
}

/** Re-asks every app for its icons (after Explorer restarts, or to recover a lost one). */
export function refreshTray() {
  broadcastTaskbarCreated();
}
