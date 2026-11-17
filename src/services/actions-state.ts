import { store } from "@tarve/core";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
  emptyRecycleBin,
  nextWallpaper,
  picturesFolder,
  readBrightness,
  readMicrophone,
  readTheme,
  readWallpaper,
  recycleBinInfo,
  setBrightness,
  setLightTheme,
  setMicrophoneMuted,
  setWallpaper,
  toggleTouchKeyboard,
  type BrightnessSource,
} from "../native/actions-native";
import { openUri } from "../native/desktop";
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

export const micPoller = createPoller(1000, () => {
  const mic = readMicrophone();
  assign({ hasMic: !!mic, micMuted: mic?.muted ?? false, micLevel: mic?.level ?? 0, micDevice: mic?.device ?? "" });
});

export function toggleMicMute() {
  if (setMicrophoneMuted(!actions.micMuted)) assign({ micMuted: !actions.micMuted });
}

// ---------- Brightness ----------

/** DDC/CI answers in tens of milliseconds over I2C: read once a minute, the shown value follows our own sets. */
export const brightnessPoller = createPoller(60_000, () => {
  const b = readBrightness();
  assign({ brightnessSource: b?.source ?? "none", brightness: b?.level ?? 0 });
});

export function changeBrightness(level: number) {
  const source = actions.brightnessSource;
  if (source !== "panel" && source !== "ddc") return;
  const next = Math.round(Math.max(0, Math.min(100, level)));
  if (setBrightness(source, next)) assign({ brightness: next });
}

// ---------- Theme ----------

export const themePoller = createPoller(2000, () => assign({ lightTheme: readTheme().appsLight }));

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

export const recyclePoller = createPoller(4000, () => {
  const info = recycleBinInfo();
  assign({ recycleItems: info?.items ?? 0, recycleBytes: info?.bytes ?? 0 });
});

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

export const wallpaperPoller = createPoller(10_000, () => {
  const w = readWallpaper();
  assign({ wallpaper: w?.path ?? "", slideshow: w?.slideshow ?? false });
});

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
