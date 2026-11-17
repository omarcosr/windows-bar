import { CFunction, dlopen, ptr, read, runtime } from "../src/native/ffi.ts";
import { encodeWide } from "../src/native/wide.ts";
function check(ok: unknown, label: string): asserts ok { if (!ok) throw new Error(label); }
export function probeTypedArrays() {
  const checks: string[] = [];
  const mark = (ok: unknown, label: string) => { check(ok, label); checks.push(label); };
  const sample = new Uint32Array([1]);
  mark(ptr(sample) === ptr(new Uint8Array(sample.buffer)), "Uint32Array address aliases same bytes");
  const storage = new Uint8Array(32); storage.fill(0xa5);
  const offset = new Int32Array(storage.buffer, 8, 2);
  mark(ptr(offset) === ptr(storage) + 8, "byteOffset address");
  const kernel = dlopen("kernel32.dll", {
    GetCurrentProcessId: { returns: "u32" }, GetSystemTimes: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
    GetModuleHandleW: { args: ["ptr"], returns: "ptr" }, GetProcAddress: { args: ["ptr", "ptr"], returns: "ptr" },
  });
  const user = dlopen("user32.dll", {
    GetCursorPos: { args: ["ptr"], returns: "i32" }, EnumWindows: { args: ["function", "ptr"], returns: "i32" }, GetWindowThreadProcessId: { args: ["ptr", "ptr"], returns: "u32" },
    GetClassNameW: { args: ["ptr", "ptr", "i32"], returns: "i32" }, FindWindowW: { args: ["ptr", "ptr"], returns: "ptr" },
    CreateWindowExW: { args: ["u32", "ptr", "ptr", "u32", "i32", "i32", "i32", "i32", "ptr", "ptr", "ptr", "ptr"], returns: "ptr" },
    DestroyWindow: { args: ["ptr"], returns: "i32" },
  });
  const dwm = dlopen("dwmapi.dll", {
    DwmSetWindowAttribute: { args: ["ptr", "u32", "ptr", "u32"], returns: "i32" },
    DwmGetWindowAttribute: { args: ["ptr", "u32", "ptr", "u32"], returns: "i32" },
  });
  let window: number | null = null;
  try {
    mark(user.symbols.GetCursorPos(offset) !== 0 && storage.slice(0, 8).every(v => v === 0xa5) && storage.slice(16).every(v => v === 0xa5) && !storage.slice(8, 16).every(v => v === 0xa5), "GetCursorPos Int32Array offset writes without copying");
    const raw = new ArrayBuffer(16);
    mark(user.symbols.GetCursorPos(raw) !== 0, "ArrayBuffer native output");
    const view = new DataView(raw, 8, 8);
    mark(ptr(view) === ptr(new Uint8Array(raw)) + 8 && user.symbols.GetCursorPos(view) !== 0, "DataView native output offset");
    const tray = user.symbols.FindWindowW(encodeWide("Shell_TrayWnd"), null);
    check(tray, "Shell_TrayWnd exists");
    const text = new Uint16Array(256);
    const length = user.symbols.GetClassNameW(tray, text, text.length);
    mark(length > 0 && String.fromCharCode(...text.slice(0, length)) === "Shell_TrayWnd", "GetClassNameW Uint16Array");
    const times = [new BigUint64Array(1), new BigUint64Array(1), new BigUint64Array(1)];
    mark(kernel.symbols.GetSystemTimes(...times) !== 0 && times.every(t => t[0]! > 0n), "GetSystemTimes BigUint64Array");
    window = user.symbols.CreateWindowExW(0, encodeWide("STATIC"), encodeWide("FFI typed array probe"), 0x00cf0000, 0, 0, 100, 100, null, null, null, null);
    check(window, "create owned hidden window");
    const pid = new Uint32Array(1);
    mark(user.symbols.GetWindowThreadProcessId(window, pid) !== 0 && pid[0] === kernel.symbols.GetCurrentProcessId(), "GetWindowThreadProcessId Uint32Array matches pid");
    const enabled = new Uint32Array([1]), result = new Uint32Array(1);
    const setResult = dwm.symbols.DwmSetWindowAttribute(window, 20 /* DWMWA_USE_IMMERSIVE_DARK_MODE */, enabled, 4);
    const getResult = dwm.symbols.DwmGetWindowAttribute(window, 20, result, 4);
    mark(setResult === 0 && getResult === 0 && result[0] === 1, `DWM Uint32Array set/get (${setResult}, ${getResult}, ${result[0]})`);
    const module = kernel.symbols.GetModuleHandleW(encodeWide("user32.dll"));
    const address = kernel.symbols.GetProcAddress(module, new TextEncoder().encode("GetCursorPos\0"));
    const cursor = new CFunction({ ptr: address, args: ["ptr"], returns: "i32" });
    try {
      mark(cursor(offset) !== 0, "CFunction Int32Array output");
      for (const [name, call] of [["dlopen", () => user.symbols.GetCursorPos({})], ["ptr", () => ptr({} as any)], ["CFunction", () => cursor({})]] as const) {
        let error: unknown; try { call(); } catch (e) { error = e; }
        mark(error instanceof TypeError && /pointer|ptr/i.test(error.message), name + " rejects object with TypeError");
      }
    } finally { cursor.close(); }
    for (const value of [{}, "1", true, undefined, () => 1]) {
      let error: unknown; try { user.symbols.GetCursorPos(value); } catch (e) { error = e; }
      mark(error instanceof TypeError, `invalid ptr argument: ${typeof value}`);
    }
    let functionError: unknown;
    try { user.symbols.EnumWindows(new Uint32Array([1]), null); } catch (e) { functionError = e; }
    mark(functionError instanceof TypeError, "function arguments do not accept buffers");
    const floats = new Float32Array([1.5]);
    mark(ptr(floats) === ptr(new Uint8Array(floats.buffer)) && read.f32(ptr(floats)) === 1.5, "Float32Array aliases bytes");
    return { runtime, result: "PASS", checks };
  } finally { if (window) user.symbols.DestroyWindow(window); dwm.close(); user.close(); kernel.close(); }
}
if (import.meta.main) {
  try { console.log(JSON.stringify(probeTypedArrays())); process.exit(0); }
  catch (error) { console.error(String(error)); process.exit(1); }
}
