# Waits outside the dock's job, removes its AppBar, and restores the first taskbar snapshot.
param([int]$dockPid, [int]$state, [long]$dockHwnd = 0, [string]$stateFile = '')
$ErrorActionPreference = 'Stop'
$p = Get-Process -Id $dockPid -ErrorAction SilentlyContinue
if ($p) { $p.WaitForExit() }
# A normal restore deletes the snapshot; an old watchdog must not undo a later session.
if ($stateFile) {
  if (!(Test-Path -LiteralPath $stateFile)) { exit 0 }
  $state = [int]([IO.File]::ReadAllText($stateFile))
  if ($state -lt 0 -or $state -gt 3) { throw 'Invalid taskbar state snapshot' }
}
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Tb {
  [StructLayout(LayoutKind.Sequential)]
  public struct APPBARDATA { public uint cbSize; public IntPtr hWnd; public uint msg; public uint edge; public int l, t, r, b; public IntPtr lParam; }
  [DllImport("shell32.dll")] public static extern UIntPtr SHAppBarMessage(uint m, ref APPBARDATA d);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindowExW(IntPtr parent, IntPtr after, string c, string t);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  public static void Restore(int state, long dockHwnd) {
    var d = new APPBARDATA();
    d.cbSize = (uint)Marshal.SizeOf(d);
    if (dockHwnd != 0) {
      d.hWnd = (IntPtr)dockHwnd;
      SHAppBarMessage(1, ref d); // ABM_REMOVE: release the dead dock's reservation first.
      d.hWnd = IntPtr.Zero;
    }
    d.lParam = (IntPtr)state;
    SHAppBarMessage(10, ref d);
    var tray = IntPtr.Zero;
    while ((tray = FindWindowExW(IntPtr.Zero, tray, "Shell_TrayWnd", null)) != IntPtr.Zero) {
      uint pid;
      GetWindowThreadProcessId(tray, out pid);
      try { if (System.Diagnostics.Process.GetProcessById((int)pid).ProcessName == "explorer") ShowWindow(tray, 8); } catch {}
    }
  }
}
"@
[Tb]::Restore($state, $dockHwnd)
# Keep the snapshot after a crash so the next dock never captures dirty shell state.
