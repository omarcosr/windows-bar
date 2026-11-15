import { store } from "@tarve/core";

/** Windows taskbar settings the dock mirrors (Settings > Personalization > Taskbar). */
export const taskbarPrefs = store({
  /** Taskbar behaviors > Taskbar alignment. */
  align: "center" as "center" | "left",
});

async function readAlignment(): Promise<"center" | "left"> {
  const proc = Bun.spawn(
    ["reg.exe", "query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced", "/v", "TaskbarAl"],
    {
      stdout: "pipe",
      stderr: "ignore",
      windowsHide: true,
    },
  );
  const out = await new Response(proc.stdout).text();
  // TaskbarAl: 0 = left, 1 or missing = centre (the Windows 11 default).
  return /TaskbarAl\s+REG_DWORD\s+0x0\b/i.test(out) ? "left" : "center";
}

export function watchTaskbarPrefs() {
  const tick = async () => {
    try {
      const align = await readAlignment();
      if (align !== taskbarPrefs.align) taskbarPrefs.align = align;
    } catch (error) {
      console.error("[taskbar-prefs]", error);
    }
  };
  tick();
  setInterval(tick, 5000);
}
