import { store } from "@tarve/core";
import { config } from "../config";
import { output } from "../runtime/proc";

/** Windows taskbar settings the dock mirrors (Settings > Personalization > Taskbar). */
export const taskbarPrefs = store({
  /** Taskbar behaviors > Taskbar alignment. */
  align: "center" as "center" | "left",
  /** Windows accent colour (Personalization > Colors), for the active-app indicator. */
  accent: "#0a84ff",
});

async function readAccent(): Promise<string | null> {
  const { stdout: out } = await output(["reg.exe", "query", "HKCU\\Software\\Microsoft\\Windows\\DWM", "/v", "AccentColor"]);
  const m = /AccentColor\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(out);
  if (!m) return null;
  // Stored as 0xAABBGGRR.
  const v = parseInt(m[1]!, 16);
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  return `#${hex(v & 0xff)}${hex((v >> 8) & 0xff)}${hex((v >> 16) & 0xff)}`;
}

async function readAlignment(): Promise<"center" | "left"> {
  const { stdout: out } = await output(["reg.exe", "query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced", "/v", "TaskbarAl"]);
  // TaskbarAl: 0 = left, 1 or missing = centre (the Windows 11 default).
  return /TaskbarAl\s+REG_DWORD\s+0x0\b/i.test(out) ? "left" : "center";
}

export function watchTaskbarPrefs() {
  const tick = async () => {
    try {
      const align = await readAlignment();
      if (align !== taskbarPrefs.align) taskbarPrefs.align = align;
      const accent = await readAccent();
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
