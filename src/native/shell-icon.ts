import { CFunction, dlopen, ptr, read, type Pointer, FfiUnsupported, JSCallback } from "./ffi";
import { iconPixels } from "./tray-host";
import { encodeWide } from "./wide";

/**
 * Shell icons (.exe/.dll/.lnk) rendered at an exact pixel size. Tarve's `<Image src="x.exe">`
 * loads the 256 px jumbo icon and the GPU shrinks it to ~32 px without mipmaps, which leaves the
 * edges jagged. Here the system image list closest in size is read through GDI and reduced with an
 * area (box) filter in premultiplied alpha, so the GPU draws the pixels 1:1.
 */

const shell32 = dlopen("shell32.dll", {
  SHGetFileInfoW: { args: ["ptr", "u32", "ptr", "u32", "u32"], returns: "u64" },
  SHGetImageList: { args: ["i32", "ptr", "ptr"], returns: "i32" },
  SHParseDisplayName: { args: ["ptr", "ptr", "ptr", "u32", "ptr"], returns: "i32" },
  SHCreateItemFromParsingName: { args: ["ptr", "ptr", "ptr", "ptr"], returns: "i32" },
});
const gdi32 = dlopen("gdi32.dll", {
  GetObjectW: { args: ["ptr", "i32", "ptr"], returns: "i32" },
  GetDIBits: { args: ["ptr", "ptr", "u32", "u32", "ptr", "ptr", "u32"], returns: "i32" },
  DeleteObject: { args: ["ptr"], returns: "i32" },
});
const user32 = dlopen("user32.dll", {
  DestroyIcon: { args: ["ptr"], returns: "i32" },
  GetDpiForSystem: { args: [], returns: "u32" },
  GetDC: { args: ["ptr"], returns: "ptr" },
  ReleaseDC: { args: ["ptr", "ptr"], returns: "i32" },
  PrivateExtractIconsW: { args: ["ptr", "i32", "i32", "i32", "ptr", "ptr", "u32", "u32"], returns: "u32" },
});
const kernel32 = dlopen("kernel32.dll", {
  LoadLibraryExW: { args: ["ptr", "ptr", "u32"], returns: "ptr" },
  FreeLibrary: { args: ["ptr"], returns: "i32" },
  EnumResourceNamesW: { args: ["ptr", "ptr", "function", "ptr"], returns: "i32" },
  FindResourceW: { args: ["ptr", "ptr", "ptr"], returns: "ptr" },
  LoadResource: { args: ["ptr", "ptr"], returns: "ptr" },
  LockResource: { args: ["ptr"], returns: "ptr" },
  SizeofResource: { args: ["ptr", "ptr"], returns: "u32" },
});
const ole32 = dlopen("ole32.dll", {
  CoInitializeEx: { args: ["ptr", "u32"], returns: "i32" },
  CoTaskMemFree: { args: ["ptr"], returns: "void" },
});

const SHGFI_SYSICONINDEX = 0x4000;
const SHGFI_PIDL = 0x8;
const SHIL_LARGE = 0;
const SHIL_SMALL = 1;
const SHIL_EXTRALARGE = 2;
const SHIL_JUMBO = 4;
const ILD_TRANSPARENT = 1;
// IID_IImageList {46EB5926-582E-4017-9FDF-E8998DAA0950}
const IID_IImageList = Uint8Array.from([
  0x26, 0x59, 0xeb, 0x46, 0x2e, 0x58, 0x17, 0x40, 0x9f, 0xdf, 0xe8, 0x99, 0x8d, 0xaa, 0x09, 0x50,
]);

// IID_IShellItemImageFactory {BCC18B79-BA16-442F-80C4-8A59C30C463B}
const IID_IShellItemImageFactory = Uint8Array.from([
  0x79, 0x8b, 0xc1, 0xbc, 0x16, 0xba, 0x2f, 0x44, 0x80, 0xc4, 0x8a, 0x59, 0xc3, 0x0c, 0x46, 0x3b,
]);
const SIIGBF_ICONONLY = 0x4;
let comReady = false;
function ensureCom() {
  if (comReady) return;
  ole32.symbols.CoInitializeEx(null, 2);
  comReady = true;
}
const vcalls = new Map<string, (...args: unknown[]) => number>();
/** Calls slot `index` of a COM object's vtable; `args` are the FFI types after `this`. */
function vcall(obj: Pointer, index: number, args: string[], ...values: unknown[]): number {
  const fn = read.ptr(read.ptr(obj, 0) as unknown as Pointer, index * 8) as unknown as Pointer;
  const key = `${fn}:${args.join(",")}`;
  let call = vcalls.get(key);
  if (!call) {
    call = new CFunction({ ptr: fn, args: ["ptr", ...args] as never, returns: "i32" }) as never;
    vcalls.set(key, call!);
  }
  return call!(obj, ...values);
}
/** Reads a 32 bpp premultiplied DIB (what the shell hands out) as straight-alpha RGBA. */
function bitmapRgba(hbm: Pointer): Pixels | null {
  const bm = new Uint8Array(32);
  if (!gdi32.symbols.GetObjectW(hbm, 32, bm)) return null;
  const bv = new DataView(bm.buffer);
  const width = bv.getInt32(4, true);
  const height = Math.abs(bv.getInt32(8, true));
  if (width <= 0 || height <= 0 || width > 1024 || height > 1024) return null;
  const bmi = new Uint8Array(40 + 1024);
  const v = new DataView(bmi.buffer);
  v.setUint32(0, 40, true);
  v.setInt32(4, width, true);
  v.setInt32(8, -height, true);
  v.setUint16(12, 1, true);
  v.setUint16(14, 32, true);
  const px = new Uint8Array(width * height * 4);
  const dc = user32.symbols.GetDC(null) as Pointer;
  try {
    if (!gdi32.symbols.GetDIBits(dc, hbm, 0, height, px, bmi, 0)) return null;
  } finally {
    user32.symbols.ReleaseDC(null, dc);
  }
  let anyAlpha = false;
  for (let i = 3; i < px.length; i += 4) if (px[i]) { anyAlpha = true; break; }
  const rgba = new Uint8Array(px.length);
  for (let o = 0; o < px.length; o += 4) {
    const a = anyAlpha ? px[o + 3]! : 255;
    if (!a) continue;
    const k = anyAlpha ? 255 / a : 1;
    rgba[o] = Math.min(255, Math.round(px[o + 2]! * k));
    rgba[o + 1] = Math.min(255, Math.round(px[o + 1]! * k));
    rgba[o + 2] = Math.min(255, Math.round(px[o]! * k));
    rgba[o + 3] = a;
  }
  return { width, height, rgba };
}
/**
 * The icon the shell itself draws for `path` (exe, lnk, shell:AppsFolder\\<AUMID>), through
 * IShellItemImageFactory: the path Explorer, Start and the taskbar use. It picks the icon frame (or
 * the Store app's targetsize asset) for the size and scales it with the shell's own filter.
 */
function factoryIcon(path: string, size: number): Pixels | null {
  // The shell scales its nearest frame to the size asked for with a coarse filter: a 32 px frame
  // drawn at 30 px (24 px icons at 125 %) keeps stair-stepped edges. Asked at a standard frame
  // at least 1.5x as large (48 for 30) and area-filtered down here, edges come out smooth and the
  // small-size designs (cmd's prompt) are kept, which the 256 px frame would lose.
  const source = SOURCE_FRAMES.find((frame) => frame === size || frame >= size * 1.5) ?? 256;
  const group = iconGroupIndex(path);
  const px = group > 0 ? extractedIcon(path, group, source) : factoryImage(path, source);
  return px && px.width > size ? downscale(px, size) : px;
}

const RT_ICON = 3;
const RT_GROUP_ICON = 14;
const LOAD_LIBRARY_AS_DATAFILE = 0x2;
const LOAD_LIBRARY_AS_IMAGE_RESOURCE = 0x20;
const groupIndexes = new Map<string, number>();
let groupCallback: JSCallback | null = null;
let groupSeen = 0;
let groupFound = -1;

/**
 * Index of the icon group the taskbar draws for an .exe or .dll: the first intact one.
 * Bun's `--windows-icon` leaves Bun's own group first, its single "256 px" entry now pointing at
 * the app's 16 px frame (their RT_ICON ids collide), so the frame no longer has the entry's size.
 * The shell's extraction (index 0) upscales that 16 px frame; the taskbar skips the group and
 * draws the app's own one. 0 for every well-formed file.
 */
function iconGroupIndex(path: string): number {
  if (!/\.(exe|dll)$/i.test(path)) return 0;
  const key = path.toLowerCase();
  const cached = groupIndexes.get(key);
  if (cached !== undefined) return cached;
  let index = 0;
  const module = kernel32.symbols.LoadLibraryExW(encodeWide(path), null, LOAD_LIBRARY_AS_DATAFILE | LOAD_LIBRARY_AS_IMAGE_RESOURCE) as Pointer | null;
  if (module) {
    try {
      groupCallback ??= new JSCallback(
        (mod: Pointer, _type: Pointer, name: Pointer) => {
          if (groupIntact(mod, name)) {
            groupFound = groupSeen;
            return 0;
          }
          groupSeen++;
          return 1;
        },
        { args: ["ptr", "ptr", "ptr", "ptr"], returns: "i32" },
      );
      groupSeen = 0;
      groupFound = -1;
      kernel32.symbols.EnumResourceNamesW(module, RT_GROUP_ICON, groupCallback, null);
      if (groupFound > 0) index = groupFound;
    } finally {
      kernel32.symbols.FreeLibrary(module);
    }
  }
  groupIndexes.set(key, index);
  return index;
}

/** Every frame of icon group `name` exists with the byte size its directory entry gives. */
function groupIntact(mod: Pointer, name: Pointer): boolean {
  const k = kernel32.symbols;
  const info = k.FindResourceW(mod, name, RT_GROUP_ICON) as Pointer | null;
  const dir = info ? (k.LockResource(k.LoadResource(mod, info)) as Pointer | null) : null;
  if (!info || !dir) return false;
  const size = k.SizeofResource(mod, info) as number;
  const count = read.u16(dir, 4);
  if (!count || 6 + count * 14 > size) return false;
  for (let i = 0; i < count; i++) {
    const entry = 6 + i * 14;
    const frame = k.FindResourceW(mod, read.u16(dir, entry + 12), RT_ICON) as Pointer | null;
    if (!frame || k.SizeofResource(mod, frame) !== read.u32(dir, entry + 8)) return false;
  }
  return true;
}

/** Icon group `index` of an .exe/.dll at `size` px, the frame picked by user32 as for any icon resource. */
function extractedIcon(path: string, index: number, size: number): Pixels | null {
  const handle = new BigUint64Array(1);
  const id = new Uint32Array(1);
  const count = user32.symbols.PrivateExtractIconsW(encodeWide(path), index, size, size, new Uint8Array(handle.buffer), new Uint8Array(id.buffer), 1, 0);
  if (!count || count === 0xffffffff || !handle[0]) return null;
  try {
    return iconPixels(Number(handle[0]));
  } finally {
    user32.symbols.DestroyIcon(Number(handle[0]) as unknown as Pointer);
  }
}
/** Shell icon frame sizes (what .ico files carry and the shell renders without scaling). */
const SOURCE_FRAMES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];
function factoryImage(path: string, size: number): Pixels | null {
  ensureCom();
  const out = new BigUint64Array(1);
  if (shell32.symbols.SHCreateItemFromParsingName(encodeWide(path), null, IID_IShellItemImageFactory, new Uint8Array(out.buffer)) !== 0 || !out[0]) return null;
  const factory = Number(out[0]) as unknown as Pointer;
  try {
    out[0] = 0n;
    const dims = BigInt(size) | (BigInt(size) << 32n);
    // IShellItemImageFactory::GetImage(SIZE by value, flags, HBITMAP*): slot 3.
    if (vcall(factory, 3, ["u64", "u32", "ptr"], dims, SIIGBF_ICONONLY, new Uint8Array(out.buffer)) !== 0 || !out[0]) return null;
    // GDI handles are sign-extended; the low 32 bits are the handle.
    const hbm = Number(out[0] & 0xffffffffn) as unknown as Pointer;
    try {
      return bitmapRgba(hbm);
    } finally {
      gdi32.symbols.DeleteObject(hbm);
    }
  } finally {
    vcall(factory, 2, []);
  }
}
const lists = new Map<number, Pointer | null>();
const getIcons = new Map<number, (self: Pointer, i: number, flags: number, out: Uint8Array) => number>();

function imageList(kind: number) {
  if (lists.has(kind)) return lists.get(kind)!;
  ensureCom();
  const out = new BigUint64Array(1);
  const ok = shell32.symbols.SHGetImageList(kind, IID_IImageList, new Uint8Array(out.buffer)) === 0 && out[0] !== 0n;
  const list = ok ? (Number(out[0]) as unknown as Pointer) : null;
  lists.set(kind, list);
  if (list) {
    // IImageList::GetIcon is the 11th vtable slot (IUnknown's 3, then Add … Remove).
    const vtable = read.ptr(list, 0) as unknown as Pointer;
    const fn = read.ptr(vtable, 10 * 8) as unknown as Pointer;
    try {
      const call = new CFunction({ ptr: fn, args: ["ptr", "i32", "u32", "ptr"], returns: "i32" });
      getIcons.set(kind, call as unknown as (self: Pointer, i: number, flags: number, out: Uint8Array) => number);
    } catch (error) {
      if (!(error instanceof FfiUnsupported)) throw error;
      lists.set(kind, null);
      return null;
    }
  }
  return list;
}

function systemIndex(path: string): number {
  const sfi = new Uint8Array(696);
  const wide = encodeWide(path);
  // shell:AppsFolder\<AUMID> (Store apps such as Settings) is no file path: go through its PIDL.
  if (/^shell:/i.test(path)) {
    ensureCom();
    const out = new BigUint64Array(1);
    if (shell32.symbols.SHParseDisplayName(ptr(wide), null, new Uint8Array(out.buffer), 0, null) !== 0 || !out[0]) return -1;
    const pidl = Number(out[0]) as unknown as Pointer;
    try {
      if (!shell32.symbols.SHGetFileInfoW(pidl, 0, sfi, sfi.length, SHGFI_SYSICONINDEX | SHGFI_PIDL)) return -1;
    } finally {
      ole32.symbols.CoTaskMemFree(pidl);
    }
    return new DataView(sfi.buffer).getInt32(8, true);
  }
  if (!shell32.symbols.SHGetFileInfoW(ptr(wide), 0, sfi, sfi.length, SHGFI_SYSICONINDEX)) return -1;
  return new DataView(sfi.buffer).getInt32(8, true);
}

type Pixels = { width: number; height: number; rgba: Uint8Array };

function listIcon(kind: number, index: number): Pixels | null {
  const list = imageList(kind);
  const getIcon = getIcons.get(kind);
  if (!list || !getIcon) return null;
  const out = new BigUint64Array(1);
  if (getIcon(list, index, ILD_TRANSPARENT, new Uint8Array(out.buffer)) !== 0 || !out[0]) return null;
  const hicon = Number(out[0]);
  try {
    return iconPixels(hicon);
  } finally {
    user32.symbols.DestroyIcon(hicon as unknown as Pointer);
  }
}

/** Side of the opaque content: a file without a 256 px frame sits small in the jumbo icon's corner. */
function contentExtent(px: Pixels) {
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < px.height; y++)
    for (let x = 0; x < px.width; x++)
      if (px.rgba[(y * px.width + x) * 4 + 3]! > 8) {
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
  return Math.max(maxX, maxY) + 1;
}

/** Area-averaging downscale in premultiplied alpha (no dark fringes, no aliasing). */
function downscale(src: Pixels, size: number): Pixels {
  const { width: sw, height: sh, rgba } = src;
  if (sw <= size && sh <= size) return src;
  const sx = sw / size;
  const sy = sh / size;
  const acc = new Float64Array(size * size * 4);
  for (let dy = 0; dy < size; dy++) {
    const y0 = dy * sy;
    const y1 = y0 + sy;
    for (let y = Math.floor(y0); y < Math.ceil(y1) && y < sh; y++) {
      const wy = Math.min(y + 1, y1) - Math.max(y, y0);
      for (let dx = 0; dx < size; dx++) {
        const x0 = dx * sx;
        const x1 = x0 + sx;
        const o = (dy * size + dx) * 4;
        for (let x = Math.floor(x0); x < Math.ceil(x1) && x < sw; x++) {
          const w = wy * (Math.min(x + 1, x1) - Math.max(x, x0));
          const i = (y * sw + x) * 4;
          const a = (rgba[i + 3]! / 255) * w;
          acc[o] = acc[o]! + rgba[i]! * a;
          acc[o + 1] = acc[o + 1]! + rgba[i + 1]! * a;
          acc[o + 2] = acc[o + 2]! + rgba[i + 2]! * a;
          acc[o + 3] = acc[o + 3]! + a;
        }
      }
    }
  }
  const area = sx * sy;
  const out = new Uint8Array(size * size * 4);
  for (let o = 0; o < out.length; o += 4) {
    const a = acc[o + 3]!;
    if (a <= 0) continue;
    out[o] = Math.round(acc[o]! / a);
    out[o + 1] = Math.round(acc[o + 1]! / a);
    out[o + 2] = Math.round(acc[o + 2]! / a);
    out[o + 3] = Math.round((a / area) * 255);
  }
  return { width: size, height: size, rgba: out };
}

/** Physical pixels per logical pixel on the primary display. */
export function systemScale() {
  try {
    return (user32.symbols.GetDpiForSystem() || 96) / 96;
  } catch {
    return 1;
  }
}

/** The file's shell icon as RGBA at `size` physical pixels, or null when the shell has none. */
export function shellIconPixels(path: string, size: number): Pixels | null {
  try {
    const px = factoryIcon(path, size);
    if (px) return px;
  } catch (error) {
    if (!(error instanceof FfiUnsupported)) throw error;
  }
  // Fallback: the system image lists (SHGetFileInfo), read at the closest frame.
  const index = systemIndex(path);
  if (index < 0) return null;
  // Smallest list that still covers the size; the jumbo list only when its frame is real.
      const order = size <= 16 ? [SHIL_SMALL, SHIL_LARGE, SHIL_EXTRALARGE] : size <= 32 ? [SHIL_LARGE, SHIL_EXTRALARGE] : [SHIL_EXTRALARGE];
  if (size > 48) order.unshift(SHIL_JUMBO);
  let fallback: Pixels | null = null;
  for (const kind of size > 48 ? order : [...order, SHIL_JUMBO]) {
        const px = listIcon(kind, index);
        if (!px) continue;
        if (kind === SHIL_JUMBO && contentExtent(px) <= 64) continue;
        if (px.width >= size) return downscale(px, size);
        if (!fallback || px.width > fallback.width) fallback = px;
      }
      return fallback;
}
