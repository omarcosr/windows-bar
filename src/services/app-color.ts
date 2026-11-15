import { store } from "@tarve/core";
import { monitorOf, screenPixels, windowClass, windowRect, isWindowVisible, type HWND } from "../native/win32";
import { foregroundApp } from "./windows";

/**
 * The colour along the bottom edge of the app in front, so the strip under a floating dock can
 * continue it. null when no app window reaches the bottom of the work area (desktop, small window).
 */
export const appColor = store({ color: null as string | null });

const DESKTOP_CLASSES = new Set(["Progman", "WorkerW", "Shell_TrayWnd"]);
let timer: ReturnType<typeof setInterval> | undefined;

function sample(dock: HWND | null) {
  const fg = foregroundApp();
  if (!fg || !dock || !isWindowVisible(fg) || DESKTOP_CLASSES.has(windowClass(fg))) return null;
  const { work } = monitorOf(dock);
  const r = windowRect(fg);
  // Only a window that sits on the strip reads as continuing into it.
  if (r.bottom < work.bottom - 8 || r.top >= work.bottom) return null;
  const left = Math.max(r.left, work.left);
  const right = Math.min(r.right, work.right);
  if (right - left < 40) return null;
  // A few px up: windows often end in a 1–2 px frame line of another colour.
  const y = Math.min(r.bottom, work.bottom) - 6;
  const xs = [0.08, 0.25, 0.5, 0.75, 0.92].map((f) => left + (right - left) * f);
  const colors = screenPixels(xs.map((x) => ({ x, y }))).filter((c): c is [number, number, number] => !!c);
  if (!colors.length) return null;
  // The most common colour wins, so a scrollbar or a status icon does not tint the strip.
  const counts = new Map<string, { c: [number, number, number]; n: number }>();
  for (const c of colors) {
    const key = c.map((v) => v >> 3).join(",");
    const entry = counts.get(key);
    if (entry) entry.n++;
    else counts.set(key, { c, n: 1 });
  }
  const best = [...counts.values()].sort((a, b) => b.n - a.n)[0]!.c;
  return `rgb(${best[0]},${best[1]},${best[2]})`;
}

/** Samples while `enabled()` is true. */
export function watchAppColor(dock: () => HWND | null, enabled: () => boolean) {
  clearInterval(timer);
  timer = setInterval(() => {
    const next = enabled() ? sample(dock()) : null;
    if (next !== appColor.color) appColor.color = next;
  }, 400);
}
