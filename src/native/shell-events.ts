import { runtime, dlopen } from "./ffi.ts";
import { startWorker } from "../runtime/worker.ts";
import { onExit } from "../services/exit.ts";
import type { RuntimeWorker } from "../runtime/worker.ts";

/**
 * Event-driven signals from the Windows shell, the same ones the real taskbar listens to:
 *  - ABN_FULLSCREENAPP: Explorer tells every AppBar when a full-screen app takes a monitor.
 *  - Shell hook (RegisterShellHookWindow): window created/destroyed/activated, title redrawn,
 *    a full-screen ("rude") app activated, and HSHELL_FLASH when an app asks for attention.
 *  - WinEvents: foreground changes and the foreground window resizing (F11, games).
 *
 * They arrive as window messages, so a thread has to wait in GetMessage for them. Bun's main
 * thread runs its own event loop, so a worker owns a hidden window and blocks in GetMessage:
 * nothing is polled, the worker sleeps until Windows has something to say.
 */

export type ShellEvent =
  | { type: "fullscreen"; on: boolean }
  | { type: "shell"; code: number; hwnd: number }
  | { type: "foreground"; hwnd: number }
  | { type: "moved"; hwnd: number };

export const HSHELL = {
  WINDOWCREATED: 1,
  WINDOWDESTROYED: 2,
  WINDOWACTIVATED: 4,
  REDRAW: 6,
  RUDEAPPACTIVATED: 0x8004,
  FLASH: 0x8006,
} as const;
let worker: RuntimeWorker | undefined;

export function startShellEvents(onEvent: (event: ShellEvent) => void) {
  if (worker) return;
  let threadId = 0;
  const user = dlopen("user32.dll", { PostThreadMessageW: { args: ["u32", "u32", "u64", "i64"], returns: "i32" } });
  worker = startWorker<ShellEvent | { type: "ready"; threadId: number }>(shellWorkerSource(), data => {
    if (data.type === "ready") threadId = data.threadId;
    else onEvent(data);
  }, error => console.error("[shell-events]", error), () => {
    if (threadId) user.symbols.PostThreadMessageW(threadId, 0x12, 0n, 0n);
  });
  onExit(() => { worker?.terminate(); worker = undefined; user.close(); });
}
/** Self-contained JS: workers cannot import the application's TypeScript facade. */
export function shellWorkerFfi(target: typeof runtime): string {
  if (target === "bun") return 'const { dlopen, JSCallback, ptr } = await import("bun:ffi");';
  const backend = target === "node" ?
    'const ffi = require("node:ffi");\n' +
    'const types = { void:"void", ptr:"pointer", u16:"uint16", i32:"int32", u32:"uint32", i64:"int64", u64:"uint64" };\n' +
    'const sig = s => ({ arguments: (s.args || []).map(t => types[t]), return: types[s.returns || "void"] });\n' +
    'const nativePtr = v => v instanceof Uint8Array ? ffi.getRawPointer(v) : BigInt(v || 0);\n' +
    'const address = v => Number(v || 0);\n' +
    'const open = (path, specs) => { const lib = new ffi.DynamicLibrary(path); libraries.push(lib); return Object.fromEntries(Object.entries(specs).map(([name, s]) => [name, lib.getFunction(name, sig(s))])); };\n' +
    'const callback = (fn, s) => { const lib = new ffi.DynamicLibrary("kernel32.dll"); libraries.push(lib); return lib.registerCallback(sig(s), fn); };\n'
    : 'const ffi = await import("tjs:ffi");\n' +
    'const integer64 = signed => new ffi.AdvancedType(ffi.types[signed ? "sint64" : "uint64"], { name: signed ? "bigint64" : "biguint64", toBuffer(value) { const b = new Uint8Array(8), v = new DataView(b.buffer); if (signed) v.setBigInt64(0, BigInt(value), true); else v.setBigUint64(0, BigInt(value), true); return b; }, fromBuffer(b) { const v = new DataView(b.buffer, b.byteOffset, b.byteLength); return signed ? v.getBigInt64(0, true) : v.getBigUint64(0, true); } });\n' +
    'const types = { void:ffi.types.void, ptr:ffi.types.pointer, u16:ffi.types.uint16, i32:ffi.types.sint32, u32:ffi.types.uint32, i64:integer64(true), u64:integer64(false) };\n' +
    'const sig = s => ({ args: (s.args || []).map(t => types[t]), returns: types[s.returns || "void"] });\n' +
    'const nativePtr = v => { if (v instanceof Uint8Array) return ffi.bufferToPointer(v); const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(v || 0), true); return ffi.types.pointer.fromBuffer(b); };\n' +
    'const address = p => { if (p == null) return 0; const b = ffi.types.pointer.toBuffer(p); return Number(new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(0, true)); };\n' +
    'const open = (path, specs) => { const lib = ffi.dlopen(path, Object.fromEntries(Object.entries(specs).map(([n,s]) => [n,sig(s)]))); libraries.push(lib); return lib.symbols; };\n' +
    'const callback = (fn,s) => { /* txiki 26.6 cannot marshal a void callback result; WinEventProc ignores the return register. */ const returnsVoid = !s.returns || s.returns === "void"; const cb = new ffi.JSCallback(returnsVoid ? types.i32 : types[s.returns], (s.args || []).map(t => types[t]), returnsVoid ? (...args) => { fn(...args); return 0; } : fn); callbacks.push(cb); return cb.addr; };\n';
  return 'const libraries = [], callbacks = [];\n' + backend +
    'const input = (t,v) => t === "ptr" ? nativePtr(v) : t === "i64" || t === "u64" ? BigInt(v) : v;\n' +
    'const output = (t,v) => t === "ptr" ? address(v) : t === "i64" || t === "u64" ? BigInt(v) : v;\n' +
    'const ptr = b => address(nativePtr(b));\n' +
    'const dlopen = (path,specs) => { const symbols = open(path,specs); return { symbols: Object.fromEntries(Object.entries(specs).map(([n,s]) => [n,(...args) => output(s.returns, symbols[n](...(s.args || []).map((t,i) => input(t,args[i]))))])) }; };\n' +
    'class JSCallback { constructor(fn,s) { this.ptr = address(callback((...args) => input(s.returns, fn(...(s.args || []).map((t,i) => output(t,args[i])))), s)); } }\n';
}
export function shellWorkerSource(target: typeof runtime = runtime): string {
  return `
${shellWorkerFfi(target)}
const u = dlopen("user32.dll", {
  RegisterClassExW: { args: ["ptr"], returns: "u16" },
  CreateWindowExW: { args: ["u32", "ptr", "ptr", "u32", "i32", "i32", "i32", "i32", "ptr", "ptr", "ptr", "ptr"], returns: "ptr" },
  DefWindowProcW: { args: ["ptr", "u32", "u64", "i64"], returns: "i64" },
  GetMessageW: { args: ["ptr", "ptr", "u32", "u32"], returns: "i32" },
  TranslateMessage: { args: ["ptr"], returns: "i32" },
  DispatchMessageW: { args: ["ptr"], returns: "i64" },
  RegisterWindowMessageW: { args: ["ptr"], returns: "u32" },
  RegisterShellHookWindow: { args: ["ptr"], returns: "i32" },
  SetWinEventHook: { args: ["u32", "u32", "ptr", "ptr", "u32", "u32", "u32"], returns: "ptr" },
  GetForegroundWindow: { args: [], returns: "ptr" },
  DestroyWindow: { args: ["ptr"], returns: "i32" },
  UnhookWinEvent: { args: ["ptr"], returns: "i32" },
  DeregisterShellHookWindow: { args: ["ptr"], returns: "i32" },
}).symbols;
const shell = dlopen("shell32.dll", { SHAppBarMessage: { args: ["u32", "ptr"], returns: "u64" } }).symbols;
const k = dlopen("kernel32.dll", { GetModuleHandleW: { args: ["ptr"], returns: "ptr" }, GetCurrentThreadId: { args: [], returns: "u32" } }).symbols;
const wide = (s) => { const units = new Uint16Array(s.length + 1); for (let i = 0; i < s.length; i++) units[i] = s.charCodeAt(i); return new Uint8Array(units.buffer); };
const APPBAR_CALLBACK = 0x8000 + 0x51;
let shellHook = 0;
const proc = new JSCallback((hwnd, msg, wParam, lParam) => {
  if (msg === shellHook && shellHook) {
    postMessage({ type: "shell", code: Number(wParam) & 0xffff, hwnd: Number(lParam) });
    return 0n;
  }
  if (msg === APPBAR_CALLBACK) {
    if (Number(wParam) === 2) postMessage({ type: "fullscreen", on: Number(lParam) !== 0 });
    return 0n;
  }
  return u.DefWindowProcW(hwnd, msg, wParam, lParam);
}, { args: ["ptr", "u32", "u64", "i64"], returns: "i64" });
const name = wide("WindowsBarShellEvents");
const wc = new Uint8Array(80);
const v = new DataView(wc.buffer);
const inst = k.GetModuleHandleW(null);
v.setUint32(0, 80, true);
v.setBigUint64(8, BigInt(proc.ptr), true);
v.setBigUint64(24, BigInt(inst ?? 0), true);
v.setBigUint64(64, BigInt(ptr(name)), true);
u.RegisterClassExW(wc);
const hwnd = u.CreateWindowExW(0x80, name, wide("WindowsBar shell events"), 0x80000000, 0, 0, 0, 0, null, null, inst, null);
shellHook = u.RegisterWindowMessageW(wide("SHELLHOOK"));
u.RegisterShellHookWindow(hwnd);
// A second AppBar that reserves nothing: Explorer sends every AppBar ABN_FULLSCREENAPP.
const abd = new Uint8Array(48);
const a = new DataView(abd.buffer);
a.setUint32(0, 48, true);
a.setBigUint64(8, BigInt(hwnd), true);
a.setUint32(16, APPBAR_CALLBACK, true);
shell.SHAppBarMessage(0, abd);
let lastMove = 0;
const onEvent = new JSCallback((hook, event, target, idObject) => {
  if (idObject !== 0 || !target) return;
  if (event === 3) postMessage({ type: "foreground", hwnd: Number(target) });
  else if (Number(target) === Number(u.GetForegroundWindow())) {
    const now = Date.now();
    if (now - lastMove > 60) {
      lastMove = now;
      postMessage({ type: "moved", hwnd: Number(target) });
    }
  }
}, { args: ["ptr", "u32", "ptr", "i32", "i32", "u32", "u32"], returns: "void" });
// WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS; delivered to this thread's GetMessage.
const foregroundHook = u.SetWinEventHook(0x0003, 0x0003, null, onEvent.ptr, 0, 0, 0x2);
const movedHook = u.SetWinEventHook(0x800b, 0x800b, null, onEvent.ptr, 0, 0, 0x2);
postMessage({ type: "ready", threadId: k.GetCurrentThreadId() });
const msg = new Uint8Array(48);
while (u.GetMessageW(msg, null, 0, 0) > 0) {
  u.TranslateMessage(msg);
  u.DispatchMessageW(msg);
}
u.UnhookWinEvent(foregroundHook);
u.UnhookWinEvent(movedHook);
shell.SHAppBarMessage(1, abd);
u.DeregisterShellHookWindow(hwnd);
u.DestroyWindow(hwnd);
`;
}
