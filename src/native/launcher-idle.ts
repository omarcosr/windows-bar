import { dlopen } from "./ffi";

/** How long the user has been away: GetLastInputInfo against GetTickCount, as Windows' idle timers do. */

const user32 = dlopen("user32.dll", {
  GetLastInputInfo: { args: ["ptr"], returns: "i32" },
});
const kernel32 = dlopen("kernel32.dll", {
  GetTickCount: { args: [], returns: "u32" },
});

/** Milliseconds since the last keyboard or mouse input in this session; 0 when Windows cannot tell. */
export function idleMs(): number {
  // LASTINPUTINFO: cbSize (u32), dwTime (u32 tick count).
  const info = new Uint32Array([8, 0]);
  if (!user32.symbols.GetLastInputInfo(new Uint8Array(info.buffer))) return 0;
  const now = Number(kernel32.symbols.GetTickCount()) >>> 0;
  // Both wrap every 49.7 days; the unsigned difference stays right across the wrap.
  return ((now - (info[1]! >>> 0)) >>> 0);
}
