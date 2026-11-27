import { store } from "@tarve/core";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "../config";
import { idleMs } from "../native/launcher-idle";
import { desktop, windowsPoller } from "./windows";
import { onExit } from "./exit";
import { awaitInput, onShellEvent } from "../native/shell-events";

import { t as tr } from "../i18n";
/**
 * Screen time: which app is in front while the user is at the computer. Time is credited to the
 * app in front when the foreground changes (shell events), and by one timer set for the moment the
 * user would count as away (last input from GetLastInputInfo + 5 min): when it fires with input since,
 * the time so far is credited and it is set again; with none, the user is away and nothing counts
 * until the next input (cursor/caret WinEvent), foreground change, unlock or display on.
 * The app is the one the dock's app list marks active (desktop.activeKey), so it carries the same
 * identity the taskbar groups by (AppUserModelID, package or exe). Away (no input for 5 min, the
 * session locked or the display off) counts nothing. Daily totals live in screen-time.json next to
 * the dock's config.
 */

const IDLE_MS = 5 * 60_000;
/** A gap longer than this between two samples (sleep, a stalled loop) is not counted. */
const MAX_STEP_S = IDLE_MS / 1000 + 90;
const KEEP_DAYS = 14;
const filePath = join(configDir, "screen-time.json");

export interface AppUsage {
  name: string;
  /** What the app's icon is read from and what starts it (as RunningApp.exe). */
  exe: string;
  seconds: number;
}

export interface DayUsage {
  total: number;
  /** Seconds per hour of the day, 24 entries. */
  hours: number[];
  apps: Record<string, AppUsage>;
  /** [start, end, key] in seconds since midnight: what was in front when. */
  spans: [number, number, string][];
}

type Days = Record<string, DayUsage>;

const emptyDay = (): DayUsage => ({ total: 0, hours: new Array(24).fill(0), apps: {}, spans: [] });

export const dayKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function load(): Days {
  try {
    if (existsSync(filePath)) return JSON.parse(readFileSync(filePath, "utf8").replace(/^\uFEFF/, "")) as Days;
  } catch (error) {
    console.error("[screen-time] could not read", filePath, error);
  }
  return {};
}

let days: Days | null = null;
let dirty = false;
let lastSample = 0;
let lastSave = 0;

/** Bumped on every counted sample, so views that read it redraw. */
export const screenTime = store({ rev: 0, current: "" });

function allDays(): Days {
  if (!days) days = load();
  return days;
}

function save() {
  if (!dirty || !days) return;
  try {
    const cutoff = dayKey(new Date(Date.now() - KEEP_DAYS * 86_400_000));
    for (const key of Object.keys(days)) if (key < cutoff) delete days[key];
    mkdirSync(configDir, { recursive: true });
    writeFileSync(filePath, JSON.stringify(days));
    dirty = false;
    lastSave = Date.now();
  } catch (error) {
    console.error("[screen-time] could not save", error);
  }
}

/** Two pieces of the same app this close (s) join into one span of the timeline. */
const SPAN_GAP_S = 90;

/** Adds [from, to) (ms) to the app, split at hour (and so day) boundaries. */
function credit(app: { key: string; name: string; exe: string }, from: number, to: number) {
  const all = allDays();
  for (let t = from; t < to; ) {
    const date = new Date(t);
    const hourEnd = new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours() + 1).getTime();
    const end = Math.min(to, hourEnd);
    const seconds = (end - t) / 1000;
    const day = (all[dayKey(date)] ??= emptyDay());
    const start = date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds();
    day.total += seconds;
    day.hours[date.getHours()] = (day.hours[date.getHours()] ?? 0) + seconds;
    const usage = (day.apps[app.key] ??= { name: app.name, exe: app.exe, seconds: 0 });
    usage.seconds += seconds;
    usage.name = app.name || usage.name;
    usage.exe = app.exe || usage.exe;
    const last = day.spans[day.spans.length - 1];
    const stop = Math.round(start + seconds);
    if (last && last[2] === app.key && start - last[1] <= SPAN_GAP_S) last[1] = stop;
    else day.spans.push([start, stop, app.key]);
    t = end;
  }
}

/**
 * Credits the app in front since the last sample, up to when the user stopped counting as present
 * (last input + 5 min). Away, the baseline is dropped: the time until the user is back never counts.
 */
function sample(away = false) {
  const now = Date.now();
  const prev = lastSample;
  const idle = idleMs();
  away ||= idle > IDLE_MS;
  lastSample = away ? 0 : now;
  const app = desktop.activeKey ? desktop.apps.find((a) => a.key === desktop.activeKey) : undefined;
  screenTime.current = !away && app ? app.key : "";
  if (!app || !prev || now - prev > MAX_STEP_S * 1000) return;
  const end = Math.min(now, now - idle + IDLE_MS);
  if (end <= prev) return;
  credit(app, prev, end);
  dirty = true;
  screenTime.rev++;
  if (now - lastSave > 60_000) save();
}

let idleTimer: ReturnType<typeof setTimeout> | undefined;

/** Sets the one timer at the moment the user would count as away; away, waits for the next input. */
function scheduleIdle() {
  clearTimeout(idleTimer);
  const idle = idleMs();
  if (idle > IDLE_MS) return awaitInput();
  idleTimer = setTimeout(() => {
    sample();
    scheduleIdle();
  }, IDLE_MS - idle + 1000);
}

let stopExitHook: (() => void) | null = null;

/**
 * Starts tracking (and the window list it reads); returns the release function. A foreground
 * change credits the app that was in front up to now: the shell event comes before the app list
 * moves on to the new one (scheduleRefresh), so desktop.activeKey is still the previous app.
 * Keeps counting behind a full-screen app: that app (a game, a video) is the one in front.
 */
export function acquireScreenTime(): () => void {
  if (users++ === 0) startTracking();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--users === 0) stopTracking?.();
  };
}

let users = 0;
let stopTracking: (() => void) | null = null;

function startTracking() {
  const releaseWindows = windowsPoller.acquire();
  let locked = false;
  let screenOff = false;
  lastSample = 0;
  sample();
  scheduleIdle();
  const off = onShellEvent((event) => {
    if (event.type === "foreground" || event.type === "input") {
      sample(locked || screenOff);
      if (!locked && !screenOff) scheduleIdle();
    } else if (event.type === "session" || event.type === "screen") {
      if (event.type === "session") locked = event.locked;
      else screenOff = !event.on;
      // Going away credits up to now; coming back starts counting again.
      sample(locked || screenOff);
      if (!locked && !screenOff) scheduleIdle();
      else clearTimeout(idleTimer);
    }
  });
  stopExitHook ??= onExit(save);
  stopTracking = () => {
    stopTracking = null;
    off();
    clearTimeout(idleTimer);
    sample();
    lastSample = 0;
    releaseWindows();
    save();
  };
}

/** Usage of one day ("YYYY-MM-DD"), today by default; an empty day when nothing was counted. */
export function usageOf(key = dayKey()): DayUsage {
  void screenTime.rev;
  return allDays()[key] ?? emptyDay();
}

/** The apps used in the last `count` days (today included), most used first. */
export function topApps(count: number, limit = 5): (AppUsage & { key: string })[] {
  void screenTime.rev;
  const sum = new Map<string, AppUsage & { key: string }>();
  for (let i = 0; i < count; i++) {
    const day = allDays()[dayKey(new Date(Date.now() - i * 86_400_000))];
    if (!day) continue;
    for (const [key, app] of Object.entries(day.apps)) {
      const entry = sum.get(key) ?? { key, name: app.name, exe: app.exe, seconds: 0 };
      entry.seconds += app.seconds;
      sum.set(key, entry);
    }
  }
  return [...sum.values()].sort((a, b) => b.seconds - a.seconds).slice(0, limit);
}

/** "2h 05m", "12m", "<1m". */
export function formatDuration(seconds: number) {
  const m = Math.floor(seconds / 60);
  if (m < 1) return "<1m";
  const h = Math.floor(m / 60);
  return h ? `${h}h ${String(m % 60).padStart(2, "0")}m` : `${m}m`;
}

export type AppKind = "browser" | "dev" | "chat" | "media" | "office" | "game" | "other";

export const kindInfo: Record<AppKind, { label: string; color: string }> = {
  browser: { label: tr("services.launcherScreenTime.browsing"), color: "#0a84ff" },
  dev: { label: tr("services.launcherScreenTime.development"), color: "#bf5af2" },
  chat: { label: tr("services.launcherScreenTime.communication"), color: "#30d158" },
  media: { label: tr("services.launcherScreenTime.media"), color: "#ff9f0a" },
  office: { label: tr("services.launcherScreenTime.office"), color: "#64d2ff" },
  game: { label: tr("services.launcherScreenTime.games"), color: "#ff453a" },
  other: { label: tr("services.launcherScreenTime.other"), color: "#8e8e93" },
};

const KIND_RULES: [AppKind, RegExp][] = [
  ["browser", /chrome|msedge|firefox|brave|opera|vivaldi|arc\b|zen\b|browser/],
  ["dev", /code|devenv|idea|pycharm|webstorm|rider|clion|goland|cursor|zed|sublime|notepad\+\+|terminal|\bwt\.exe|powershell|cmd\.exe|windsurf|github|git|docker|postman|empryo/],
  ["chat", /teams|slack|discord|whatsapp|telegram|zoom|skype|signal|outlook|thunderbird|mail/],
  ["media", /spotify|vlc|music|zune|video|netflix|youtube|obs|photos|mpc|potplayer|audacity|premiere|davinci|photoshop|figma/],
  ["office", /winword|excel|powerpnt|onenote|notion|obsidian|acrobat|pdf|libreoffice|soffice|notepad|evernote/],
  ["game", /steam|epicgames|battle\.net|riot|xbox|gamebar|minecraft|\\games\\/],
];

const kindCache = new Map<string, AppKind>();
/** A rough category of an app from its identity and name, for coloring the timeline. */
export function kindOf(key: string, app?: { name: string; exe: string }): AppKind {
  const cached = kindCache.get(key);
  if (cached) return cached;
  const text = `${key} ${app?.exe ?? ""} ${app?.name ?? ""}`.toLowerCase();
  const kind = KIND_RULES.find(([, re]) => re.test(text))?.[0] ?? "other";
  kindCache.set(key, kind);
  return kind;
}
