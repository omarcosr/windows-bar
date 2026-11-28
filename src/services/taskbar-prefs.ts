import { store } from "@tarve/core";
import { config } from "../config";
import { readUserValue } from "../native/shell-item";
import { ABS_AUTOHIDE, explorerTray, taskbarState, windowRect } from "../native/win32";
import { systemScale } from "../native/shell-icon";
import { onShellEvent, onWatchChange, SPI_SETWORKAREA } from "../native/shell-events";

/** How the taskbar combines buttons: 0 always, 1 when the taskbar is full, 2 never. */
export type GlomLevel = 0 | 1 | 2;

/** TaskbarGlomLevel / MMTaskbarGlomLevel in Explorer\Advanced; missing means 0 (always combine). */
function readGlom(name: "TaskbarGlomLevel" | "MMTaskbarGlomLevel"): GlomLevel {
  const v = readUserValue("Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced", name, "dword");
  return v === 1 || v === 2 ? v : 0;
}


/** Windows taskbar settings the dock mirrors (Settings > Personalization > Taskbar). */
export const taskbarPrefs = store({
  /** Taskbar behaviors > Taskbar alignment. */
  align: "center" as "center" | "left",
  /** Windows accent colour (Personalization > Colors), for the active-app indicator. */
  accent: "#0a84ff",
  /** Height of Explorer's taskbar in logical px (48 on Windows 11), which the dock takes by default. */
  height: 48,
  /** Taskbar items > Search: 0 hidden, 1 icon, 2 box, 3 icon and label (SearchboxTaskbarMode). */
  search: 1 as 0 | 1 | 2 | 3,
  /** System > For developers > End task: "Encerrar tarefa" in the taskbar's right-click menu. */
  endTask: false,
  /** Taskbar behaviors > Taskbar location: the screen edge the bar sits on. */
  edge: "bottom" as TaskbarEdge,
  /**
   * Taskbar behaviors > "Show my taskbar apps on": all desktops (VirtualDesktopTaskbarFilter 0)
   * or only the desktop in use (1, or missing: the default).
   */
  allDesktops: false,
  /** Multiple displays > Show my taskbar on all displays (MMTaskbarEnabled). */
  mmEnabled: false,
  /**
   * Multiple displays > When using multiple displays, show my taskbar apps on (MMTaskbarMode):
   * 0 all taskbars, 1 the main taskbar and the one where the window is open, 2 only the taskbar
   * where the window is open.
   */
  mmMode: 0 as 0 | 1 | 2,
  /**
   * Taskbar behaviors > Combine taskbar buttons and hide labels (TaskbarGlomLevel): 0 always
   * (one icon per app, the default), 1 when the taskbar is full, 2 never (one labelled button per window).
   */
  glom: 0 as GlomLevel,
  /** The same, for the taskbars on the other displays (MMTaskbarGlomLevel). */
  mmGlom: 0 as GlomLevel,
});

export type TaskbarEdge = "left" | "top" | "right" | "bottom";
const EDGES: readonly TaskbarEdge[] = ["left", "top", "right", "bottom"];

/**
 * Where Windows puts its taskbar: Explorer\Advanced\TaskbarLocation (0 left, 1 top, 2 right,
 * 3 bottom, the ABE_* numbers), else byte 12 of StuckRects3\Settings, where older builds keep it.
 */
function readEdge(): TaskbarEdge {
  const v = readUserValue("Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced", "TaskbarLocation", "dword");
  if (typeof v === "number" && EDGES[v]) return EDGES[v]!;
  const stuck = readUserValue("Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StuckRects3", "Settings", "binary");
  if (stuck instanceof Uint8Array && stuck.length > 12 && EDGES[stuck[12]!]) return EDGES[stuck[12]!]!;
  return "bottom";
}

/** The edge the dock sits on: the one Windows' taskbar is set to. */
export function dockEdge(): TaskbarEdge {
  return taskbarPrefs.edge;
}

/** A dock on the left or right edge: a column instead of a row. */
export function dockVertical() {
  const edge = taskbarPrefs.edge;
  return edge === "left" || edge === "right";
}

function readEndTask(): boolean {
  return readUserValue("Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced\\TaskbarDeveloperSettings", "TaskbarEndTask", "dword") === 1;
}

function readSearchMode(): 0 | 1 | 2 | 3 {
  const v = readUserValue("Software\\Microsoft\\Windows\\CurrentVersion\\Search", "SearchboxTaskbarMode", "dword");
  return v === 0 || v === 1 || v === 2 || v === 3 ? v : 1;
}

/**
 * The thickness Windows gives its taskbar (height, or width on a side edge), measured on Explorer's
 * own taskbar window (it keeps its size while the dock hides it). An auto-hidden taskbar is a
 * sliver: then the last thickness stands.
 */
function readTaskbarHeight(edge: TaskbarEdge): number | null {
  // Hidden by the dock at the bottom, the taskbar is only measurable mid-relayout (a theme change
  // shows it for a moment at a passing size): each new value would move the reserved strip, and
  // every work-area change stalls the window manager. The size measured before it was hidden (at
  // start, before the dock hides it) stands.
  if (heightMeasured && edge === "bottom" && (config.hideNativeTaskbar || config.mode === "full")) return null;
  const tray = explorerTray();
  if (!tray || taskbarState() & ABS_AUTOHIDE) return null;
  const rect = windowRect(tray);
  const side = edge === "left" || edge === "right";
  const height = Math.round((side ? rect.right - rect.left : rect.bottom - rect.top) / systemScale());
  if (height < 32 || height > 120) return null;
  heightMeasured = true;
  return height;
}
let heightMeasured = false;

function readAccent(): string | null {
  const v = readUserValue("Software\\Microsoft\\Windows\\DWM", "AccentColor", "dword");
  if (typeof v !== "number") return null;
  // Stored as 0xAABBGGRR.
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  return `#${hex(v & 0xff)}${hex((v >> 8) & 0xff)}${hex((v >> 16) & 0xff)}`;
}

function readAlignment(): "center" | "left" {
  // TaskbarAl: 0 = left, 1 or missing = centre (the Windows 11 default).
  return readUserValue("Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced", "TaskbarAl", "dword") === 0 ? "left" : "center";
}

const prefsListeners = new Set<() => void>();

/** Runs `fn` after a taskbar setting the dock mirrors changed; returns the unsubscribe function. */
export function onTaskbarPrefsChange(fn: () => void): () => void {
  prefsListeners.add(fn);
  return () => prefsListeners.delete(fn);
}

let watching = false;

/**
 * Reads the settings now and again whenever Windows says they changed: the registry keys they
 * live in (Explorer\Advanced, Search, DWM), WM_SETTINGCHANGE ("TraySettings",
 * "ImmersiveColorSet") and display/DPI changes for the taskbar's height. Nothing is polled.
 */
export function watchTaskbarPrefs() {
  if (watching) return;
  watching = true;
  const tick = () => {
    let changed = false;
    const set = <K extends keyof typeof taskbarPrefs>(key: K, value: (typeof taskbarPrefs)[K] | null) => {
      if (value === null || value === taskbarPrefs[key]) return;
      taskbarPrefs[key] = value;
      changed = true;
    };
    try {
      set("align", readAlignment());
      set("edge", readEdge());
      set("height", readTaskbarHeight(taskbarPrefs.edge));
      set("accent", readAccent());
      set("search", readSearchMode());
      set("endTask", readEndTask());
      set("allDesktops", readUserValue("Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced", "VirtualDesktopTaskbarFilter", "dword") === 0);
      set("mmEnabled", readMultiMonEnabled());
      set("mmMode", readMultiMonMode());
      set("glom", readGlom("TaskbarGlomLevel"));
      set("mmGlom", readGlom("MMTaskbarGlomLevel"));
    } catch (error) {
      console.error("[taskbar-prefs]", error);
    }
    if (changed) for (const fn of prefsListeners) fn();
  };
  tick();
  onWatchChange(["advanced", "search", "dwm"], tick);
  let settle: ReturnType<typeof setTimeout> | undefined;
  onShellEvent((event) => {
    const relevant =
      event.type === "display" ||
      event.type === "explorerRestarted" ||
      (event.type === "setting" && (event.area === "TraySettings" || event.area === "ImmersiveColorSet" || event.action === SPI_SETWORKAREA));
    if (!relevant) return;
    clearTimeout(settle);
    // Explorer resizes its taskbar a moment after announcing the change.
    settle = setTimeout(tick, 300);
  });
}

/** The dock's alignment: the user's choice, or Windows' own when set to follow it. */
export function dockAlign(): "center" | "left" {
  return config.align === "center" || config.align === "left" ? config.align : taskbarPrefs.align;
}
/** Explorer\Advanced\MMTaskbarEnabled: 1 shows Explorer's taskbar on every display (Windows 11 default on). */
function readMultiMonEnabled(): boolean {
  return readUserValue("Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced", "MMTaskbarEnabled", "dword") === 1;
}
/** Explorer\Advanced\MMTaskbarMode (0 missing = all taskbars). */
function readMultiMonMode(): 0 | 1 | 2 {
  const v = readUserValue("Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced", "MMTaskbarMode", "dword");
  return v === 1 || v === 2 ? v : 0;
}
/**
 * The dock stands in for the main taskbar, which Explorer keeps on the primary display; the other
 * displays keep Explorer's secondary taskbars. With "only the taskbar where the window is open"
 * (MMTaskbarEnabled=1, MMTaskbarMode=2) the main taskbar lists only the windows on its display,
 * so the dock does the same. Modes 0 and 1 list every window on the main taskbar.
 */
export function buttonsOnOwnDisplayOnly(): boolean {
  return taskbarPrefs.mmEnabled && taskbarPrefs.mmMode === 2;
}
