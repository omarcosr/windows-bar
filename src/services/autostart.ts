import { resolve } from "node:path";
import { dlopen } from "../native/ffi";
import { decodeWide, encodeWide } from "../native/wide";

/**
 * "Start with Windows" through the per-user Run key, read and written with the registry API.
 * Windows' own switch (Settings > Apps > Startup, Task Manager > Startup apps) lives in
 * StartupApproved\Run: the dock counts as on only when that switch is on too, and turning it on
 * here clears a "disabled" there, so both places always agree.
 */
const advapi32 = dlopen("advapi32.dll", {
  RegGetValueW: { args: ["u64", "ptr", "ptr", "u32", "ptr", "ptr", "ptr"], returns: "i32" },
  RegSetKeyValueW: { args: ["u64", "ptr", "ptr", "u32", "ptr", "u32"], returns: "i32" },
  RegDeleteKeyValueW: { args: ["u64", "ptr", "ptr"], returns: "i32" },
});
const A = advapi32.symbols;

const HKCU = 0xffffffff80000001n;
const RUN = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const APPROVED = "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run";
const NAME = "WindowsBar";
const REG_SZ = 1;
const REG_BINARY = 3;

/** The built exe starts itself; under bun (development) the script is passed too. */
function command() {
  const exe = process.execPath;
  return /\\(?:bun|node|tjs)(\.exe)?$/i.test(exe) && process.argv[1] ? `"${exe}" "${resolve(process.argv[1])}"` : `"${exe}"`;
}

export async function setAutostart(on: boolean): Promise<void> {
  if (on) {
    const value = encodeWide(command());
    A.RegSetKeyValueW(HKCU, encodeWide(RUN), encodeWide(NAME), REG_SZ, value, value.byteLength);
    // 12 bytes, first byte 2 = enabled (3 = disabled by the user in Settings / Task Manager).
    const approved = new Uint8Array(12);
    approved[0] = 2;
    A.RegSetKeyValueW(HKCU, encodeWide(APPROVED), encodeWide(NAME), REG_BINARY, approved, approved.byteLength);
  } else {
    A.RegDeleteKeyValueW(HKCU, encodeWide(RUN), encodeWide(NAME));
    A.RegDeleteKeyValueW(HKCU, encodeWide(APPROVED), encodeWide(NAME));
  }
}

export async function readAutostart(): Promise<boolean> {
  const text = new Uint16Array(1024);
  const size = new Uint32Array([text.byteLength]);
  if (A.RegGetValueW(HKCU, encodeWide(RUN), encodeWide(NAME), 0x2 /* RRF_RT_REG_SZ */, null, new Uint8Array(text.buffer), new Uint8Array(size.buffer)) !== 0) return false;
  if (!decodeWide(text.buffer, 0, Math.max(0, size[0]! - 2))) return false;
  const approved = new Uint8Array(12);
  const approvedSize = new Uint32Array([approved.byteLength]);
  const status = A.RegGetValueW(HKCU, encodeWide(APPROVED), encodeWide(NAME), 0x8 /* RRF_RT_REG_BINARY */, null, approved, new Uint8Array(approvedSize.buffer));
  // No entry yet means enabled; an odd first byte (3) means the user turned it off in Windows.
  return status !== 0 || (approved[0]! & 1) === 0;
}
