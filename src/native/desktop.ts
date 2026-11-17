import { CFunction, dlopen, read } from "./ffi";
import { explorerTray } from "./win32";

const user32 = dlopen("user32.dll", {
  SendMessageTimeoutW: { args: ["ptr", "u32", "u64", "i64", "u32", "u32", "ptr"], returns: "i64" },
});
const ole32 = dlopen("ole32.dll", {
  CoInitializeEx: { args: ["ptr", "u32"], returns: "i32" },
  CoUninitialize: { args: [], returns: "void" },
  CLSIDFromString: { args: ["ptr", "ptr"], returns: "i32" },
  CoCreateInstance: { args: ["ptr", "ptr", "u32", "ptr", "ptr"], returns: "i32" },
});

function guid(value: string) {
  const wide = new Uint8Array((value.length + 1) * 2);
  const view = new DataView(wide.buffer);
  for (let i = 0; i < value.length; i++) view.setUint16(i * 2, value.charCodeAt(i), true);
  const result = new Uint8Array(16);
  if (ole32.symbols.CLSIDFromString(wide, result) < 0) throw new Error("Invalid shell GUID");
  return result;
}

/** Fallback through IShellDispatch4; CFunction uses Tarve's pointerFunction bridge. */
function toggleDesktopCom(): boolean {
  const initialized = ole32.symbols.CoInitializeEx(null, 2 /* COINIT_APARTMENTTHREADED */);
  // An existing MTA is fine too (RPC_E_CHANGED_MODE); do not uninitialize its apartment.
  if (initialized < 0 && initialized !== -2147417850) return false;
  try {
    const out = new Uint8Array(8);
    if (ole32.symbols.CoCreateInstance(
      guid("{13709620-C279-11CE-A49E-444553540000}"), null, 5 /* CLSCTX_INPROC_SERVER | CLSCTX_LOCAL_SERVER */,
      guid("{EFD84B2D-4BCF-4298-BE25-EB542A59FBDA}"), out,
    ) < 0) return false;
    const object = Number(new DataView(out.buffer).getBigUint64(0, true));
    if (!object) return false;
    const table = read.ptr(object)!;
    const release = new CFunction({ ptr: read.ptr(table, 2 * 8)!, args: ["ptr"], returns: "u32" });
    try {
      // IDispatch (7), IShellDispatch (23), IShellDispatch2 (9), IShellDispatch3 (1), WindowsSecurity (1).
      const toggle = new CFunction({ ptr: read.ptr(table, 41 * 8)!, args: ["ptr"], returns: "i32" });
      try { return toggle(object) >= 0; } finally { toggle.close(); }
    } finally {
      release(object);
      release.close();
    }
  } finally {
    if (initialized >= 0) ole32.symbols.CoUninitialize();
  }
}

/** Toggle the Explorer desktop without synthetic keyboard input or our own tray host. */
export function toggleDesktop(): boolean {
  try {
    const tray = explorerTray();
    const result = new Uint8Array(8);
    // WM_COMMAND 407. Success is delivery, not LRESULT (which is normally zero).
    if (tray && user32.symbols.SendMessageTimeoutW(tray, 0x111, 407n, 0n,
      0x2 | 0x20 /* SMTO_ABORTIFHUNG | SMTO_ERRORONEXIT */, 500, result)) return true;
    return toggleDesktopCom();
  } catch (error) {
    console.error("[desktop] Não foi possível alternar a área de trabalho", error);
    return false;
  }
}
