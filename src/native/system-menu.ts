import { dlopen, type Pointer } from "./ffi";

/** What the taskbar does to a button's windows on Shift+right-click: their own system menu, or system commands. */

const user32 = dlopen("user32.dll", {
  SetForegroundWindow: { args: ["ptr"], returns: "i32" },
  PostMessageW: { args: ["ptr", "u32", "u64", "i64"], returns: "i32" },
});

const WM_SYSCOMMAND = 0x0112;
/** Undocumented but stable since Windows 95: the window opens its system menu at the point. Explorer's taskbar posts it. */
const WM_POPUPSYSTEMMENU = 0x0313;

export const SC_MINIMIZE = 0xf020;
export const SC_RESTORE = 0xf120;
export const SC_CLOSE = 0xf060;

/**
 * Shift+right-click on a one-window taskbar button: the window comes to the foreground (so its menu
 * can take the input and closes on an outside click) and shows its own system menu at `x`,`y`
 * (physical screen px), with its own items and states; the chosen command reaches it as WM_SYSCOMMAND.
 */
export function popupSystemMenu(hwnd: Pointer, x: number, y: number): boolean {
  user32.symbols.SetForegroundWindow(hwnd);
  const lParam = (y & 0xffff) * 0x10000 + (x & 0xffff);
  return !!user32.symbols.PostMessageW(hwnd, WM_POPUPSYSTEMMENU, 0, lParam);
}

/** A system menu command (Restore, Minimize, Close), as the taskbar's group menu sends it to each window. */
export function sysCommand(hwnd: Pointer, command: number): boolean {
  return !!user32.symbols.PostMessageW(hwnd, WM_SYSCOMMAND, command, 0);
}
