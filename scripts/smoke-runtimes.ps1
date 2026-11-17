param([string]$OutputDirectory = "$env:EMPRYO_TMP\step7", [ValidateSet('floating','full')][string]$Mode = 'floating', [string[]]$Runtimes = @('txiki','bun','node','bun-dev'), [switch]$TestForcedExit)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force $OutputDirectory | Out-Null
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class SmokeWindows {
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowW(string cls, string title);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowExW(IntPtr parent, IntPtr after, string cls, string title);
 public static IntPtr ExplorerTray() { IntPtr h=IntPtr.Zero; while((h=FindWindowExW(IntPtr.Zero,h,"Shell_TrayWnd",null))!=IntPtr.Zero) { uint p; GetWindowThreadProcessId(h,out p); try { if(System.Diagnostics.Process.GetProcessById((int)p).ProcessName=="explorer") return h; } catch {} } return IntPtr.Zero; }
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
 [DllImport("user32.dll")] public static extern bool SystemParametersInfoW(uint action, uint param, out Rect rect, uint flags);
 [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
 public static string WorkArea() { Rect r; SystemParametersInfoW(48,0,out r,0); return r.Left+","+r.Top+","+r.Right+","+r.Bottom; }
 public static uint DockPid() { uint p; GetWindowThreadProcessId(FindWindowW(null,"WindowsBar Dock"),out p); return p; }
 [StructLayout(LayoutKind.Sequential)] public struct AppBarData { public uint Size; public IntPtr Window; public uint Message, Edge; public Rect Rect; public IntPtr Param; }
 [DllImport("shell32.dll")] public static extern UIntPtr SHAppBarMessage(uint msg, ref AppBarData data);
 public static int TaskbarState() { var d = new AppBarData(); d.Size=(uint)Marshal.SizeOf(d); return (int)SHAppBarMessage(4,ref d).ToUInt64(); }
}
'@
if ([SmokeWindows]::DockPid()) { throw 'An existing dock is running; refusing to stop another session.' }
$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$original = (Get-ItemProperty -Path $key -ErrorAction SilentlyContinue).WindowsBar
$initialWork = [SmokeWindows]::WorkArea()
$initialState = [SmokeWindows]::TaskbarState()
$initialTray = [SmokeWindows]::IsWindowVisible([SmokeWindows]::ExplorerTray())
$script:started = @()
$fixture = Join-Path ([IO.Path]::GetFullPath($OutputDirectory)) 'appdata'
New-Item -ItemType Directory -Force (Join-Path $fixture 'windows-bar') | Out-Null
$fixtureConfig = @{ version=1; mode=$Mode; reserveSpace=$true; hideNativeTaskbar=$true; autoUpdate=$false; hoverPreview=$true }
$fixtureConfig | ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $fixture 'windows-bar\config.json')
function Start-Captured([string]$exe, [string]$arguments, [string]$label) {
 $s = New-Object System.Diagnostics.ProcessStartInfo
 $s.FileName = $exe; $s.Arguments = $arguments; $s.WorkingDirectory = (Get-Location).Path
 $s.UseShellExecute = $false; $s.RedirectStandardOutput = $true; $s.RedirectStandardError = $true
 $s.EnvironmentVariables['WINDOWSBAR_UPDATE_URL'] = 'http://127.0.0.1:1/step7-disabled.json'
 $s.EnvironmentVariables['APPDATA'] = $fixture
 $p = New-Object System.Diagnostics.Process; $p.StartInfo = $s
 [void]$p.Start(); $script:started += $p
 return @{ Process=$p; Out=$p.StandardOutput.ReadToEndAsync(); Err=$p.StandardError.ReadToEndAsync(); Label=$label }
}
function Finish-Captured($job) {
 $p = $job.Process
 if (!$p.HasExited) { & taskkill.exe /PID $p.Id /T /F | Out-Null; [void]$p.WaitForExit(5000) }
 $stdout = $job.Out.GetAwaiter().GetResult(); $stderr = $job.Err.GetAwaiter().GetResult()
 [IO.File]::WriteAllText((Join-Path $OutputDirectory ($job.Label+'.stdout.log')), $stdout)
 [IO.File]::WriteAllText((Join-Path $OutputDirectory ($job.Label+'.stderr.log')), $stderr)
 return @{ ExitCode=$p.ExitCode; Stderr=$stderr; Stdout=$stdout }
}
$results = @()
try {
 foreach ($r in @(
  @{Name='txiki'; Exe=(Join-Path $PWD 'dist\WindowsBar.exe'); Args=''},
  @{Name='bun'; Exe=(Join-Path $PWD 'dist\bun\WindowsBar.exe'); Args=''},
  @{Name='node'; Exe=(Join-Path $PWD 'dist\node\WindowsBar.exe'); Args=''},
  @{Name='bun-dev'; Exe=(Get-Command bun.exe).Source; Args='run dev'}
 )) {
  if ($r.Name -notin $Runtimes) { continue }
  $row = [ordered]@{ Runtime=$r.Name; BeforeWork=[SmokeWindows]::WorkArea() }
  if ($r.Name -ne 'bun-dev') {
   foreach ($flag in @('on','off')) {
    $j = Start-Captured $r.Exe "--autostart $flag" "$($r.Name)-autostart-$flag"
    $finished = $j.Process.WaitForExit(12000)
    $row["Autostart-$flag"] = @{ Finished=$finished; Registry=(Get-ItemProperty -Path $key -ErrorAction SilentlyContinue).WindowsBar; Result=(Finish-Captured $j) }
   }
  }
  $j = Start-Captured $r.Exe $r.Args "$($r.Name)-startup"
  $early = $j.Process.WaitForExit(8000)
  $row.AliveAfter8s = !$early
  $row.DockPid = [SmokeWindows]::DockPid()
  $row.DockVisible = [SmokeWindows]::IsWindowVisible([SmokeWindows]::FindWindowW($null,'WindowsBar Dock'))
  $row.DuringWork = [SmokeWindows]::WorkArea()
  $row.NativeTaskbarVisibleAt8s = [SmokeWindows]::IsWindowVisible([SmokeWindows]::ExplorerTray())
  $row.HideWaitMs = 0
  while ([SmokeWindows]::IsWindowVisible([SmokeWindows]::ExplorerTray()) -and $row.HideWaitMs -lt 1000) {
   Start-Sleep -Milliseconds 100
   $row.HideWaitMs += 100
  }
  $row.NativeTaskbarVisible = [SmokeWindows]::IsWindowVisible([SmokeWindows]::ExplorerTray())
  $quitExe = if ($r.Name -eq 'bun-dev') { Join-Path $PWD 'dist\bun\WindowsBar.exe' } else { $r.Exe }
  $u = Start-Captured $quitExe '--update' "$($r.Name)-update"
  $row.UpdateFinished = $u.Process.WaitForExit(12000)
  $row.Update = Finish-Captured $u
  $row.AliveAfterUpdate = !$j.Process.HasExited
  $q = Start-Captured $quitExe '--quit' "$($r.Name)-quit"
  $row.QuitFinished = $q.Process.WaitForExit(12000)
  $row.Quit = Finish-Captured $q
  $row.ExitedAfterQuit = $j.Process.WaitForExit(8000)
  $row.Startup = Finish-Captured $j
  $row.AfterWork = [SmokeWindows]::WorkArea()
  $row.TaskbarRestored = [SmokeWindows]::IsWindowVisible([SmokeWindows]::ExplorerTray())
  $row.AfterState = [SmokeWindows]::TaskbarState()
  $row.SnapshotRemovedAfterQuit = !(Test-Path -LiteralPath (Join-Path $fixture 'windows-bar\taskbar-state.json'))
  if ($row.TaskbarRestored -ne $initialTray -or $row.AfterState -ne $initialState -or $row.AfterWork -ne $row.BeforeWork) {
   & powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/restore-taskbar.ps1 -dockPid 2147483647 -state $initialState
  }
  $row.TaskbarVisibleAfterRecovery = [SmokeWindows]::IsWindowVisible([SmokeWindows]::ExplorerTray())
  if ($TestForcedExit) {
   $f = Start-Captured $r.Exe $r.Args "$($r.Name)-forced"
   [void]$f.Process.WaitForExit(8000)
   $row.ForcedDockPid = [SmokeWindows]::DockPid()
   for ($i=0; $i -lt 10 -and [SmokeWindows]::IsWindowVisible([SmokeWindows]::ExplorerTray()); $i++) { Start-Sleep -Milliseconds 100 }
   $row.ForcedTaskbarHidden = ![SmokeWindows]::IsWindowVisible([SmokeWindows]::ExplorerTray())
   $row.ForcedDuringWork = [SmokeWindows]::WorkArea()
   $row.ForcedProcess = Finish-Captured $f
   for ($i=0; $i -lt 60; $i++) {
    if ([SmokeWindows]::IsWindowVisible([SmokeWindows]::ExplorerTray()) -eq $initialTray -and [SmokeWindows]::WorkArea() -eq $row.BeforeWork -and [SmokeWindows]::TaskbarState() -eq $initialState) { break }
    Start-Sleep -Milliseconds 250
   }
   $row.ForcedTaskbarRestored = [SmokeWindows]::IsWindowVisible([SmokeWindows]::ExplorerTray())
   $row.ForcedAfterWork = [SmokeWindows]::WorkArea()
   $row.ForcedAfterState = [SmokeWindows]::TaskbarState()
   $snapshot = Join-Path $fixture 'windows-bar\taskbar-state.json'
   $row.SnapshotAfterForcedExit = if (Test-Path -LiteralPath $snapshot) { [int]([IO.File]::ReadAllText($snapshot)) } else { $null }
   if ($row.ForcedTaskbarRestored -ne $initialTray -or $row.ForcedAfterState -ne $initialState -or $row.ForcedAfterWork -ne $row.BeforeWork) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/restore-taskbar.ps1 -dockPid 2147483647 -state $initialState
   }
  }
  $results += $row
  $results | ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 (Join-Path $OutputDirectory 'results.json')
 }
} finally {
 foreach ($p in $script:started) { if (!$p.HasExited) { & taskkill.exe /PID $p.Id /T /F | Out-Null } }
 if ($null -ne $original) { Set-ItemProperty -Path $key -Name WindowsBar -Value $original }
 else { Remove-ItemProperty -Path $key -Name WindowsBar -ErrorAction SilentlyContinue }
 if ([SmokeWindows]::IsWindowVisible([SmokeWindows]::ExplorerTray()) -ne $initialTray -or [SmokeWindows]::TaskbarState() -ne $initialState -or [SmokeWindows]::WorkArea() -ne $initialWork) {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/restore-taskbar.ps1 -dockPid 2147483647 -state $initialState
 }
}
$results | ConvertTo-Json -Depth 8
if ($TestForcedExit) {
 foreach ($row in $results) {
  if (!$row.SnapshotRemovedAfterQuit -or $null -eq $row.SnapshotAfterForcedExit -or $row.SnapshotAfterForcedExit -ne $initialState -or !$row.DockPid -or !$row.AliveAfter8s -or $row.NativeTaskbarVisible -or !$row.ExitedAfterQuit -or $row.Startup.ExitCode -ne 0 -or $row.TaskbarRestored -ne $initialTray -or $row.AfterWork -ne $row.BeforeWork -or $row.AfterState -ne $initialState -or !$row.ForcedDockPid -or !$row.ForcedTaskbarHidden -or $row.ForcedTaskbarRestored -ne $initialTray -or $row.ForcedAfterWork -ne $row.BeforeWork -or $row.ForcedAfterState -ne $initialState) {
   throw "Lifecycle checks failed for $($row.Runtime); see results.json (recorded before emergency recovery)."
  }
 }
}
