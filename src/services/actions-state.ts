import { store } from "@tarve/core";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
  emptyRecycleBin,
  nextWallpaper,
  picturesFolder,
  readBrightness,
  readTheme,
  readWallpaper,
  recycleBinInfo,
  setBrightness,
  setLightTheme,
  setWallpaper,
  toggleTouchKeyboard,
  type BrightnessSource,
} from "../native/actions-native";
import { openUri } from "../native/desktop";
import { setEndpointMuted, watchEndpoint, type EndpointState } from "../native/status";
import { onShellEvent, SPI_SETDESKWALLPAPER } from "../native/shell-events";
import { createPoller } from "./poller";

/** Shared state of the "actions" widgets, polled only while one of them is placed. */
export const actions = store({
  hasMic: false,
  micMuted: false,
  micLevel: 0,
  micDevice: "",
  /** null until read; "none" when neither the panel IOCTL nor DDC/CI answers. */
  brightnessSource: null as BrightnessSource | "none" | null,
  brightness: 0,
  lightTheme: false,
  recycleItems: 0,
  recycleBytes: 0,
  wallpaper: "",
  slideshow: false,
});

function assign(next: Partial<typeof actions>) {
  for (const [key, value] of Object.entries(next)) {
    if ((actions as Record<string, unknown>)[key] !== value) (actions as Record<string, unknown>)[key] = value;
  }
}

// ---------- Microphone ----------

function applyMic(mic: EndpointState | null) {
  assign({ hasMic: !!mic, micMuted: mic?.muted ?? false, micLevel: mic?.level ?? 0, micDevice: mic?.device ?? "" });
}

/** The default microphone's mute, volume and device, from Core Audio's notifications (native/status.ts watchEndpoint). */
export const micPoller = {
  acquire: (): (() => void) => watchEndpoint(1, applyMic),
};

export function toggleMicMute() {
  if (setEndpointMuted(1, !actions.micMuted)) assign({ micMuted: !actions.micMuted });
}

// ---------- Brightness ----------

/**
 * The built-in panel's brightness follows GUID_VIDEO_CURRENT_MONITOR_BRIGHTNESS (RegisterPowerSettingNotification
 * in shell-events.ts), the setting the quick settings slider follows: every change, keys and auto-brightness
 * included. An external monitor over DDC/CI has no change notification (its own buttons change it inside
 * the monitor), and DDC answers in tens of milliseconds over I2C: it is read again once a minute, the shown
 * value follows our own sets.
 */
const ddcPoller = createPoller(60_000, () => {
  const b = readBrightness();
  assign({ brightnessSource: b?.source ?? "none", brightness: b?.level ?? 0 });
});

export const brightnessPoller = {
  acquire(): () => void {
    const b = readBrightness();
    assign({ brightnessSource: b?.source ?? "none", brightness: b?.level ?? 0 });
    let releaseDdc = b?.source === "ddc" ? ddcPoller.acquire() : null;
    const off = onShellEvent((event) => {
      if (event.type !== "brightness") return;
      if (actions.brightnessSource === "panel") assign({ brightness: event.level });
      else if (actions.brightnessSource !== "ddc") {
        // A panel that answered nothing before (driver loaded late): read it now.
        const next = readBrightness();
        assign({ brightnessSource: next?.source ?? "none", brightness: next?.level ?? 0 });
        if (next?.source === "ddc") releaseDdc ??= ddcPoller.acquire();
      }
    });
    return () => {
      off();
      releaseDdc?.();
      releaseDdc = null;
    };
  },
};

export function changeBrightness(level: number) {
  const source = actions.brightnessSource;
  if (source !== "panel" && source !== "ddc") return;
  const next = Math.round(Math.max(0, Math.min(100, level)));
  if (setBrightness(source, next)) assign({ brightness: next });
}

// ---------- Theme ----------

/** Light/dark follows WM_SETTINGCHANGE "ImmersiveColorSet", the broadcast Windows sends when it flips. */
export const themePoller = {
  acquire(): () => void {
    const read = () => assign({ lightTheme: readTheme().appsLight });
    read();
    return onShellEvent((event) => {
      if (event.type === "setting" && event.area === "ImmersiveColorSet") read();
    });
  },
};

export function toggleTheme() {
  const light = !actions.lightTheme;
  assign({ lightTheme: light });
  // After this frame: the broadcast waits on every top-level window (200 ms each at most).
  setTimeout(() => setLightTheme(light), 0);
}

// ---------- Touch keyboard ----------

const tabTip = () =>
  join(process.env.CommonProgramW6432 ?? process.env.CommonProgramFiles ?? "C:\\Program Files\\Common Files", "microsoft shared", "ink", "TabTip.exe");

/** The taskbar's touch keyboard button; starts TabTip.exe first when its server is not running. */
export function toggleKeyboard() {
  if (toggleTouchKeyboard()) return;
  if (!openUri(tabTip())) return;
  // TabTip registers its COM server a moment after it starts.
  let tries = 0;
  const retry = () => {
    if (toggleTouchKeyboard() || ++tries >= 6) return;
    setTimeout(retry, 250);
  };
  setTimeout(retry, 300);
}

// ---------- Recycle Bin ----------

function readRecycleBin() {
  const info = recycleBinInfo();
  assign({ recycleItems: info?.items ?? 0, recycleBytes: info?.bytes ?? 0 });
}

/**
 * The Recycle Bin is read when the shell reports a change in it (SHChangeNotifyRegister on each drive's
 * $Recycle.Bin and on CSIDL_BITBUCKET, see shell-events.ts) or a drive comes or goes, as Explorer's
 * Recycle Bin icon follows it. SHQueryRecycleBinW walks every item (66 ms with ~1000 items, on the JS
 * thread), so a burst (recycling a folder of files) is read once, after it settles.
 */
export const recyclePoller = {
  acquire(): () => void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    readRecycleBin();
    const off = onShellEvent((event) => {
      if (event.type !== "recycleBin" && event.type !== "freeSpace") return;
      clearTimeout(timer);
      timer = setTimeout(readRecycleBin, 300);
    });
    return () => {
      clearTimeout(timer);
      off();
    };
  },
};

export function emptyRecycle() {
  // After the menu closes: the confirmation dialog is modal.
  setTimeout(() => {
    emptyRecycleBin();
    const info = recycleBinInfo();
    assign({ recycleItems: info?.items ?? 0, recycleBytes: info?.bytes ?? 0 });
  }, 50);
}

export function formatBytes(bytes: number) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1).replace(".", ",")} ${units[unit]}`;
}

// ---------- Wallpaper ----------

/** The wallpaper follows WM_SETTINGCHANGE SPI_SETDESKWALLPAPER, sent on every change (slideshows too). */
export const wallpaperPoller = {
  acquire(): () => void {
    const read = () => {
      const w = readWallpaper();
      assign({ wallpaper: w?.path ?? "", slideshow: w?.slideshow ?? false });
    };
    read();
    return onShellEvent((event) => {
      if (event.type === "setting" && event.action === SPI_SETDESKWALLPAPER) read();
    });
  },
};

export function applyWallpaper(path: string) {
  if (setWallpaper(path)) assign({ wallpaper: path, slideshow: false });
}

export function advanceWallpaper() {
  if (!nextWallpaper()) return;
  setTimeout(() => {
    const w = readWallpaper();
    if (w) assign({ wallpaper: w.path, slideshow: w.slideshow });
  }, 1500);
}

const IMAGE = /\.(jpe?g|png|bmp)$/i;

function images(dir: string, depth: number, limit: number): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const name of entries) {
    if (found.length >= limit) break;
    const path = join(dir, name);
    if (IMAGE.test(name)) found.push(path);
    else if (depth > 0 && !name.includes(".")) found.push(...images(path, depth - 1, limit - found.length));
  }
  return found;
}

let gallery = { system: [] as string[], user: [] as string[], at: 0 };

/** Windows' own wallpapers (%WINDIR%\Web\Wallpaper\<tema>) and the pictures at the top of Pictures. */
export function wallpaperChoices() {
  if (Date.now() - gallery.at > 60_000) {
    const windir = process.env.WINDIR ?? process.env.SystemRoot ?? "C:\\Windows";
    const pictures = picturesFolder();
    gallery = {
      system: images(join(windir, "Web", "Wallpaper"), 1, 16),
      user: pictures ? images(pictures, 0, 12) : [],
      at: Date.now(),
    };
  }
  return gallery;
}
