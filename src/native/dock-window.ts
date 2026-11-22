import type { AppHandle } from "@tarve/core";
import { dlopen, type Pointer } from "./ffi";
import {
  monitorOf,
  ABS_AUTOHIDE,
  cursorPos,
  explorerTray,
  fullscreenAppActive,
  isWindowVisible,
  setTaskbarState,
  showWindow,
  showWindowAsync,
  foregroundWindow,
  exePathOf,
  windowClass,
  windowPid,
  SW_HIDE,
  SW_SHOWNA,
  taskbarState,
  windowRect,
  type HWND,
} from "./win32";
import { join } from "node:path";
import { writeFileSync, readFileSync, rmSync } from "node:fs";
import { configDir } from "../config";
import restoreScript from "../../scripts/restore-taskbar.ps1" with { type: "text" };
import { output } from "../runtime/proc";
import { exitApp, onExit } from "../services/exit";
import { onShellEvent, type ShellEvent } from "./shell-events";
import { setDockCovered } from "../services/poller";
import type { TaskbarEdge } from "../services/taskbar-prefs";
import { setWindowPeek } from "@tarve/core";

const dwmapi = dlopen("dwmapi.dll", {
  DwmSetWindowAttribute: { args: ["ptr", "u32", "ptr", "u32"], returns: "i32" },
});

/**
 * Hides the window through DWM (DWMWA_CLOAK) or shows it again: it is not drawn and takes no
 * pointer input, but stays where it is in the z-order and keeps its AppBar.
 */
function cloak(hwnd: HWND, on: boolean) {
  const DWMWA_CLOAK = 13;
  dwmapi.symbols.DwmSetWindowAttribute(hwnd, DWMWA_CLOAK, new Uint8Array(new Uint32Array([on ? 1 : 0]).buffer), 4);
}

/** Processes that draw the shell's own surfaces: Start, Search and the taskbar's flyouts. */
const SHELL_HOSTS = /\\(StartMenuExperienceHost|SearchHost|SearchApp|ShellExperienceHost|ShellHost)\.exe$/i;
/** Explorer's own shell windows (the taskbar, Task View / Alt+Tab), not its File Explorer windows. */
const EXPLORER_SHELL = new Set(["Shell_TrayWnd", "Shell_SecondaryTrayWnd", "XamlExplorerHostIslandWindow", "MultitaskingViewFrame"]);
const shellHosts = new Map<number, boolean>();

/** Whether the window in front is part of the shell (Start, Search, a flyout, Task View). */
function shellSurfaceInFront() {
  const fg = foregroundWindow();
  if (!fg) return false;
  if (EXPLORER_SHELL.has(windowClass(fg))) return true;
  const pid = windowPid(fg);
  let host = shellHosts.get(pid);
  if (host === undefined) {
    host = SHELL_HOSTS.test(exePathOf(pid));
    if (shellHosts.size > 64) shellHosts.clear();
    shellHosts.set(pid, host);
  }
  return host;
}

/** Stays visible while a window is peeked from the preview, like the real taskbar. */
function excludeFromPeek(hwnd: HWND) {
    setWindowPeek(hwnd, { excluded: true });
}

export interface DockWindowOptions {
  mode: "floating" | "full";
  /** Windows' own taskbar alignment; a floating dock follows it to the left edge. */
  align: "center" | "left";
  /** Docks the window as an AppBar: it then spans the reserved strip and the view lays itself out in it. */
  reserveSpace: boolean;
  hideNativeTaskbar: boolean;
  bottomMargin: number;
  /** Logical px the window reaches up over the app above the strip, hiding its bottom frame line. */
  stripOverlap: number;
  /** Bar height in logical px (config.barHeight): the reserved strip follows it. */
  barHeight: number;
  /** The screen edge Windows' taskbar is set to (Settings > Taskbar > Taskbar location). */
  edge: TaskbarEdge;
}

/** A popup's room: the work area of the dock's screen, physical px. */
interface Area {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Owns the native side of the dock window: reserves the strip as an AppBar (app.appBar; the window
 * then covers it), or sizes a free dock to its content at the bottom of its monitor, and optionally
 * hides the Windows taskbar.
 */
export class DockWindow {
  #app: AppHandle;
  #hwnd: HWND;
  #options: DockWindowOptions;
  #size = { width: 0, height: 0 };
  /** Logical thickness of the current AppBar, or -1 while not docked. */
  #reserved = -1;
  /** Logical overlap the current AppBar was docked with. */
  #overlap = 0;
  #scale = 1;
  #layoutRun = 0;
  /** The window covers the hidden taskbar's own strip (off the bottom edge, see #hiddenState). */
  #covering = false;
  #taskbar: { hwnd: HWND; state: number } | null = null;
  #hiddenForFullscreen = false;
  #offShell: () => void;
  #offScreens: () => void;
  #lostChecks = 0;
  #redock: ReturnType<typeof setTimeout> | undefined;
  #watchdog = false;
  #disposed = false;

  private constructor(app: AppHandle, hwnd: HWND, options: DockWindowOptions) {
    this.#app = app;
    this.#hwnd = hwnd;
    this.#options = options;
    excludeFromPeek(hwnd);
    this.#offShell = onShellEvent((event) => this.#onShellEvent(event));
    // Monitors added or removed, resolution, scale or work area changed: lay out again and check
    // that the strip is still reserved.
    this.#offScreens = app.onScreensChange(() => {
      void this.layout();
      void this.#verifyReservation();
    });
    if (DockWindow.#hidesTaskbar(options)) this.#hideTaskbar();
    const cleanup = () => this.dispose();
    onExit(cleanup);
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      process.once(signal, () => {
        cleanup();
        // Explorer hides its taskbar again a moment after the restore (see settleTaskbar).
        void this.settleTaskbar().finally(() => exitApp(0));
      });
    }
    this.layout();
  }

  static #current: DockWindow | null = null;
  static handle(): HWND | null {
    const dock = DockWindow.#current;
    return dock ? dock.#hwnd : null;
  }

  static #vertical(dock: DockWindow) {
    return dock.#options.edge === "left" || dock.#options.edge === "right";
  }

  /** A point's coordinate along the dock: x on a horizontal dock, y on a vertical one (physical px). */
  static along(p: { x: number; y: number } | null | undefined, area: Area): number {
    const dock = DockWindow.#current;
    const vertical = !!dock && DockWindow.#vertical(dock);
    if (!p) return vertical ? area.y + area.height / 2 : area.x + area.width / 2;
    return vertical ? p.y : p.x;
  }

  /** The centre of a laid-out node's box along the dock, in physical screen px. */
  static #center(dock: DockWindow, box: { x: number; y: number; borderWidth: number; borderHeight: number }) {
    const r = windowRect(dock.#hwnd);
    return DockWindow.#vertical(dock) ? r.top + (box.y + box.borderHeight / 2) * dock.#scale : r.left + (box.x + box.borderWidth / 2) * dock.#scale;
  }

  /** Centre of a dock node (by id) along the dock, in physical screen px; null if it is not laid out. */
  static nodeCenter(id: string): number | null {
    const dock = DockWindow.#current;
    if (!dock) return null;
    const box = dock.#app.layout([id])?.[id];
    return box ? DockWindow.#center(dock, box) : null;
  }

  /** A dock node's border box on screen (physical px); null if it is not laid out. */
  static nodeScreenRect(id: string): { x: number; y: number; width: number; height: number } | null {
    const dock = DockWindow.#current;
    if (!dock) return null;
    const box = dock.#app.layout([id])?.[id];
    if (!box) return null;
    const r = windowRect(dock.#hwnd);
    const s = dock.#scale;
    return { x: Math.round(r.left + box.x * s), y: Math.round(r.top + box.y * s), width: Math.round(box.borderWidth * s), height: Math.round(box.borderHeight * s) };
  }

  /** nodeCenter without blocking the JS thread: resolves once the renderer answers. */
  static async nodeCenterAsync(id: string): Promise<number | null> {
    const dock = DockWindow.#current;
    if (!dock) return null;
    const box = (await dock.#app.layoutAsync([id]).catch(() => undefined))?.[id];
    if (!box || dock.#disposed) return null;
    return DockWindow.#center(dock, box);
  }

  /**
   * Where a popup (menu, preview, tip, flyout) of `width` x `height` physical px opens: beside the
   * dock on its inner side (above a bottom dock, below a top one, right of a left one, left of a
   * right one), `gap` px away, centred on `center` (a coordinate along the dock, see nodeCenter)
   * or the pointer, and kept inside `area`. The taskbar opens its flyouts the same way.
   */
  static placePopup(width: number, height: number, gap: number, area: Area, center: number | null, fallback = 56): { x: number; y: number } {
    const dock = DockWindow.#current;
    const edge = dock ? dock.#options.edge : "bottom";
    const scale = dock ? dock.#scale : 1;
    const vertical = edge === "left" || edge === "right";
    const at = center ?? DockWindow.along(cursorPos(), area);
    const clampX = (x: number) => Math.max(area.x + gap, Math.min(Math.round(x), area.x + area.width - width - gap));
    const clampY = (y: number) => Math.max(area.y + gap, Math.min(Math.round(y), area.y + area.height - height - gap));
    // A floating dock in its strip sits inside the strip's margin.
    const inset = dock && dock.#spansStrip() && dock.#options.mode === "floating" ? Math.round(dock.#options.bottomMargin * scale) : 0;
    const r = dock ? windowRect(dock.#hwnd) : null;
    const thick = Math.round(fallback * scale);
    if (vertical) {
      const y = clampY(at - height / 2);
      if (edge === "left") return { x: (r ? r.right - inset : area.x + thick) + gap, y };
      return { x: (r ? r.left + inset : area.x + area.width - thick) - gap - width, y };
    }
    const x = clampX(at - width / 2);
    if (edge === "top") return { x, y: (r ? r.bottom - inset : area.y + thick) + gap };
    return { x, y: Math.max(area.y + gap, (r ? r.top + inset : area.y + area.height - thick) - gap - height) };
  }

  /**
   * Whether the pointer is on dock node `id` now (physical screen px), across the whole bar where
   * its HitReach reaches. For a blur that names no target (Tarve leaves WindowFocusChange empty
   * when it cannot tell where the focus went).
   */
  static pointerOn(id: string): boolean {
    const dock = DockWindow.#current;
    if (!dock) return false;
    const box = dock.#app.layout([id])?.[id];
    if (!box) return false;
    const r = windowRect(dock.#hwnd);
    const p = cursorPos();
    const s = dock.#scale;
    const x0 = r.left + box.x * s;
    const y0 = r.top + box.y * s;
    const inX = p.x >= x0 && p.x <= x0 + box.borderWidth * s;
    const inY = p.y >= y0 && p.y <= y0 + box.borderHeight * s;
    const inBar = p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;
    return inBar && (DockWindow.#vertical(dock) ? inY : inX);
  }

  /** The window spans a whole strip (its own AppBar, or the hidden taskbar's) rather than hugging the dock. */
  #spansStrip() {
    return this.#reserved > 0 || this.#covering;
  }

  /**
   * Whether the press a blur's `pointerTarget` names landed on dock node `anchor`: the node itself
   * or one inside its span along the dock (a button's HitReach reaches across the bar, not along it).
   */
  static pressedOn(anchor: string, target: string | undefined): boolean {
    const dock = DockWindow.#current;
    if (!dock || !target) return false;
    if (target === anchor) return true;
    const boxes = dock.#app.layout([anchor, target]);
    const a = boxes?.[anchor];
    const t = boxes?.[target];
    if (!a || !t) return false;
    return DockWindow.#vertical(dock)
      ? t.y >= a.y - 0.5 && t.y + t.borderHeight <= a.y + a.borderHeight + 0.5
      : t.x >= a.x - 0.5 && t.x + t.borderWidth <= a.x + a.borderWidth + 0.5;
  }

  /** The full-width bar replaces the Windows taskbar, so it always hides it. */
  static #hidesTaskbar(options: DockWindowOptions) {
    return options.hideNativeTaskbar || options.mode === "full";
  }

  /** Takes over the app's window; call after `app.ready`. */
  static attach(app: AppHandle, options: DockWindowOptions): DockWindow {
    const handle = app.nativeHandle();
    if (!handle) throw new Error("dock window has no native handle");
    return (DockWindow.#current = new DockWindow(app, Number(handle) as Pointer, options));
  }

  get hwnd() {
    return this.#hwnd;
  }

  update(options: Partial<DockWindowOptions>) {
    const before = this.#options;
    this.#options = { ...before, ...options };
    const hide = DockWindow.#hidesTaskbar(this.#options);
    if (DockWindow.#hidesTaskbar(before) !== hide) {
      if (hide) this.#hideTaskbar();
      else this.#restoreTaskbar();
    } else if (hide && before.edge !== this.#options.edge) {
      // Moved to another edge: auto-hide at the bottom, the normal state elsewhere.
      this.#rehideTaskbar(true);
    }
    this.layout();
  }

  /** Border-box size in logical px, as reported by the dock view's onSize. */
  setContentSize(width: number, height: number) {
    if (width <= 0 || height <= 0) return;
    if (width === this.#size.width && height === this.#size.height) return;
    this.#size = { width, height };
    this.layout();
  }

  async layout() {
    if (this.#disposed) return;
    const run = ++this.#layoutRun;
    const full = this.#options.mode === "full";
    const screen = await this.#app.screen().catch(() => undefined);
    if (run !== this.#layoutRun || this.#disposed) return;
    if (screen) this.#scale = screen.scale;

    const edge = this.#options.edge;
    // Off the bottom edge Windows does not auto-hide its taskbar: it stays in the normal state,
    // hidden, and keeps its strip reserved. The bar and the strip-spanning dock cover that strip.
    if (edge !== "bottom" && this.#taskbar && (this.#options.reserveSpace || full)) {
      this.#unreserve();
      if (!this.#size.width) return;
      const r = windowRect(this.#taskbar.hwnd);
      if (r.right - r.left <= 0 || r.bottom - r.top <= 0) return;
      this.#covering = true;
      this.#app.setBounds({ x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top, physical: true });
      return;
    }
    this.#covering = false;

    if (this.#options.reserveSpace) {
      // Not before the first render: the strip's thickness depends on the dock's size.
      if (!this.#size.width) return;
      // The window spans the reserved strip and the view adds the margins.
      const thickness = this.#options.barHeight + (full ? 0 : this.#options.bottomMargin * 2);
      this.#dock(edge, thickness, edge === "bottom" ? this.#options.stripOverlap : 0);
      return;
    }
    this.#unreserve();
    if (!screen || !this.#size.width) return;

    const scale = screen.scale;
    const vertical = edge === "left" || edge === "right";
    const width = full && !vertical ? screen.width : Math.ceil(this.#size.width * scale);
    const height = full && vertical ? screen.height : Math.ceil(this.#size.height * scale);
    const margin = full ? 0 : Math.round(this.#options.bottomMargin * scale);
    // With the taskbar hidden the dock takes its place; otherwise it stays beside what it reserves.
    const outer = this.#taskbar ? screen : screen.workArea;
    // Along the edge: centred, or at its start (left, or top on a side edge) like the taskbar's icons.
    const start = this.#options.align === "left";
    const x = vertical
      ? edge === "left" ? outer.x + margin : outer.x + outer.width - margin - width
      : full ? screen.x : start ? screen.x + margin : screen.x + Math.round((screen.width - width) / 2);
    const y = vertical
      ? full ? screen.y : start ? screen.y + margin : screen.y + Math.round((screen.height - height) / 2)
      : edge === "top" ? outer.y + margin : outer.y + outer.height - margin - height;
    this.#app.setBounds({ x, y, width, height, physical: true });
  }

  /**
   * Docks the window as an AppBar on the bottom edge, `thickness` logical px reserved and the window
   * `overlap` px over the app above. Only a new thickness or overlap docks again: every ABM_SETPOS
   * makes Explorer recompute the work area and move windows. app.appBar reaches Explorer's
   * Shell_TrayWnd past the dock's own tray host, re-docks on ABN_POSCHANGED and moves the window
   * without touching its z-order (behind a full-screen app it stays behind).
   */
  #dock(edge: TaskbarEdge, thickness: number, overlap: number) {
    if (thickness === this.#reserved && overlap === this.#overlap && edge === this.#reservedEdge) return;
    this.#reserved = thickness;
    this.#overlap = overlap;
    this.#reservedEdge = edge;
    this.#app.appBar(edge, { size: thickness, overlap });
  }

  #reservedEdge: TaskbarEdge = "bottom";

  #unreserve() {
    if (this.#reserved <= 0) return;
    this.#reserved = -1;
    this.#lostChecks = 0;
    clearTimeout(this.#redock);
    this.#app.appBar(null);
  }

  #hideTaskbar() {
    if (this.#taskbar) return;
    const tray = explorerTray();
    if (!tray) return;
    const snapshot = join(configDir, "taskbar-state.json");
    try {
      // Exclusive creation preserves the first clean snapshot across crashes/restarts.
      writeFileSync(snapshot, String(taskbarState()), { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const state = Number(readFileSync(snapshot, "utf8"));
    if (!Number.isInteger(state) || state < 0 || state > 3) throw new Error("Invalid taskbar state snapshot");
    this.#taskbar = { hwnd: tray, state };
    this.#startWatchdog(this.#taskbar.state);
    const want = this.#hiddenState();
    if (taskbarState() !== want) setTaskbarState(want);
    showWindow(tray, SW_HIDE);
  }

  /**
   * A helper outside this process that brings the taskbar back when the dock dies, even when it
   * is killed or crashes. It is started through WMI so it is not part of this process's job.
   */
  #startWatchdog(state: number) {
      if (this.#watchdog) return;
      this.#watchdog = true;
      try {
        const script = join(configDir, "restore-taskbar.ps1");
        writeFileSync(script, restoreScript);
        const command = `powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${script}" -dockPid ${process.pid} -state ${state} -dockHwnd ${this.#hwnd} -stateFile "${join(configDir, "taskbar-state.json")}"`;
        // Wait for and validate the launcher: detached/ignored-stdio PowerShell can exit without a helper.
      // WMI rejects CreateFlags here (return 21); ShowWindow=0 hides the independent watchdog.
        void output([
          "powershell.exe", "-NoProfile", "-Command",
          `$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }; ` +
          `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${command.replace(/'/g, "''")}'; ProcessStartupInformation = $si } | ConvertTo-Json -Compress`,
        ]).then(({ code, stdout }) => {
              if (code !== 0 || JSON.parse(stdout).ReturnValue !== 0) throw new Error(`Watchdog launch failed: ${code} ${stdout}`);
        }).catch(error => console.error("[dock] watchdog", error));
      } catch (error) {
        console.error("[dock] watchdog", error);
      }
  }

  #restoreTaskbar() {
    if (!this.#taskbar) return;
    setTaskbarState(this.#taskbar.state);
    showWindow(this.#taskbar.hwnd, SW_SHOWNA);
    this.#restored = this.#taskbar.hwnd;
    this.#taskbar = null;
    rmSync(join(configDir, "taskbar-state.json"), { force: true });
  }

  #shellFullscreen = false;
  /** Explorer's taskbar, just shown again by #restoreTaskbar. */
  #restored: HWND | null = null;

  /**
   * After quitting: Explorer hides its taskbar once more a moment after ABM_SETSTATE turns
   * auto-hide off (measured: hidden again within 150 ms, then left hidden), so the restore is
   * repeated until it holds. Call after dispose(), before the process exits.
   */
  async settleTaskbar(ms = 900) {
    const tray = this.#restored;
    if (!tray) return;
    for (let waited = 0; waited < ms; waited += 50) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (!isWindowVisible(tray)) showWindow(tray, SW_SHOWNA);
    }
  }

  /** Explorer's ABN_FULLSCREENAPP for this screen (see shell-events.ts). */
  setShellFullscreen(on: boolean) {
    this.#shellFullscreen = on;
    this.checkFullscreen();
  }

  /**
   * Gets out of the way of a full-screen window as soon as one takes the screen, and comes back
   * over it while Start, Search, a taskbar flyout or Task View is in front, as Explorer's taskbar
   * does. Driven by shell events (full-screen notice, foreground change, foreground window resized).
   *
   * Explorer drops its taskbar to the bottom of the z-order and raises it again for Start; raising
   * a window above the app in front takes foreground rights only the shell has (measured: the
   * dock's HWND_TOPMOST was ignored, it stayed under the app and lost "always on top" for good).
   * So the dock stays on top and is cloaked instead (not drawn, no input, AppBar kept: a hidden
   * AppBar loses its strip, windows grow over it and look full-screen themselves).
   */
  checkFullscreen() {
    if (this.#disposed) return false;
    const fullscreen = !shellSurfaceInFront() && ((this.#shellFullscreen && this.#foregroundOnOwnScreen()) || fullscreenAppActive(this.#hwnd));
    if (fullscreen !== this.#hiddenForFullscreen) {
      this.#hiddenForFullscreen = fullscreen;
      // Nothing the dock draws can be seen now: pollers and timers rest until it returns.
      setDockCovered(fullscreen);
      cloak(this.#hwnd, fullscreen);
      // With the dock still on top, Explorer does not take the app for full screen and shows its
      // own taskbar over it: it stays hidden in full screen too.
      this.#rehideTaskbar();
    }
    return fullscreen;
  }

  /** ABN_FULLSCREENAPP does not say which monitor: only the dock's own screen counts. */
  #foregroundOnOwnScreen() {
    const fg = foregroundWindow();
    if (!fg) return false;
    const a = monitorOf(fg).monitor;
    const b = monitorOf(this.#hwnd).monitor;
    return a.left === b.left && a.top === b.top;
  }

  /**
   * Explorer showing its taskbar again (Start menu, notifications) and Explorer restarting. The
   * AppBar itself is docked again by app.appBar on TaskbarCreated (Tarve 0.13.4); a reservation that
   * still went missing is caught by #verifyReservation. Screens and work areas come from
   * app.onScreensChange, full screen from the shell events in main.tsx.
   */
  #onShellEvent(event: ShellEvent) {
          if (this.#disposed) return;
          if (event.type === "trayShown" || event.type === "explorerRestarted") this.#rehideTaskbar();
          // Restart, shut down or log off: Windows kills the dock (and its watchdog) without an exit, and
          // Explorer keeps the auto-hide state across the restart (StuckRects3), so the next session had no
          // taskbar at all until the dock started again. Put Explorer's own state back now, while it still
          // runs: the next session starts with Windows' taskbar, which the dock hides when it starts.
          if (event.type === "sessionEnd") this.#restoreTaskbar();
  }

  /** Releases the AppBar and docks it anew after a short pause, so Explorer is ready for AppBars. */
  #reregister() {
    this.#unreserve();
    this.#redock = setTimeout(() => void this.layout(), 1500);
  }

  /**
   * The state the hidden taskbar is kept in: auto-hide at the bottom, so the dock's own AppBar
   * takes the strip; elsewhere Windows ignores auto-hide (Settings says so too), so there it stays
   * in the user's state without auto-hide and keeps its strip, which the dock covers.
   */
  #hiddenState() {
    const state = this.#taskbar?.state ?? 0;
    return this.#options.edge === "bottom" ? ABS_AUTOHIDE : state & ~ABS_AUTOHIDE;
  }

  /** Explorer shows the taskbar again on its own (Start menu, notifications, Explorer restart). */
  #rehideTaskbar(force = false) {
    if (!this.#taskbar) return;
    const tray = explorerTray();
    if (tray && tray !== this.#taskbar.hwnd) this.#taskbar.hwnd = tray;
    if (tray && (force || isWindowVisible(tray))) {
      // ABM_SETSTATE is synchronous (up to ~0.5 s) and makes Explorer lay its taskbar out again,
      // which shows it once more: set it only when the auto-hide bit differs, or the two keep
      // answering each other (26 rounds in 30 s while the widgets window opened).
      const want = this.#hiddenState();
      if ((taskbarState() & ABS_AUTOHIDE) !== (want & ABS_AUTOHIDE)) setTaskbarState(want);
      // Async: a plain ShowWindow on Explorer's window waits for its busy thread (up to ~300 ms).
      showWindowAsync(tray, SW_HIDE);
    }
  }

  /**
   * Checks, on every screens change, that the strip is really reserved: the work area must end
   * where the strip starts. Explorer re-docks moved bars itself (ABN_POSCHANGED); one that dropped
   * the AppBar gets it registered anew, twice at most until the reservation holds again.
   */
  async #verifyReservation() {
    if (this.#reserved <= 0 || this.#disposed || this.#hiddenForFullscreen) return;
    const screen = await this.#app.screen().catch(() => undefined);
    if (!screen || this.#reserved <= 0 || this.#disposed) return;
    const r = windowRect(this.#hwnd);
    const over = Math.round(this.#overlap * screen.scale);
    const w = screen.workArea;
    const edge = this.#reservedEdge;
    // The work area must end where the strip starts.
    const ok =
      edge === "bottom" ? Math.abs(w.y + w.height - (r.top + over)) <= 1
      : edge === "top" ? Math.abs(w.y - r.bottom) <= 1
      : edge === "left" ? Math.abs(w.x - r.right) <= 1
      : Math.abs(w.x + w.width - r.left) <= 1;
    this.#lostChecks = ok ? 0 : this.#lostChecks + 1;
    if (!ok && this.#lostChecks <= 2) this.#reregister();
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#offShell();
    this.#offScreens();
    clearTimeout(this.#redock);
    try {
      this.#unreserve();
    } catch {
      // The window is already gone, and its AppBar with it.
    }
    this.#restoreTaskbar();
  }

    /** The first of `ids` whose dock node holds the point (window coordinates, logical px), or null. */
      static nodeAt(ids: readonly string[], x: number, y: number): string | null {
        const dock = DockWindow.#current;
        if (!dock) return null;
        const boxes = dock.#app.layout([...ids]);
        for (const id of ids) {
          const b = boxes?.[id];
          if (b && x >= b.x && x < b.x + b.borderWidth && y >= b.y && y < b.y + b.borderHeight) return id;
        }
        return null;
      }
}
