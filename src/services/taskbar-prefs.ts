import { store } from "@tarve/core";
import { config } from "../config";
import { readUserValue } from "../native/shell-item";
import { ABS_AUTOHIDE, explorerTray, taskbarState, windowRect } from "../native/win32";
import { systemScale } from "../native/shell-icon";
import { onShellEvent, onWatchChange, SPI_SETWORKAREA } from "../native/shell-events";

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
  const tray = explorerTray();
  if (!tray || taskbarState() & ABS_AUTOHIDE) return null;
  const rect = windowRect(tray);
  const side = edge === "left" || edge === "right";
  const height = Math.round((side ? rect.right - rect.left : rect.bottom - rect.top) / systemScale());
  return height >= 32 && height <= 120 ? height : null;
}

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
