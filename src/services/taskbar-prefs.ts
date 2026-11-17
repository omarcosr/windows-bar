import { store } from "@tarve/core";
import { config } from "../config";
import { readUserValue } from "../native/shell-item";
import { ABS_AUTOHIDE, explorerTray, taskbarState, windowRect } from "../native/win32";
import { systemScale } from "../native/shell-icon";

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
});

function readSearchMode(): 0 | 1 | 2 | 3 {
  const v = readUserValue("Software\\Microsoft\\Windows\\CurrentVersion\\Search", "SearchboxTaskbarMode", "dword");
  return v === 0 || v === 1 || v === 2 || v === 3 ? v : 1;
}

/**
 * The height Windows gives its taskbar, measured on Explorer's own taskbar window (it keeps its
 * size while the dock hides it). An auto-hidden taskbar is a sliver: then the last height stands.
 */
function readTaskbarHeight(): number | null {
  const tray = explorerTray();
  if (!tray || taskbarState() & ABS_AUTOHIDE) return null;
  const rect = windowRect(tray);
  const height = Math.round((rect.bottom - rect.top) / systemScale());
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

export function watchTaskbarPrefs() {
  const tick = () => {
    try {
      const align = readAlignment();
      if (align !== taskbarPrefs.align) taskbarPrefs.align = align;
      const height = readTaskbarHeight();
      if (height && height !== taskbarPrefs.height) taskbarPrefs.height = height;
      const accent = readAccent();
      if (accent && accent !== taskbarPrefs.accent) taskbarPrefs.accent = accent;
    } catch (error) {
      console.error("[taskbar-prefs]", error);
    }
  };
  tick();
  setInterval(tick, 5000);
}

/** The dock's alignment: the user's choice, or Windows' own when set to follow it. */
export function dockAlign(): "center" | "left" {
  return config.align === "center" || config.align === "left" ? config.align : taskbarPrefs.align;
}
