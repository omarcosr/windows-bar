import type { AppHandle, ScreenInfo } from "@tarve/core";
import { dlopen, type Pointer } from "bun:ffi";
import {
  monitorOf,
  placeWindow,
  ABE_BOTTOM,
  ABS_AUTOHIDE,
  appBarQuery,
  appBarRegister,
  appBarRemove,
  appBarSetPos,
  explorerTray,
  fullscreenAppActive,
  isWindowVisible,
  setTaskbarState,
  showWindow,
  setBehind,
  foregroundWindow,
  SW_HIDE,
  SW_SHOWNA,
  taskbarState,
  windowRect,
  type HWND,
  type Rect,
} from "./win32";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { configDir } from "../config";
import restoreScript from "../../scripts/restore-taskbar.ps1" with { type: "text" };

const dwmapi = dlopen("dwmapi.dll", {
  DwmSetWindowAttribute: { args: ["ptr", "u32", "ptr", "u32"], returns: "i32" },
});

/** Stays visible while a window is peeked from the preview, like the real taskbar. */
function excludeFromPeek(hwnd: HWND) {
  const DWMWA_EXCLUDED_FROM_PEEK = 12;
  dwmapi.symbols.DwmSetWindowAttribute(hwnd, DWMWA_EXCLUDED_FROM_PEEK, new Uint32Array([1]), 4);
}

/** The dock's base height in logical px; edit-mode badges never grow the reserved strip. */

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
}

/**
 * Owns the native side of the dock window: reserves the strip as an AppBar (the window then
 * covers it), or sizes a free dock to its content at the bottom of its monitor, and optionally
 * hides the Windows taskbar.
 */
export class DockWindow {
  #app: AppHandle;
  #hwnd: HWND;
  #options: DockWindowOptions;
  #size = { width: 0, height: 0 };
  /** Logical thickness of the current AppBar, or -1 while not docked. */
  #reserved = -1;
  #scale = 1;
  #layoutRun = 0;
  #taskbar: { hwnd: HWND; state: number } | null = null;
  #hiddenForFullscreen = false;
  #timer: ReturnType<typeof setInterval>;
  #ticks = 0;
  #lostChecks = 0;
  #win32Registered = false;
  #granted: Rect | null = null;
  #watchdog = false;
  #disposed = false;

  private constructor(app: AppHandle, hwnd: HWND, options: DockWindowOptions) {
    this.#app = app;
    this.#hwnd = hwnd;
    this.#options = options;
    excludeFromPeek(hwnd);
    this.#timer = setInterval(() => this.#watch(), 250);
    if (DockWindow.#hidesTaskbar(options)) this.#hideTaskbar();
    const cleanup = () => this.dispose();
    process.once("exit", cleanup);
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      process.once(signal, () => {
        cleanup();
        process.exit(0);
      });
    }
    this.layout();
  }

  static #current: DockWindow | null = null;
  static handle(): HWND | null {
    const dock = DockWindow.#current;
    return dock ? dock.#hwnd : null;
  }

  /** The dock's top edge in physical screen px, for anchoring popup menus. */
  static topEdge(): number | null {
    const dock = DockWindow.#current;
    if (!dock) return null;
    // A docked floating dock sits inside its strip, below the top margin.
    const inset = dock.#reserved > 0 && dock.#options.mode === "floating" ? Math.round(dock.#options.bottomMargin * dock.#scale) : 0;
    return windowRect(dock.#hwnd).top + inset;
  }

  /** Horizontal centre of a dock node (by id), in physical screen px; null if it is not laid out. */
  static nodeCenterX(id: string): number | null {
    const dock = DockWindow.#current;
    if (!dock) return null;
    const box = dock.#app.layout([id])?.[id];
    if (!box) return null;
    return windowRect(dock.#hwnd).left + (box.x + box.borderWidth / 2) * dock.#scale;
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
    const screen = await this.#screen();
    if (run !== this.#layoutRun || this.#disposed) return;
    if (screen) this.#scale = screen.scale;

    if (this.#options.reserveSpace) {
      // Not before the first render: the strip's thickness depends on the dock's size.
      if (!this.#size.width) return;
      // The window spans the reserved strip and the view adds the margins.
      const thickness = this.#options.barHeight + (full ? 0 : this.#options.bottomMargin * 2);
      // The AppBar goes through Win32, not app.appBar: app.appBar's SHAppBarMessage reaches the
      // dock's own tray host (tray-host.ts) instead of Explorer and fails, and it pins the window
      // to the strip, so the strip could not reach over the app above (stripOverlap). Win32 calls
      // are routed past the host by setAppBarRoute. Tested with 0.13.0.
      if (screen) this.#reserveWin32(screen, thickness);
      return;
    }
    this.#unreserve();
    if (!screen || !this.#size.width) return;

    const scale = screen.scale;
    const width = full ? screen.width : Math.ceil(this.#size.width * scale);
    const height = Math.ceil(this.#size.height * scale);
    const margin = full ? 0 : Math.round(this.#options.bottomMargin * scale);
    // With the taskbar hidden the dock takes its place; otherwise it stays above what it reserves.
    const bottom = this.#taskbar ? screen.y + screen.height : screen.workArea.y + screen.workArea.height;
    const x = full ? screen.x : this.#options.align === "left" ? screen.x + margin : screen.x + Math.round((screen.width - width) / 2);
    this.#app.setBounds({ x, y: bottom - margin - height, width, height, physical: true });
  }

  /** Reserves the strip as a Win32 AppBar and places the window on it (from the JS thread). */
  #reserveWin32(screen: ScreenInfo, thickness: number) {
    const px = Math.round(thickness * screen.scale);
    const monitor = { left: screen.x, right: screen.x + screen.width, bottom: screen.y + screen.height };
    if (!this.#win32Registered) {
      appBarRegister(this.#hwnd);
      this.#win32Registered = true;
    }
    let g = this.#granted;
    if (thickness !== this.#reserved || !g) {
      this.#reserved = thickness;
      g = this.#granted = appBarSetPos(this.#hwnd, ABE_BOTTOM, { ...monitor, top: monitor.bottom - px });
    }
    const over = Math.round(this.#options.stripOverlap * screen.scale);
    // SetWindowPos, not setBounds: placing an AppBar through the runtime drops the work-area
    // reservation (tested with 0.13.0); the window must be moved on this thread.
    placeWindow(this.#hwnd, g.left, g.bottom - px - over, g.right - g.left, px + over);
  }

  #unreserve() {
    if (this.#reserved <= 0) return;
    this.#reserved = -1;
    this.#lostChecks = 0;
    if (this.#win32Registered) appBarRemove(this.#hwnd);
    this.#win32Registered = false;
    this.#granted = null;
  }

  /** The monitor the dock is on (its window's centre), else the primary one. */
  async #screen(): Promise<ScreenInfo | null> {
    try {
      const { screens } = await this.#app.screens();
      const r = windowRect(this.#hwnd);
      const cx = (r.left + r.right) / 2;
      const cy = (r.top + r.bottom) / 2;
      return (
        screens.find((s) => cx >= s.x && cx < s.x + s.width && cy >= s.y && cy < s.y + s.height) ??
        screens.find((s) => s.primary) ??
        screens[0] ??
        null
      );
    } catch {
      return null;
    }
  }

  #hideTaskbar() {
    if (this.#taskbar) return;
    const tray = explorerTray();
    if (!tray) return;
    this.#taskbar = { hwnd: tray, state: taskbarState() };
    this.#startWatchdog(this.#taskbar.state);
    setTaskbarState(ABS_AUTOHIDE);
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
      const command = `powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${script}" ${process.pid} ${state}`;
      Bun.spawn(
        [
          "powershell.exe",
          "-NoProfile",
          "-Command",
          `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${command.replace(/'/g, "''")}' } | Out-Null`,
        ],
        { windowsHide: true, stdout: "ignore", stderr: "ignore" },
      );
    } catch (error) {
      console.error("[dock] watchdog", error);
    }
  }

  #restoreTaskbar() {
    if (!this.#taskbar) return;
    setTaskbarState(this.#taskbar.state);
    showWindow(this.#taskbar.hwnd, SW_SHOWNA);
    this.#taskbar = null;
  }

  #shellFullscreen = false;

  /** Explorer's ABN_FULLSCREENAPP for this screen (see shell-events.ts). */
  setShellFullscreen(on: boolean) {
    this.#shellFullscreen = on;
    this.checkFullscreen();
  }

  /**
   * Steps behind a full-screen window as soon as one takes the screen. Driven by shell events
   * (full-screen notice, foreground change, foreground window resized), with a slow safety check.
   */
  checkFullscreen() {
    if (this.#disposed) return false;
    const fullscreen = this.#shellFullscreen || fullscreenAppActive(this.#hwnd);
    if (fullscreen !== this.#hiddenForFullscreen) {
      this.#hiddenForFullscreen = fullscreen;
      // Step behind the full-screen window instead of hiding: a hidden AppBar loses its reserved
      // strip, windows then grow over it, look full-screen themselves and the dock never returns.
      setBehind(this.#hwnd, fullscreen ? foregroundWindow() : null);
    }
    return fullscreen;
  }

  #watch() {
    this.#ticks++;
    // Explorer shows the taskbar again on its own (Start menu, notifications, Explorer restart).
    if (this.#taskbar && !this.#hiddenForFullscreen) {
      const tray = explorerTray();
      if (tray && tray !== this.#taskbar.hwnd) this.#taskbar.hwnd = tray;
      if (tray && isWindowVisible(tray)) {
        setTaskbarState(ABS_AUTOHIDE);
        showWindow(tray, SW_HIDE);
      }
    }
    if (this.#ticks % 8 !== 0) return;
    this.checkFullscreen();
    void this.#verifyReservation();
  }

  /** Checks that the strip is really reserved: the work area must end where the strip starts. */
  async #verifyReservation() {
    if (this.#reserved <= 0 || this.#disposed || this.#hiddenForFullscreen) return;
    const screen = await this.#screen();
    if (!screen || this.#reserved <= 0 || this.#disposed) return;
    const r = windowRect(this.#hwnd);
    const px = Math.round(this.#reserved * screen.scale);
    // From Win32: the work area app.screens() reports does not follow AppBar changes (0.13.0).
    const workBottom = monitorOf(this.#hwnd).work.bottom;
    const over = Math.round(this.#options.stripOverlap * screen.scale);
    const ok = Math.abs(workBottom - (r.top + over)) <= 1 && Math.abs(r.bottom - r.top - px - over) <= 1;
    this.#lostChecks = ok ? 0 : this.#lostChecks + 1;

    // Explorer forgets every AppBar when it restarts: the work area then reaches into our strip.
    if (this.#lostChecks >= 5) {
      this.#unreserve();
      // A short pause before registering again, so Explorer has dropped the old AppBar.
      setTimeout(() => this.layout(), 1500);
      return;
    }
    // The taskbar or another AppBar may have moved our strip; re-reserve only if it changed.
    if (!this.#granted) return;
    const bottom = screen.y + screen.height;
    const want = appBarQuery(this.#hwnd, ABE_BOTTOM, { left: screen.x, right: screen.x + screen.width, top: bottom - px, bottom });
    if (want.bottom !== this.#granted.bottom) {
      this.#granted = null;
      this.layout();
    }
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    clearInterval(this.#timer);
    try {
      this.#unreserve();
    } catch {
      // The window is already gone, and its AppBar with it.
    }
    this.#restoreTaskbar();
  }
}
