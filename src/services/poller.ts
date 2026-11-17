import { onShellEvent } from "../native/shell-events";

let fullscreen = false;
let locked = false;
let screenOff = false;
let covered = false;
let away = false;
const coverListeners = new Set<() => void>();

function update() {
  const nextAway = locked || screenOff;
  const nextCovered = fullscreen || nextAway;
  if (nextAway === away && nextCovered === covered) return;
  away = nextAway;
  covered = nextCovered;
  for (const fn of coverListeners) fn();
}

/**
 * The dock stepped behind a full-screen app (DockWindow.checkFullscreen) or came back. While it is
 * covered nothing it draws can be seen, so pollers rest; each catches up once when it returns.
 */
export function setDockCovered(on: boolean) {
  fullscreen = on;
  update();
}

// The session locked (WM_WTSSESSION_CHANGE) or the display off (GUID_CONSOLE_DISPLAY_STATE): nobody
// sees the dock either, so it counts as covered, and as away (see dockAway).
onShellEvent((event) => {
  if (event.type === "session") locked = event.locked;
  else if (event.type === "screen") screenOff = !event.on;
  else return;
  update();
});

/** True while nothing the dock draws can be seen: behind a full-screen app, session locked or display off. */
export function dockCovered() {
  return covered;
}

/** True while the session is locked or the display is off: even `whileCovered` work rests. */
export function dockAway() {
  return away;
}

/** Called when the dock is covered or uncovered, or the session goes away or comes back; returns the unsubscribe function. */
export function onDockCoveredChange(fn: () => void): () => void {
  coverListeners.add(fn);
  return () => coverListeners.delete(fn);
}

/**
 * A shared poll loop that only runs while something uses it, and rests while the dock is covered
 * by a full-screen app (`whileCovered` keeps it going: screen time counts the game in front) and
 * while the session is locked or the display is off (always).
 * An async tick never overlaps itself: a tick due while the last one is still waiting is skipped.
 */
export function createPoller(ms: number, tick: () => unknown, options: { whileCovered?: boolean } = {}) {
  let users = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let pending = false;
  let lastRun = 0;
  const run = () => {
    if (pending) return;
    lastRun = Date.now();
    try {
      const result = tick();
      if (result instanceof Promise) {
        pending = true;
        result.catch((error) => console.error("[poller]", error)).finally(() => (pending = false));
      }
    } catch (error) {
      console.error("[poller]", error);
    }
  };
  const resting = () => away || (covered && !options.whileCovered);
  const start = () => {
    clearInterval(timer);
    timer = undefined;
    if (!users || resting()) return;
    // Back from full screen: read at once only when a tick was missed.
    if (Date.now() - lastRun >= ms) run();
    timer = setInterval(run, ms);
  };
  let wasResting = resting();
  onDockCoveredChange(() => {
    const now = resting();
    if (now === wasResting) return;
    wasResting = now;
    if (users) start();
  });
  return {
    /** Starts polling (if needed); returns the release function. */
    acquire(): () => void {
      if (users++ === 0) {
        lastRun = 0;
        start();
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (--users === 0) {
          clearInterval(timer);
          timer = undefined;
        }
      };
    },
  };
}
