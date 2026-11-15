import { store } from "@tarve/core";
import { monitorOf, screenPixels, topWindowAt, windowClass, windowRect, isWindowVisible, type HWND, type Rect } from "../native/win32";
import { foregroundApp } from "./windows";

type RGB = [number, number, number];

/**
 * The colour the strip under a floating dock paints, so the screen seems to continue under it:
 * the bottom edge of the app in front when it sits on the strip (`touching`), otherwise the
 * predominant colour just above the strip (wallpaper and whatever windows are there).
 */
export const appColor = store({ color: null as string | null, touching: false });

const DESKTOP_CLASSES = new Set(["Progman", "WorkerW", "Shell_TrayWnd"]);
let timer: ReturnType<typeof setInterval> | undefined;
let current: RGB | null = null;

/** Most common colour (in 16-step buckets) when it covers `share` of the samples, else the average. */
function predominant(colors: RGB[], share: number): RGB | null {
  if (!colors.length) return null;
  const buckets = new Map<string, RGB[]>();
  for (const c of colors) {
    const key = c.map((v) => v >> 4).join(",");
    const list = buckets.get(key);
    if (list) list.push(c);
    else buckets.set(key, [c]);
  }
  const top = [...buckets.values()].sort((a, b) => b.length - a.length)[0]!;
  const pick = top.length / colors.length >= share ? top : colors;
  return [0, 1, 2].map((i) => Math.round(pick.reduce((s, c) => s + c[i]!, 0) / pick.length)) as RGB;
}

function row(left: number, right: number, y: number, count: number) {
  const xs = Array.from({ length: count }, (_, i) => left + ((right - left) * (i + 0.5)) / count);
  return screenPixels(xs.map((x) => ({ x, y }))).filter((c): c is RGB => !!c);
}

function appEdge(work: Rect): RGB | null {
  const fg = foregroundApp();
  if (!fg || !isWindowVisible(fg) || DESKTOP_CLASSES.has(windowClass(fg))) return null;
  const r = windowRect(fg);
  // Only a window that sits on the strip reads as continuing into it.
  if (r.bottom < work.bottom - 8 || r.top >= work.bottom) return null;
  const left = Math.max(r.left, work.left);
  const right = Math.min(r.right, work.right);
  if (right - left < 40) return null;
  // A few px up: windows often end in a 1–2 px frame line of another colour.
  return predominant(row(left, right, Math.min(r.bottom, work.bottom) - 6, 5), 0);
}

function screenEdge(work: Rect): RGB | null {
  // What sits right above the strip, across the whole width. Where that is mostly the
  // wallpaper (a small window in front of the desktop), the strip stays clear like the
  // desktop itself; otherwise it takes the colour of the windows there.
  const y = work.bottom - 6;
  const xs = Array.from({ length: 16 }, (_, i) => work.left + ((work.right - work.left) * (i + 0.5)) / 16);
  const onDesktop = xs.map((x) => {
    const top = topWindowAt(x, y);
    return !top || DESKTOP_CLASSES.has(windowClass(top));
  });
  if (onDesktop.filter(Boolean).length >= xs.length / 2) return null;
  const colors = screenPixels(xs.filter((_, i) => !onDesktop[i]).map((x) => ({ x, y }))).filter((c): c is RGB => !!c);
  return predominant(colors, 0.35);
}

const distance = (a: RGB, b: RGB) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);

/**
 * Samples while `enabled()` is true. `paused()` holds the colour while the dock's own popups
 * (preview, menu) sit right above the strip and would be read back.
 */
export function watchAppColor(dock: () => HWND | null, enabled: () => boolean, paused: () => boolean) {
  clearInterval(timer);
  timer = setInterval(() => {
    const hwnd = dock();
    if (!enabled() || !hwnd) {
      current = null;
      if (appColor.color !== null) Object.assign(appColor, { color: null, touching: false });
      return;
    }
    if (paused()) return;
    const { work } = monitorOf(hwnd);
    // Without a reserved strip the rows above it are the dock itself: nothing to read. (The
    // painted strip reaches a few px over the work area on purpose; more means no reservation.)
    if (windowRect(hwnd).top < work.bottom - 8) return;
    // On the desktop the strip stays clear and shows the wallpaper, like the Windows taskbar.
    const fg = foregroundApp();
    if (!fg || DESKTOP_CLASSES.has(windowClass(fg))) {
      current = null;
      if (appColor.color !== null) Object.assign(appColor, { color: null, touching: false });
      return;
    }
    const edge = appEdge(work);
    const next = edge ?? screenEdge(work);
    const touching = !!edge;
    // Ignore tiny changes (video, animations near the edge) so the strip does not flicker.
    if (next && current && distance(next, current) < 18 && touching === appColor.touching) return;
    current = next;
    Object.assign(appColor, { color: next ? `rgb(${next[0]},${next[1]},${next[2]})` : null, touching });
  }, 400);
}
