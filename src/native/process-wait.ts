import { dlopen } from "./ffi";

const kernel32 = dlopen("kernel32.dll", {
  OpenProcess: { args: ["u32", "i32", "u32"], returns: "ptr" },
  WaitForSingleObject: { args: ["ptr", "u32"], returns: "u32" },
  CloseHandle: { args: ["ptr"], returns: "i32" },
});

const SYNCHRONIZE = 0x100000;

/** Blocks until process `pid` has ended (or `timeoutMs` passes); returns at once when it is gone already. */
export function waitForProcessExit(pid: number, timeoutMs: number) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  const handle = kernel32.symbols.OpenProcess(SYNCHRONIZE, 0, pid);
  if (!handle) return;
  try {
    kernel32.symbols.WaitForSingleObject(handle, timeoutMs);
  } finally {
    kernel32.symbols.CloseHandle(handle);
  }
}
