import type { ImageRgbaSource } from "@tarve/core";
import { shellIconPixels, systemScale } from "../native/shell-icon";

/**
 * App icons. A program, library or shortcut on disk is handed to <Image src> as its path: Tarve
 * draws the shell's icon frame for the displayed physical size, loaded off the UI thread and cached
 * per size. The rest (shell:AppsFolder items, other files) and icons whose size animates (macOS
 * magnification: one load per size the animation passes through) are read here once at the pixel
 * size asked for.
 */
/** null: the shell had no icon for it (remembered, so a render does not ask again for 7–16 ms). */
const cache = new Map<string, ImageRgbaSource | string | null>();

const ON_DISK = /^[a-z]:\\.*\.(exe|dll|lnk)$/i;

export function iconFor(exe: string, size = 32, animated = false): ImageRgbaSource | string | undefined {
  if (!exe) return undefined;
  if (!animated && ON_DISK.test(exe)) return exe;
  const px = Math.round(size * systemScale());
  const key = `${exe.toLowerCase()}|${px}`;
  let icon = cache.get(key);
  if (icon === null) return undefined;
  if (!icon) {
    let pixels = null;
    try {
      pixels = shellIconPixels(exe, px);
    } catch {
      pixels = null;
    }
    // <Image> cannot load a shell: path (Store apps): no icon then, the caller draws its placeholder.
    // Nor a bare file name ("mygo music.exe", a process whose path could not be read): the runtime
    // resolves it next to the dock's exe, fails, and logs the error again on every render.
    if (!pixels && (/^shell:/i.test(exe) || !/^([a-z]:)?[\\/]/i.test(exe))) {
      cache.set(key, null);
      return undefined;
    }
    icon = pixels ? { ...pixels, cacheKey: `icon:${key}` } : exe;
    cache.set(key, icon);
  }
  return icon;
}
