import { resolve } from "node:path";
import { output } from "../runtime/proc";

/** "Start with Windows" through the per-user Run key, like most tray apps. */
const KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const NAME = "WindowsBar";

/** The built exe starts itself; under bun (development) the script is passed too. */
function command() {
  const exe = process.execPath;
  return /\\(?:bun|node|tjs)(\.exe)?$/i.test(exe) && process.argv[1] ? `"${exe}" "${resolve(process.argv[1])}"` : `"${exe}"`;
}

export async function setAutostart(on: boolean): Promise<void> {
  const args = on
    ? ["reg.exe", "add", KEY, "/v", NAME, "/t", "REG_SZ", "/d", command(), "/f"]
    : ["reg.exe", "delete", KEY, "/v", NAME, "/f"];
  // Awaited: the installer runs "--autostart on|off" and the process exits right after.
  await output(args);
}

export async function readAutostart(): Promise<boolean> {
  const { code, stdout } = await output(["reg.exe", "query", KEY, "/v", NAME]);
  return code === 0 && stdout.includes(NAME);
}
