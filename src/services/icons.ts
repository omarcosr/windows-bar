import type { ImageRgbaSource } from "@tarve/core";
import { shellIconPixels, systemScale } from "../native/shell-icon";

/**
 * App icons, read here once per pixel size (macOS magnification: one load per size the animation
 * passes through) and drawn 1:1. Not <Image src="x.exe">: Tarve takes the shell's frame for the
 * nearest size step (32 px for a 30 px icon at 125 %) and the shell's own scaling, both of which
 * leave stair-stepped edges; shellIconPixels area-filters a larger frame down instead.
 */
/** null: the shell had no icon for it (remembered, so a render does not ask again for 7–16 ms). */
const cache = new Map<string, ImageRgbaSource | string | null>();

export function iconFor(exe: string, size = 32, animated = false): ImageRgbaSource | string | undefined {
  if (!exe) return undefined;
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
