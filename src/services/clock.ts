import { onShellEvent } from "../native/shell-events";
import { dockCovered, onDockCoveredChange } from "./poller";

/**
 * One clock for the whole dock, like the taskbar clock: Explorer keeps a single timer armed for the
 * next moment the time it shows changes (SetTimer to the next minute, or second with "show seconds"),
 * not one interval per thing that shows the time.
 *
 * Subscribers say when they next need to wake (a time boundary, a countdown's next whole second,
 * a deadline); the service keeps one setTimeout armed for the earliest of them, calls every due
 * subscriber in the same macrotask (their store writes coalesce into one render) and stops when
 * nobody is subscribed. While the dock is covered by a full-screen app the wakes rest (unless a
 * subscriber asks otherwise, like a countdown that must ring); each catches up once when it returns.
 * A wall-clock jump (time set, resume from sleep) is noticed on the next wake and on the shell's
 * power/display/setting broadcasts, and re-syncs everyone.
 */

export type ClockUnit = "second" | "minute" | "hour" | "day";

/** When to wake next (epoch ms) from `now`, or null to sleep until `update()`. `covered`: the dock is behind a full-screen app. */
export type NextWake = (now: number, covered: boolean) => number | null;

export interface ClockSubscription {
  /** Re-reads `next` (the state it depends on changed: a countdown started, data arrived). */
  update(): void;
  cancel(): void;
}

interface Sub {
  next: NextWake;
  fire: (now: number) => void;
  at: number | null;
  last: number;
}

/** Landing just after the boundary, so `new Date()` in the callback already shows the new value. */
const SLACK = 15;
/** A wall clock that moved this far from the monotonic one was set (or the PC slept). */
const JUMP = 2_000;

const subs = new Set<Sub>();
let timer: ReturnType<typeof setTimeout> | undefined;
let armedFor = Infinity;
let offset = Date.now() - performance.now();
let offEvents: (() => void) | undefined;
const stats = { wakes: 0, fires: 0 };

/** The next local `unit` boundary after `now` (local midnight for "day", DST-safe). */
export function nextBoundary(unit: ClockUnit, now = Date.now()): number {
  if (unit === "second") return Math.floor(now / 1000) * 1000 + 1000;
  // Every zone offset is whole minutes, so local and UTC minutes start together.
  if (unit === "minute") return Math.floor(now / 60_000) * 60_000 + 60_000;
  const d = new Date(now);
  if (unit === "hour") {
    d.setMinutes(0, 0, 0);
    return d.getTime() + 3_600_000;
  }
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** Wakes on each local `unit` boundary while the dock is visible. */
export const every =
  (unit: ClockUnit | (() => ClockUnit)): NextWake =>
  (now, covered) =>
    covered ? null : nextBoundary(typeof unit === "function" ? unit() : unit, now);

function call(sub: Sub, now: number) {
  sub.last = now;
  stats.fires++;
  try {
    sub.fire(now);
  } catch (error) {
    console.error("[clock]", error);
  }
}

function plan(sub: Sub, now: number) {
  try {
    sub.at = sub.next(now, dockCovered());
  } catch (error) {
    console.error("[clock]", error);
    sub.at = null;
  }
}

function arm() {
  let earliest = Infinity;
  for (const sub of subs) if (sub.at !== null && sub.at < earliest) earliest = sub.at;
  if (earliest === armedFor && timer) return;
  clearTimeout(timer);
  timer = undefined;
  armedFor = earliest;
  if (earliest === Infinity) return;
  timer = setTimeout(wake, Math.max(0, earliest - Date.now()) + SLACK);
}

/** The wall clock jumped against the monotonic one: time was set, or the PC slept. */
function jumped() {
  const now = Date.now();
  const next = now - performance.now();
  const moved = Math.abs(next - offset) > JUMP;
  offset = next;
  return moved;
}

function wake() {
  timer = undefined;
  armedFor = Infinity;
  stats.wakes++;
  if (jumped()) return resync(true);
  const now = Date.now();
  const due = [...subs].filter((sub) => sub.at !== null && sub.at <= now);
  for (const sub of due) call(sub, now);
  for (const sub of due) if (subs.has(sub)) plan(sub, now);
  arm();
}

/** Re-plans everyone; `all` also fires them (the time they show may be wrong after a jump). */
function resync(all: boolean) {
  const now = Date.now();
  const covered = dockCovered();
  for (const sub of [...subs]) {
    if (all && !covered && subs.has(sub)) call(sub, now);
    if (subs.has(sub)) plan(sub, now);
  }
  arm();
}

function listen() {
  const offCover = onDockCoveredChange(() => {
    const now = Date.now();
    if (!dockCovered()) {
      // Back in front: whoever had a wake due while resting catches up once.
      for (const sub of [...subs]) {
        let due: number | null = null;
        try {
          due = sub.next(sub.last, false);
        } catch {}
        if (due !== null && due <= now && subs.has(sub)) call(sub, now);
      }
    }
    resync(false);
  });
  const offShell = onShellEvent((event) => {
    // WM_POWERBROADCAST (resume reports a power status change), WM_DISPLAYCHANGE (monitors wake),
    // WM_SETTINGCHANGE / WM_TIMECHANGE (time or zone set): re-check against the monotonic clock.
    const type = (event as { type: string }).type;
    if (type === "power" || type === "display" || type === "setting" || type === "time" || type === "resume") {
      if (jumped()) resync(true);
    }
  });
  return () => {
    offCover();
    offShell();
  };
}

/** Subscribes `fire` to the shared clock; it runs whenever `next` comes due. */
export function onClock(next: NextWake, fire: (now: number) => void): ClockSubscription {
  const now = Date.now();
  const sub: Sub = { next, fire, at: null, last: now };
  if (!subs.size) {
    offset = now - performance.now();
    offEvents = listen();
  }
  subs.add(sub);
  plan(sub, now);
  arm();
  return {
    update() {
      if (!subs.has(sub)) return;
      plan(sub, Date.now());
      arm();
    },
    cancel() {
      if (!subs.delete(sub)) return;
      if (!subs.size) {
        offEvents?.();
        offEvents = undefined;
      }
      arm();
    },
  };
}

/** Timer wakes and subscriber calls since start (for benchmarks). */
export function clockStats() {
  return { ...stats, subscribers: subs.size, armed: timer !== undefined };
}
