// Micro-benchmark of the native calls the dock repeats on timers: `bun scripts/bench-ticks.ts`.
// Prints the mean cost per call and the CPU each timer costs per second at its interval.
import { dlopen } from "../src/native/ffi";
import { exePathOf, foregroundWindow, fullscreenAppActive, listTaskbarWindows, powerStatus, windowPid } from "../src/native/win32";
import { keyboardLayout, readNetwork, readVolume } from "../src/native/status";
import { readExplorerButtons } from "../src/native/taskbar-buttons";

const U = dlopen("user32.dll", {
  PeekMessageW: { args: ["ptr", "ptr", "u32", "u32", "u32"], returns: "i32" },
  GetQueueStatus: { args: ["u32"], returns: "u32" },
}).symbols;
const msg = new Uint8Array(48);
const S = dlopen("shell32.dll", { SHQueryUserNotificationState: { args: ["ptr"], returns: "i32" } }).symbols;
const quns = new Uint8Array(4);

function bench(name: string, everyMs: number, fn: () => unknown, iterations = 200) {
  for (let i = 0; i < 5; i++) fn();
  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  const per = (performance.now() - t0) / iterations;
  const load = (per * (1000 / everyMs)) / 10; // % of one core
  return { name, everyMs, "µs/call": Math.round(per * 1000), "% core": Number(load.toFixed(3)) };
}

const fg = foregroundWindow();
const rows = [
  bench("tray pump 5× PeekMessage (8 ms)", 8, () => { for (let i = 0; i < 5; i++) U.PeekMessageW(msg, null, 0x7fff0000, 0x7fff0000, 0); }, 2000),
  bench("GetQueueStatus (gate)", 16, () => U.GetQueueStatus(0x4ff), 2000),
  bench("foregroundWindow+windowPid", 100, () => windowPid(foregroundWindow()!), 2000),
  bench("exePathOf (uncached)", 100, () => exePathOf(windowPid(fg!))),
  bench("fullscreenAppActive", 2000, () => fullscreenAppActive(null)),
  bench("SHQueryUserNotificationState", 2000, () => S.SHQueryUserNotificationState(quns)),
  bench("listTaskbarWindows", 2000, () => listTaskbarWindows(), 50),
  bench("readExplorerButtons", 2000, () => readExplorerButtons(), 20),
  bench("readNetwork", 1000, () => readNetwork(), 50),
  bench("readVolume", 1000, () => readVolume(), 50),
  bench("powerStatus", 1000, () => powerStatus(), 500),
  bench("keyboardLayout", 400, () => keyboardLayout(fg), 200),
];
console.table(rows);
console.log("explorer buttons:", JSON.stringify(readExplorerButtons()));
process.exit(0);
