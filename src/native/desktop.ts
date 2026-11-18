import { CFunction, dlopen, read } from "./ffi";
import { followForeground, onShellEvent } from "./shell-events";
import { exePathOf, explorerTray, windowClass as classOf, foregroundWindow, tapKey, tapKeys, VK, windowPid, type HWND } from "./win32";

const user32 = dlopen("user32.dll", {
  SendMessageTimeoutW: { args: ["ptr", "u32", "u64", "i64", "u32", "u32", "ptr"], returns: "i64" },
  PostMessageW: { args: ["ptr", "u32", "u64", "i64"], returns: "i32" },
  AllowSetForegroundWindow: { args: ["u32"], returns: "i32" },
  SetForegroundWindow: { args: ["ptr"], returns: "i32" },
  FindWindowW: { args: ["ptr", "ptr"], returns: "ptr" },
});
const shell32 = dlopen("shell32.dll", {
  ShellExecuteW: { args: ["ptr", "ptr", "ptr", "ptr", "ptr", "i32"], returns: "i64" },
  SHParseDisplayName: { args: ["ptr", "ptr", "ptr", "u32", "ptr"], returns: "i32" },
  SHOpenFolderAndSelectItems: { args: ["ptr", "u32", "ptr", "u32"], returns: "i32" },
  ILFree: { args: ["ptr"], returns: "void" },
});
const powrprof = dlopen("powrprof.dll", {
  SetSuspendState: { args: ["i32", "i32", "i32"], returns: "i32" },
});
const user32Power = dlopen("user32.dll", {
  ExitWindowsEx: { args: ["u32", "u32"], returns: "i32" },
});
const ole32 = dlopen("ole32.dll", {
  CoInitializeEx: { args: ["ptr", "u32"], returns: "i32" },
  CoUninitialize: { args: [], returns: "void" },
  CLSIDFromString: { args: ["ptr", "ptr"], returns: "i32" },
  CoCreateInstance: { args: ["ptr", "ptr", "u32", "ptr", "ptr"], returns: "i32" },
});

function wide(value: string) {
  const bytes = new Uint8Array((value.length + 1) * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < value.length; i++) view.setUint16(i * 2, value.charCodeAt(i), true);
  return bytes;
}

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


/*
 * Shell surfaces opened the way the taskbar opens them: through Explorer or a shell URI, never with
 * synthetic shortcuts. A faked Win+N / Win+A / ALT counts as keyboard use, so Windows and the XAML
 * flyouts draw focus rectangles on whatever they focus (the "outline" bug).
 */

/** Opens a URI, program or shortcut through the shell, in-process (no cmd.exe, no quoting), as Explorer does. */
export function openUri(uri: string, directory?: string, verb = "open"): boolean {
  try {
    const dir = directory ? wide(directory) : null;
    return Number(shell32.symbols.ShellExecuteW(null, wide(verb), wide(uri), null, dir, 1 /* SW_SHOWNORMAL */)) > 32;
  } catch (error) {
    console.error("[desktop] ShellExecuteW falhou", uri, error);
    return false;
  }
}

/** Sends a command to Explorer's taskbar window; success is delivery. */
function trayCommand(id: number): boolean {
  const tray = explorerTray();
  const result = new Uint8Array(8);
  return !!tray && !!user32.symbols.SendMessageTimeoutW(tray, 0x111 /* WM_COMMAND */, BigInt(id), 0n, 0x2 | 0x20, 500, result);
}

/** The Start button: SC_TASKLIST to Explorer's taskbar opens the Start menu, or closes it when open. */
export function openStartMenu() {
  const tray = explorerTray();
  if (!tray || !user32.symbols.PostMessageW(tray, 0x112 /* WM_SYSCOMMAND */, 0xf130n /* SC_TASKLIST */, 0n)) tapKey(VK.LWIN);
}

/** The Run dialog (Explorer's own File > Run command). */
export function openRunDialog() {
  if (!trayCommand(401)) tapKeys(VK.LWIN, 0x52 /* R */);
}

/*
 * The taskbar's flyouts (Quick Settings, notification center) are shell windows that close when
 * they lose activation (a click anywhere else), and the taskbar button toggles them. Both depend on
 * the flyout being the active window, which needs foreground rights: the dock does not take
 * activation when clicked, so it hands its rights (it received the click) to the shell first.
 */

/** Processes that draw the taskbar's flyouts. */
const FLYOUT_HOSTS = /\\(ShellHost|ShellExperienceHost)\.exe$/i;
const hostCache = new Map<number, boolean>();
function isFlyout(hwnd: HWND | null) {
  if (!hwnd) return false;
  const pid = windowPid(hwnd);
  let host = hostCache.get(pid);
  if (host === undefined) {
    host = FLYOUT_HOSTS.test(exePathOf(pid));
    if (hostCache.size > 64) hostCache.clear();
    hostCache.set(pid, host);
  }
  return host;
}

/** Whether a flyout is, or just was, the active window: clicking the dock closes it before the click lands. */
const flyout = followForeground((hwnd) => isFlyout(hwnd as unknown as HWND), foregroundWindow() as number | null);

const QUICK_SETTINGS = "ControlCenterWindow";

/** The window class of the flyout last in front: Quick Settings is ControlCenterWindow, the notification center another. */
let lastFlyoutClass = "";
onShellEvent((event) => {
  if (event.type === "foreground" && event.hwnd && isFlyout(event.hwnd as unknown as HWND)) lastFlyoutClass = classOf(event.hwnd as unknown as HWND);
});

function toggleFlyout(uri: string, windowClass: string | null, keys: number[]) {
  // This flyout was open a moment ago: the click on the dock took the activation from it and closed
  // it, as the taskbar button's second press. Another flyout closed by the click is no reason not
  // to open this one (clock, then network: the taskbar swaps them).
  const front = foregroundWindow();
  const open = isFlyout(front) || flyout.recently(400);
  const flyoutClass = isFlyout(front) ? classOf(front!) : lastFlyoutClass;
  const same = windowClass ? flyoutClass === windowClass : flyoutClass !== QUICK_SETTINGS;
  if (open && same) {
    flyout.reset();
    return;
  }
  user32.symbols.AllowSetForegroundWindow(0xffffffff /* ASFW_ANY */);
  if (!openUri(uri)) {
    tapKeys(...keys);
    return;
  }
  // Activate it if the shell left it inactive; an inactive flyout never closes on an outside click.
  if (!windowClass) return;
  setTimeout(() => {
    if (isFlyout(foregroundWindow())) return;
    const flyout = user32.symbols.FindWindowW(wide(windowClass), null);
    if (flyout) user32.symbols.SetForegroundWindow(flyout);
  }, 250);
}

/** Notification center with the calendar, as clicking the taskbar clock opens and closes it. */
export function openNotificationCenter() {
  toggleFlyout("ms-actioncenter:", null, [VK.LWIN, 0x4e /* N */]);
}

/** Quick settings (network, volume, battery), as clicking those taskbar icons opens and closes it. */
export function openQuickSettings() {
  toggleFlyout("ms-actioncenter:controlcenter/&showFooter=true", QUICK_SETTINGS, [VK.LWIN, 0x41 /* A */]);
}


/** "Abrir local do arquivo": Explorer opens the folder with the item selected (SHOpenFolderAndSelectItems). */
export function showInFolder(path: string): boolean {
  const out = new Uint8Array(8);
  if (shell32.symbols.SHParseDisplayName(wide(path), null, out, 0, null) < 0) return false;
  const pidl = Number(new DataView(out.buffer).getBigUint64(0, true));
  if (!pidl) return false;
  try {
    return shell32.symbols.SHOpenFolderAndSelectItems(pidl, 0, null, 0) >= 0;
  } finally {
    shell32.symbols.ILFree(pidl);
  }
}

/** "Sair" in Start's power menu: ends the session (ExitWindowsEx, EWX_LOGOFF). */
export function signOut() {
  user32Power.symbols.ExitWindowsEx(0 /* EWX_LOGOFF */, 0);
}

/** "Suspender": sleep, never hibernate (SetSuspendState(FALSE, …)), as Start does. */
export function sleep() {
  powrprof.symbols.SetSuspendState(0, 0, 0);
}
