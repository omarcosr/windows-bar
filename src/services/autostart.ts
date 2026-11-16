import { resolve } from "node:path";

/** "Start with Windows" through the per-user Run key, like most tray apps. */
const KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const NAME = "WindowsBar";

/** The built exe starts itself; under bun (development) the script is passed too. */
function command() {
  const exe = process.execPath;
  return /\\bun(\.exe)?$/i.test(exe) && process.argv[1] ? `"${exe}" "${resolve(process.argv[1])}"` : `"${exe}"`;
}

export function setAutostart(on: boolean) {
  const args = on
    ? ["reg.exe", "add", KEY, "/v", NAME, "/t", "REG_SZ", "/d", command(), "/f"]
    : ["reg.exe", "delete", KEY, "/v", NAME, "/f"];
  Bun.spawn(args, { windowsHide: true, stdout: "ignore", stderr: "ignore" });
}

export async function readAutostart(): Promise<boolean> {
  const proc = Bun.spawn(["reg.exe", "query", KEY, "/v", NAME], { windowsHide: true, stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  return (await proc.exited) === 0 && out.includes(NAME);
}
