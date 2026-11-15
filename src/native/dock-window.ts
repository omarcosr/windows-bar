import {
  ABE_BOTTOM,
  ABS_AUTOHIDE,
  appBarQuery,
  appBarRegister,
  appBarRemove,
  appBarSetPos,
  dpiOf,
  findWindow,
  fullscreenAppActive,
  isWindowVisible,
  monitorOf,
  moveWindow,
  setTaskbarState,
  showWindow,
  stripWindowChrome,
  SW_HIDE,
  SW_SHOWNA,
  taskbarState,
  windowRect,
  type HWND,
} from "./win32";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { configDir } from "../config";
import restoreScript from "../../scripts/restore-taskbar.ps1" with { type: "text" };

export interface DockWindowOptions {
  title: string;
  mode: "floating" | "full";
  /** Windows' own taskbar alignment; a floating dock follows it to the left edge. */
  align: "center" | "left";
  reserveSpace: boolean;
  hideNativeTaskbar: boolean;
  bottomMargin: number;
}

/**
 * Owns the native side of the dock window: sizes it to its content, centres it at the
 * bottom of its monitor, reserves the strip as an AppBar and optionally hides the taskbar.
 */
export class DockWindow {
  #hwnd: HWND;
  #options: DockWindowOptions;
  #size = { width: 0, height: 0 };
  #reservedHeight = -1;
  #registered = false;
  #taskbar: { hwnd: HWND; state: number } | null = null;
  #hiddenForFullscreen = false;
  #timer: ReturnType<typeof setInterval>;
  #ticks = 0;
  #watchdog = false;
  #disposed = false;

  private constructor(hwnd: HWND, options: DockWindowOptions) {
    this.#hwnd = hwnd;
    this.#options = options;
    stripWindowChrome(hwnd);
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
  }

  /** The dock's top edge in physical screen px, for anchoring popup menus. */
  static #current: DockWindow | null = null;
  static handle(): HWND | null {
    const dock = DockWindow.#current;
    return dock ? dock.#hwnd : null;
  }

  static topEdge(): number | null {
    const dock = DockWindow.#current;
    return dock ? windowRect(dock.#hwnd).top : null;
  }

  /** The full-width bar replaces the Windows taskbar, so it always hides it. */
  static #hidesTaskbar(options: DockWindowOptions) {
    return options.hideNativeTaskbar || options.mode === "full";
  }

  static async attach(options: DockWindowOptions): Promise<DockWindow> {
    for (let i = 0; i < 50; i++) {
      const hwnd = findWindow(options.title);
      if (hwnd) return (DockWindow.#current = new DockWindow(hwnd, options));
      await Bun.sleep(40);
    }
    throw new Error(`dock window "${options.title}" not found`);
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
    if (before.reserveSpace && !this.#options.reserveSpace) this.#unreserve();
    this.#reservedHeight = -1;
    this.layout();
  }

  /** Content size in logical px, as reported by the root view's onSize. */
  setContentSize(width: number, height: number) {
    if (width <= 0 || height <= 0) return;
    this.#size = { width, height };
    this.layout();
  }

  layout() {
    if (this.#disposed || !this.#size.width) return;
    const scale = dpiOf(this.#hwnd) / 96;
    const full = this.#options.mode === "full";
    const { monitor, work } = monitorOf(this.#hwnd);
    const width = full ? monitor.right - monitor.left : Math.ceil(this.#size.width * scale);
    const height = Math.ceil(this.#size.height * scale);
    const margin = full ? 0 : Math.round(this.#options.bottomMargin * scale);
    // Without our own reservation, stay above whatever the taskbar reserves.
    let bottom = this.#taskbar ? monitor.bottom : work.bottom;

    if (this.#options.reserveSpace) {
      // Reserve only the dock's base height, so edit-mode badges do not grow the strip.
      const thickness = Math.ceil(64 * scale) + margin * 2; // 64 = dock height
      if (!this.#registered) {
        appBarRegister(this.#hwnd);
        this.#registered = true;
      }
      if (thickness !== this.#reservedHeight) {
        this.#reservedHeight = thickness;
        this.#granted = appBarSetPos(this.#hwnd, ABE_BOTTOM, {
          left: monitor.left,
          right: monitor.right,
          top: monitor.bottom - thickness,
          bottom: monitor.bottom,
        });
      }
      if (this.#granted) bottom = this.#granted.bottom;
    }

    const x = full
      ? monitor.left
      : this.#options.align === "left"
        ? monitor.left + margin
        : monitor.left + (monitor.right - monitor.left - width) / 2;
    const y = bottom - margin - height;
    moveWindow(this.#hwnd, x, y, width, height);
  }

  #granted: { bottom: number } | null = null;

  #unreserve() {
    if (!this.#registered) return;
    appBarRemove(this.#hwnd);
    this.#registered = false;
    this.#granted = null;
  }

  #hideTaskbar() {
    if (this.#taskbar) return;
    const tray = findWindow(null, "Shell_TrayWnd");
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

  #watch() {
    this.#ticks++;
    // Explorer shows the taskbar again on its own (Start menu, notifications, Explorer restart).
    if (this.#taskbar && !this.#hiddenForFullscreen) {
      const tray = findWindow(null, "Shell_TrayWnd");
      if (tray && tray !== this.#taskbar.hwnd) this.#taskbar.hwnd = tray;
      if (tray && isWindowVisible(tray)) {
        setTaskbarState(ABS_AUTOHIDE);
        showWindow(tray, SW_HIDE);
      }
    }
    if (this.#ticks % 4 !== 0) return;
    stripWindowChrome(this.#hwnd); // the runtime may re-apply its frame attributes
    const fullscreen = fullscreenAppActive();
    if (fullscreen !== this.#hiddenForFullscreen) {
      this.#hiddenForFullscreen = fullscreen;
      showWindow(this.#hwnd, fullscreen ? SW_HIDE : SW_SHOWNA);
    }
    // The taskbar or another AppBar may have moved our strip; re-reserve only if it changed.
    if (!fullscreen && this.#registered && this.#granted && this.#size.width) {
      const { monitor } = monitorOf(this.#hwnd);
      const want = appBarQuery(this.#hwnd, ABE_BOTTOM, {
        left: monitor.left,
        right: monitor.right,
        top: monitor.bottom - this.#reservedHeight,
        bottom: monitor.bottom,
      });
      if (want.bottom !== this.#granted.bottom) {
        this.#reservedHeight = -1;
        this.layout();
      }
    }
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    clearInterval(this.#timer);
    this.#unreserve();
    this.#restoreTaskbar();
  }
}
