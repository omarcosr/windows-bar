# Extracts 64px icons: each line of the job file is "<exe or .lnk path>|<png output path>".
param([string]$jobs)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class IconX {
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  public static extern int SHDefExtractIconW(string file, int index, uint flags, out IntPtr large, out IntPtr small, uint size);
  [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr h);
}
"@
foreach ($line in Get-Content -LiteralPath $jobs) {
  $parts = $line.Split('|')
  if ($parts.Count -lt 2) { continue }
  $src = $parts[0]; $out = $parts[1]
  try {
    $large = [IntPtr]::Zero; $small = [IntPtr]::Zero
    $hr = [IconX]::SHDefExtractIconW($src, 0, 0, [ref]$large, [ref]$small, 64)
    if ($hr -eq 0 -and $large -ne [IntPtr]::Zero) {
      $bmp = [System.Drawing.Icon]::FromHandle($large).ToBitmap()
      $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
      $bmp.Dispose()
      [IconX]::DestroyIcon($large) | Out-Null
      if ($small -ne [IntPtr]::Zero) { [IconX]::DestroyIcon($small) | Out-Null }
    } else {
      $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($src)
      if ($icon) { $icon.ToBitmap().Save($out, [System.Drawing.Imaging.ImageFormat]::Png) }
    }
  } catch { }
}
