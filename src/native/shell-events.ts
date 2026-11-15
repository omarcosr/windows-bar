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

const workerSource = `
import { dlopen, JSCallback, ptr } from "bun:ffi";
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
}).symbols;
const shell = dlopen("shell32.dll", { SHAppBarMessage: { args: ["u32", "ptr"], returns: "u64" } }).symbols;
const k = dlopen("kernel32.dll", { GetModuleHandleW: { args: ["ptr"], returns: "ptr" } }).symbols;
const wide = (s) => Buffer.from(s + "\\0", "utf16le");
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
u.SetWinEventHook(0x0003, 0x0003, null, onEvent.ptr, 0, 0, 0x2);
u.SetWinEventHook(0x800b, 0x800b, null, onEvent.ptr, 0, 0, 0x2);
postMessage({ type: "ready" });
const msg = new Uint8Array(48);
while (u.GetMessageW(msg, null, 0, 0) > 0) {
  u.TranslateMessage(msg);
  u.DispatchMessageW(msg);
}
`;

let worker: Worker | undefined;

export function startShellEvents(onEvent: (event: ShellEvent) => void) {
  if (worker) return;
  const url = URL.createObjectURL(new Blob([workerSource], { type: "application/typescript" }));
  worker = new Worker(url);
  worker.onmessage = (e: MessageEvent) => {
    const data = e.data as ShellEvent | { type: "ready" };
    if (data.type !== "ready") onEvent(data);
  };
  worker.onerror = (e) => console.error("[shell-events]", e);
  process.on("exit", () => worker?.terminate());
}
