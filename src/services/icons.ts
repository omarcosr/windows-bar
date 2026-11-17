import type { ImageRgbaSource } from "@tarve/core";
import { shellIconPixels, systemScale } from "../native/shell-icon";

/**
 * App icons. Tarve's <Image src> can show a .exe/.dll/.lnk path as its shell icon, but it loads the
 * 256 px frame and shrinks it on the GPU without mipmaps, so the edges come out jagged. The icon is
 * read here at the exact pixel size it is drawn at instead; the path stays as the fallback.
 */
const cache = new Map<string, ImageRgbaSource | string>();

export function iconFor(exe: string, size = 32): ImageRgbaSource | string | undefined {
  if (!exe) return undefined;
  const px = Math.round(size * systemScale());
  const key = `${exe.toLowerCase()}|${px}`;
  let icon = cache.get(key);
  if (!icon) {
    let pixels = null;
    try {
      pixels = shellIconPixels(exe, px);
    } catch {
      pixels = null;
    }
    // <Image> cannot load a shell: path (Store apps): no icon then, the caller draws its placeholder.
    if (!pixels && /^shell:/i.test(exe)) return undefined;
    icon = pixels ? { ...pixels, cacheKey: `icon:${key}` } : exe;
    cache.set(key, icon);
  }
  return icon;
}
