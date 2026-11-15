# Waits for the dock process to end, then shows the Windows taskbar and restores its auto-hide state.
param([int]$dockPid, [int]$state)
$p = Get-Process -Id $dockPid -ErrorAction SilentlyContinue
if ($p) { $p.WaitForExit() }
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Tb {
  [StructLayout(LayoutKind.Sequential)]
  public struct APPBARDATA { public uint cbSize; public IntPtr hWnd; public uint msg; public uint edge; public int l, t, r, b; public IntPtr lParam; }
  [DllImport("shell32.dll")] public static extern UIntPtr SHAppBarMessage(uint m, ref APPBARDATA d);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindowW(string c, string t);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  public static void Restore(int state) {
    var d = new APPBARDATA();
    d.cbSize = (uint)Marshal.SizeOf(d);
    d.lParam = (IntPtr)state;
    SHAppBarMessage(10, ref d);
    var tray = FindWindowW("Shell_TrayWnd", null);
    if (tray != IntPtr.Zero) ShowWindow(tray, 8);
  }
}
"@
[Tb]::Restore($state)
