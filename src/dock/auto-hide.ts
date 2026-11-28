import { config } from "../config";
import { cursorPos, monitorOf, windowRect } from "../native/win32";
import type { DockWindow } from "../native/dock-window";
import { dockEdge } from "../services/taskbar-prefs";
import { dockUi } from "./state";

/** How often the pointer is checked: short enough that the reveal at the edge feels immediate. */
const TICK_MS = 16;
/** Physical px from the screen edge that count as touching it. */
const EDGE_PX = 2;

let cloakTimer: ReturnType<typeof setTimeout> | undefined;

function hide(dock: DockWindow) {
  dockUi.autoHidden = true;
  clearTimeout(cloakTimer);
  // Once the animation has run the window is cloaked: not drawn and the pointer goes through it.
  const ms = config.autoHideAnimation === "none" ? 0 : Math.max(0, Number(config.autoHideDuration) || 0);
  cloakTimer = setTimeout(() => dockUi.autoHidden && dock.setAutoHidden(true), ms);
}

function show(dock: DockWindow) {
  clearTimeout(cloakTimer);
  dock.setAutoHidden(false);
  dockUi.autoHidden = false;
}

/**
 * Auto-hide driven by the dock itself, not Windows' auto-hide AppBar slot (Explorer's hidden taskbar
 * holds the bottom edge's only one, docs/taskbar-gaps.md §6): the pointer is checked every TICK_MS,
 * the dock comes back when it touches the screen edge the dock sits on and leaves once it has been
 * off the dock for the hide delay. It stays while a menu, preview or flyout of the dock is open.
 */
export function startAutoHide(dock: () => DockWindow | undefined, busy: () => boolean) {
  let since = 0;
  setInterval(() => {
    const d = dock();
    if (!d) return;
    if (!config.autoHide || dockUi.editing || busy()) {
      since = 0;
      if (dockUi.autoHidden) show(d);
      return;
    }
    const p = cursorPos();
    const m = monitorOf(d.hwnd).monitor;
    const r = windowRect(d.hwnd);
    const edge = dockEdge();
    const onMonitorX = p.x >= m.left && p.x < m.right;
    const onMonitorY = p.y >= m.top && p.y < m.bottom;
    // At the edge: the last EDGE_PX of the dock's monitor. On the dock: its window stretched to that
    // edge, so the gap under a floating dock does not count as leaving it.
    const atEdge =
      edge === "bottom" ? onMonitorX && p.y >= m.bottom - EDGE_PX && p.y <= m.bottom
      : edge === "top" ? onMonitorX && p.y <= m.top + EDGE_PX - 1 && p.y >= m.top - 1
      : edge === "left" ? onMonitorY && p.x <= m.left + EDGE_PX - 1 && p.x >= m.left - 1
      : onMonitorY && p.x >= m.right - EDGE_PX && p.x <= m.right;
    const inX = p.x >= r.left && p.x < r.right;
    const inY = p.y >= r.top && p.y < r.bottom;
    const onDock =
      edge === "bottom" ? inX && p.y >= r.top && p.y <= m.bottom
      : edge === "top" ? inX && p.y < r.bottom && p.y >= m.top - 1
      : edge === "left" ? inY && p.x < r.right && p.x >= m.left - 1
      : inY && p.x >= r.left && p.x <= m.right;
    const flip = dockUi.autoHidden ? atEdge : !onDock;
    if (!flip) {
      since = 0;
      return;
    }
    const now = Date.now();
    if (!since) since = now;
    const delay = Math.max(0, Number(dockUi.autoHidden ? config.autoHideShowDelay : config.autoHideHideDelay) || 0);
    if (now - since < delay) return;
    since = 0;
    if (dockUi.autoHidden) show(d);
    else hide(d);
  }, TICK_MS);
}
