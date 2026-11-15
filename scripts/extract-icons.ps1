# Extracts app icons the way Explorer draws them: each line of the job file is
# "<exe, .lnk or shell:AppsFolder\<AppUserModelID>>|<png output path>".
# IShellItemImageFactory picks the best frame of the icon (up to 256 px) and handles packaged
# (Store) apps, so icons come out sharp instead of an upscaled 32 px frame.
param([string]$jobs)
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing @"
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public static class ShellIcon {
  [ComImport, Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItemImageFactory {
    [PreserveSig] int GetImage(SIZE size, int flags, out IntPtr phbm);
  }
  [StructLayout(LayoutKind.Sequential)] struct SIZE { public int cx; public int cy; }
  [StructLayout(LayoutKind.Sequential)] struct BITMAP {
    public int bmType; public int bmWidth; public int bmHeight; public int bmWidthBytes;
    public ushort bmPlanes; public ushort bmBitsPixel; public IntPtr bmBits;
  }
  [StructLayout(LayoutKind.Sequential)] struct BITMAPINFOHEADER {
    public int biSize; public int biWidth; public int biHeight; public short biPlanes; public short biBitCount;
    public int biCompression; public int biSizeImage; public int biXPelsPerMeter; public int biYPelsPerMeter;
    public int biClrUsed; public int biClrImportant;
  }
  [StructLayout(LayoutKind.Sequential)] struct DIBSECTION {
    public BITMAP dsBm; public BITMAPINFOHEADER dsBmih;
    public int dsBitfields0; public int dsBitfields1; public int dsBitfields2; public IntPtr dshSection; public int dsOffset;
  }

  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
  static extern int SHCreateItemFromParsingName(string path, IntPtr pbc, ref Guid riid, out IShellItemImageFactory item);
  [DllImport("gdi32.dll")] static extern int GetObject(IntPtr h, int size, out DIBSECTION ds);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr h);

  public static bool Save(string source, string output, int size) {
    Guid iid = new Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b");
    IShellItemImageFactory factory;
    if (SHCreateItemFromParsingName(source, IntPtr.Zero, ref iid, out factory) != 0 || factory == null) return false;
    IntPtr hbm;
    SIZE s; s.cx = size; s.cy = size;
    // SIIGBF_ICONONLY: the program's icon, never a thumbnail of its contents.
    if (factory.GetImage(s, 0x4, out hbm) != 0 || hbm == IntPtr.Zero) return false;
    try {
      DIBSECTION ds;
      if (GetObject(hbm, Marshal.SizeOf(typeof(DIBSECTION)), out ds) == 0 || ds.dsBm.bmBits == IntPtr.Zero || ds.dsBm.bmBitsPixel != 32) {
        using (Bitmap plain = Image.FromHbitmap(hbm)) plain.Save(output, ImageFormat.Png);
        return true;
      }
      int w = ds.dsBm.bmWidth, h = ds.dsBm.bmHeight, stride = ds.dsBm.bmWidthBytes;
      bool bottomUp = ds.dsBmih.biHeight > 0;
      using (Bitmap bmp = new Bitmap(w, h, PixelFormat.Format32bppPArgb)) {
        BitmapData data = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.WriteOnly, PixelFormat.Format32bppPArgb);
        byte[] row = new byte[stride];
        for (int y = 0; y < h; y++) {
          int srcRow = bottomUp ? h - 1 - y : y;
          Marshal.Copy(new IntPtr(ds.dsBm.bmBits.ToInt64() + (long)srcRow * stride), row, 0, stride);
          Marshal.Copy(row, 0, new IntPtr(data.Scan0.ToInt64() + (long)y * data.Stride), Math.Min(stride, data.Stride));
        }
        bmp.UnlockBits(data);
        bmp.Save(output, ImageFormat.Png);
      }
      return true;
    } finally {
      DeleteObject(hbm);
    }
  }

  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  static extern int SHDefExtractIconW(string file, int index, uint flags, out IntPtr large, out IntPtr small, uint size);
  [DllImport("user32.dll")] static extern bool DestroyIcon(IntPtr h);

  /** The old way, for files the shell cannot parse: a fixed-size frame from the file's resources. */
  public static bool SaveFallback(string source, string output, int size) {
    IntPtr large, small;
    if (SHDefExtractIconW(source, 0, 0, out large, out small, (uint)size) != 0 || large == IntPtr.Zero) return false;
    using (Bitmap bmp = Icon.FromHandle(large).ToBitmap()) bmp.Save(output, ImageFormat.Png);
    DestroyIcon(large);
    if (small != IntPtr.Zero) DestroyIcon(small);
    return true;
  }
}
"@
foreach ($line in Get-Content -LiteralPath $jobs -Encoding UTF8) {
  $parts = $line.Split('|')
  if ($parts.Count -lt 2) { continue }
  $src = $parts[0]; $out = $parts[1]
  try {
    if (-not [ShellIcon]::Save($src, $out, 64)) { [ShellIcon]::SaveFallback($src, $out, 64) | Out-Null }
  } catch {
    try { [ShellIcon]::SaveFallback($src, $out, 64) | Out-Null } catch { }
  }
}
