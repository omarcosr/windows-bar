import { CFunction, dlopen, read, toArrayBuffer, FfiUnsupported, type Pointer } from "./ffi";
import { decodeWide, encodeWide } from "./wide";

/*
 * Native side of the "actions" widgets, each through the API the Windows shell itself uses:
 * Core Audio endpoints (quick settings' speaker and microphone), the display brightness IOCTL
 * (laptop panels) or DDC/CI (external monitors), the Personalize registry values plus the
 * "ImmersiveColorSet" broadcast (Settings > Colors), ITipInvocation (the taskbar's touch keyboard
 * button), SHQueryRecycleBin / SHEmptyRecycleBin (Explorer) and IDesktopWallpaper (Settings >
 * Background).
 */

const ole32 = dlopen("ole32.dll", {
  CoInitializeEx: { args: ["ptr", "u32"], returns: "i32" },
  CoCreateInstance: { args: ["ptr", "ptr", "u32", "ptr", "ptr"], returns: "i32" },
  CoTaskMemFree: { args: ["ptr"], returns: "void" },
  PropVariantClear: { args: ["ptr"], returns: "i32" },
});
const user32 = dlopen("user32.dll", {
  GetDesktopWindow: { args: [], returns: "ptr" },
  SendMessageTimeoutW: { args: ["ptr", "u32", "u64", "ptr", "u32", "u32", "ptr"], returns: "i64" },
  MonitorFromPoint: { args: ["i64", "u32"], returns: "ptr" },
});
const dxva2 = dlopen("dxva2.dll", {
  GetNumberOfPhysicalMonitorsFromHMONITOR: { args: ["ptr", "ptr"], returns: "i32" },
  GetPhysicalMonitorsFromHMONITOR: { args: ["ptr", "u32", "ptr"], returns: "i32" },
  DestroyPhysicalMonitors: { args: ["u32", "ptr"], returns: "i32" },
  GetMonitorBrightness: { args: ["i64", "ptr", "ptr", "ptr"], returns: "i32" },
  SetMonitorBrightness: { args: ["i64", "u32"], returns: "i32" },
});
const kernel32 = dlopen("kernel32.dll", {
  CreateFileW: { args: ["ptr", "u32", "u32", "ptr", "u32", "u32", "ptr"], returns: "i64" },
  DeviceIoControl: { args: ["i64", "u32", "ptr", "u32", "ptr", "u32", "ptr", "ptr"], returns: "i32" },
  CloseHandle: { args: ["i64"], returns: "i32" },
  GetSystemPowerStatus: { args: ["ptr"], returns: "i32" },
  GetLogicalDrives: { args: [], returns: "u32" },
  GetDriveTypeW: { args: ["ptr"], returns: "u32" },
});
const advapi32 = dlopen("advapi32.dll", {
  RegGetValueW: { args: ["i64", "ptr", "ptr", "u32", "ptr", "ptr", "ptr"], returns: "i32" },
  RegSetKeyValueW: { args: ["i64", "ptr", "ptr", "u32", "ptr", "u32"], returns: "i32" },
});
const shell32 = dlopen("shell32.dll", {
  SHQueryRecycleBinW: { args: ["ptr", "ptr"], returns: "i32" },
  SHEmptyRecycleBinW: { args: ["ptr", "ptr", "u32"], returns: "i32" },
  SHGetKnownFolderPath: { args: ["ptr", "u32", "ptr", "ptr"], returns: "i32" },
});

// ---------- COM ----------

function guid(s: string) {
  const h = s.replace(/[{}-]/g, "");
  const b = new Uint8Array(16);
  const v = new DataView(b.buffer);
  v.setUint32(0, parseInt(h.slice(0, 8), 16), true);
  v.setUint16(4, parseInt(h.slice(8, 12), 16), true);
  v.setUint16(6, parseInt(h.slice(12, 16), 16), true);
  for (let i = 0; i < 8; i++) b[8 + i] = parseInt(h.slice(16 + i * 2, 18 + i * 2), 16);
  return b;
}

const calls = new Map<string, (...args: unknown[]) => number>();

/** Calls slot `index` of a COM object's vtable; `args` are the FFI types after `this`. */
function com(obj: Pointer, index: number, args: string[], ...values: unknown[]): number {
  const vtbl = read.ptr(obj, 0) as Pointer;
  const fn = read.ptr(vtbl, index * 8) as Pointer;
  const key = `${fn}:${args.join(",")}`;
  let call = calls.get(key);
  if (!call) {
    call = new CFunction({ ptr: fn, args: ["ptr", ...args] as never, returns: "i32" }) as never;
    calls.set(key, call!);
  }
  return call!(obj, ...values.map((value) => (ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : value)));
}

const release = (obj: Pointer) => com(obj, 2, []);
let comReady = false;

function create(clsid: Uint8Array, iid: Uint8Array, context = 0x17 /* CLSCTX_ALL */): Pointer | null {
  if (!comReady) {
    ole32.symbols.CoInitializeEx(null, 2 /* COINIT_APARTMENTTHREADED */);
    comReady = true;
  }
  const out = new BigUint64Array(1);
  if (ole32.symbols.CoCreateInstance(clsid, null, context, iid, new Uint8Array(out.buffer)) !== 0 || !out[0]) return null;
  return Number(out[0]) as Pointer;
}

/** A NUL-terminated UTF-16 string at `address`. */
function wideAt(address: Pointer, max = 1024): string {
  let length = 0;
  while (length < max && read.u16(address, length * 2) !== 0) length++;
  return length ? decodeWide(toArrayBuffer(address, 0, length * 2), 0, length * 2) : "";
}

/** A CoTaskMem string out-parameter: read, then freed. */
function takeString(out: BigUint64Array): string {
  if (!out[0]) return "";
  const address = Number(out[0]) as Pointer;
  try {
    return wideAt(address);
  } finally {
    ole32.symbols.CoTaskMemFree(address);
  }
}

// ---------- Microphone (default capture endpoint) ----------

const CLSID_MMDeviceEnumerator = guid("BCDE0395-E52F-467C-8E3D-C4579291692E");
const IID_IMMDeviceEnumerator = guid("A95664D2-9614-4F35-A746-DE8DB63617E6");
const IID_IAudioEndpointVolume = guid("5CDF2C82-841E-4546-9722-0CF74078229A");
const PKEY_Device_FriendlyName = new Uint8Array([...guid("A45C254E-DF1C-4EFD-8020-67D146A850E0"), 14, 0, 0, 0]);
let enumerator: Pointer | null = null;
let micName = { name: "", at: 0 };

function friendlyName(device: Pointer): string {
  const out = new BigUint64Array(1);
  if (com(device, 4, ["u32", "ptr"], 0 /* STGM_READ */, out) !== 0 || !out[0]) return "";
  const store = Number(out[0]) as Pointer;
  try {
    const value = new Uint8Array(24);
    if (com(store, 5, ["ptr", "ptr"], PKEY_Device_FriendlyName, value) !== 0) return "";
    try {
      const view = new DataView(value.buffer);
      if (view.getUint16(0, true) !== 31 /* VT_LPWSTR */) return "";
      return wideAt(Number(view.getBigUint64(8, true)) as Pointer, 256);
    } finally {
      ole32.symbols.PropVariantClear(value);
    }
  } finally {
    release(store);
  }
}

/** Runs `fn` on the default capture device's IAudioEndpointVolume (eCapture, eConsole); null without one. */
function withMicrophone<T>(fn: (volume: Pointer, device: Pointer) => T): T | null {
  try {
    enumerator ??= create(CLSID_MMDeviceEnumerator, IID_IMMDeviceEnumerator);
    if (!enumerator) return null;
    const out = new BigUint64Array(1);
    if (com(enumerator, 4, ["i32", "i32", "ptr"], 1 /* eCapture */, 0 /* eConsole */, out) !== 0 || !out[0]) return null;
    const device = Number(out[0]) as Pointer;
    try {
      out[0] = 0n;
      if (com(device, 3, ["ptr", "u32", "ptr", "ptr"], IID_IAudioEndpointVolume, 0x17, null, out) !== 0 || !out[0]) return null;
      const volume = Number(out[0]) as Pointer;
      try {
        return fn(volume, device);
      } finally {
        release(volume);
      }
    } finally {
      release(device);
    }
  } catch (error) {
    if (error instanceof FfiUnsupported) return null;
    throw error;
  }
}

/** Input level (0..100), mute and name of the default microphone, or null without one. */
export function readMicrophone(): { level: number; muted: boolean; device: string } | null {
  return withMicrophone((volume, device) => {
    const level = new Float32Array(1);
    const muted = new Int32Array(1);
    com(volume, 9, ["ptr"], level); // GetMasterVolumeLevelScalar
    com(volume, 15, ["ptr"], muted); // GetMute
    if (Date.now() - micName.at > 10_000) micName = { name: friendlyName(device), at: Date.now() };
    return { level: Math.round(level[0]! * 100), muted: !!muted[0], device: micName.name };
  });
}

/** Mutes or unmutes the default microphone (IAudioEndpointVolume::SetMute), as quick settings does. */
export function setMicrophoneMuted(muted: boolean): boolean {
  return withMicrophone((volume) => com(volume, 14, ["i32", "ptr"], muted ? 1 : 0, null) >= 0) ?? false;
}

// ---------- Brightness ----------

export type BrightnessSource = "panel" | "ddc";

/** AC power: the panel IOCTL keeps one level for AC and one for battery. */
function onAc() {
  const status = new Uint8Array(12);
  return !kernel32.symbols.GetSystemPowerStatus(status) || status[0] !== 0;
}

const IOCTL_VIDEO_QUERY_SUPPORTED_BRIGHTNESS = 0x230494;
const IOCTL_VIDEO_QUERY_DISPLAY_BRIGHTNESS = 0x230498;
const IOCTL_VIDEO_SET_DISPLAY_BRIGHTNESS = 0x23049c;

/** The built-in panel's brightness device (\\.\LCD), opened per call. */
function withPanel<T>(fn: (handle: bigint) => T): T | null {
  const handle = BigInt(kernel32.symbols.CreateFileW(encodeWide("\\\\.\\LCD"), 0xc0000000, 3, null, 3 /* OPEN_EXISTING */, 0, null));
  if (handle === -1n || handle === 0n) return null;
  try {
    return fn(handle);
  } finally {
    kernel32.symbols.CloseHandle(handle);
  }
}

function panelLevels(handle: bigint): number[] {
  const levels = new Uint8Array(256);
  const size = new Uint32Array(1);
  if (!kernel32.symbols.DeviceIoControl(handle, IOCTL_VIDEO_QUERY_SUPPORTED_BRIGHTNESS, null, 0, levels, 256, new Uint8Array(size.buffer), null)) return [];
  return [...levels.slice(0, size[0])].sort((a, b) => a - b);
}

function readPanel(): number | null {
  return withPanel((handle) => {
    const value = new Uint8Array(3);
    const size = new Uint32Array(1);
    if (!kernel32.symbols.DeviceIoControl(handle, IOCTL_VIDEO_QUERY_DISPLAY_BRIGHTNESS, null, 0, value, 3, new Uint8Array(size.buffer), null)) return null;
    return onAc() ? value[1]! : value[2]!;
  });
}

function setPanel(level: number): boolean {
  return (
    withPanel((handle) => {
      const levels = panelLevels(handle);
      // Snap to a level the panel supports.
      const target = levels.length ? levels.reduce((best, l) => (Math.abs(l - level) < Math.abs(best - level) ? l : best), levels[0]!) : level;
      const ac = onAc();
      const value = new Uint8Array([ac ? 1 /* DISPLAYPOLICY_AC */ : 2 /* DISPLAYPOLICY_DC */, ac ? target : 0, ac ? 0 : target]);
      const size = new Uint32Array(1);
      return !!kernel32.symbols.DeviceIoControl(handle, IOCTL_VIDEO_SET_DISPLAY_BRIGHTNESS, value, 3, null, 0, new Uint8Array(size.buffer), null);
    }) ?? false
  );
}

/** DDC/CI monitors of the primary display (PHYSICAL_MONITOR: HANDLE + WCHAR[128], packed). */
function withDdc<T>(fn: (handles: bigint[]) => T): T | null {
  const monitor = user32.symbols.MonitorFromPoint(0, 1 /* MONITOR_DEFAULTTOPRIMARY */);
  if (!monitor) return null;
  const count = new Uint32Array(1);
  if (!dxva2.symbols.GetNumberOfPhysicalMonitorsFromHMONITOR(monitor, new Uint8Array(count.buffer)) || !count[0]) return null;
  const list = new Uint8Array(count[0] * 264);
  if (!dxva2.symbols.GetPhysicalMonitorsFromHMONITOR(monitor, count[0], list)) return null;
  try {
    const view = new DataView(list.buffer);
    return fn(Array.from({ length: count[0] }, (_, i) => view.getBigUint64(i * 264, true)));
  } finally {
    dxva2.symbols.DestroyPhysicalMonitors(count[0], list);
  }
}

function ddcRange(handle: bigint) {
  const v = new Uint32Array(3);
  const at = (i: number) => new Uint8Array(v.buffer, i * 4, 4);
  if (!dxva2.symbols.GetMonitorBrightness(handle, at(0), at(1), at(2)) || v[2]! <= v[0]!) return null;
  return { min: v[0]!, current: v[1]!, max: v[2]! };
}

function readDdc(): number | null {
  return withDdc((handles) => {
    for (const handle of handles) {
      const range = ddcRange(handle);
      if (range) return Math.round(((range.current - range.min) / (range.max - range.min)) * 100);
    }
    return null;
  });
}

function setDdc(level: number): boolean {
  return (
    withDdc((handles) => {
      let ok = false;
      for (const handle of handles) {
        const range = ddcRange(handle);
        if (range && dxva2.symbols.SetMonitorBrightness(handle, Math.round(range.min + (level / 100) * (range.max - range.min)))) ok = true;
      }
      return ok;
    }) ?? false
  );
}

/** Brightness (0..100) of the built-in panel, else of the primary DDC/CI monitor; null when neither answers. */
export function readBrightness(): { source: BrightnessSource; level: number } | null {
  try {
    const panel = readPanel();
    if (panel !== null) return { source: "panel", level: panel };
    const ddc = readDdc();
    return ddc === null ? null : { source: "ddc", level: ddc };
  } catch (error) {
    console.error("[actions] brilho", error);
    return null;
  }
}

export function setBrightness(source: BrightnessSource, level: number): boolean {
  const value = Math.round(Math.max(0, Math.min(100, level)));
  try {
    return source === "panel" ? setPanel(value) : setDdc(value);
  } catch (error) {
    console.error("[actions] brilho", error);
    return false;
  }
}

// ---------- Light / dark theme ----------

const HKCU = -2147483647; // HKEY_CURRENT_USER (0x80000001, sign-extended)
const PERSONALIZE = encodeWide("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize");

function regDword(name: string): number | null {
  const data = new Uint32Array(1);
  const size = new Uint32Array([4]);
  return advapi32.symbols.RegGetValueW(HKCU, PERSONALIZE, encodeWide(name), 0x10 /* RRF_RT_REG_DWORD */, null, new Uint8Array(data.buffer), new Uint8Array(size.buffer)) === 0 ? data[0]! : null;
}

/** Whether apps and Windows (taskbar, Start) use the light theme. */
export function readTheme(): { appsLight: boolean; systemLight: boolean } {
  return { appsLight: (regDword("AppsUseLightTheme") ?? 1) !== 0, systemLight: (regDword("SystemUsesLightTheme") ?? 0) !== 0 };
}

/**
 * Settings > Personalization > Colors "Escolha seu modo": both Personalize values, then the
 * WM_SETTINGCHANGE "ImmersiveColorSet" broadcast that makes the shell and apps repaint.
 */
export function setLightTheme(light: boolean): boolean {
  const value = new Uint32Array([light ? 1 : 0]);
  let ok = true;
  for (const name of ["AppsUseLightTheme", "SystemUsesLightTheme"]) {
    if (advapi32.symbols.RegSetKeyValueW(HKCU, PERSONALIZE, encodeWide(name), 4 /* REG_DWORD */, new Uint8Array(value.buffer), 4) !== 0) ok = false;
  }
  const result = new Uint8Array(8);
  user32.symbols.SendMessageTimeoutW(0xffff /* HWND_BROADCAST */, 0x1a /* WM_SETTINGCHANGE */, 0n, encodeWide("ImmersiveColorSet"), 0x2 /* SMTO_ABORTIFHUNG */, 200, result);
  return ok;
}

// ---------- Touch keyboard ----------

const CLSID_UIHostNoLaunch = guid("4CE576FA-83DC-4F88-951C-9D0782B4E376");
const IID_ITipInvocation = guid("37C994E7-432B-4834-A2F7-DCE1F13B834B");

/**
 * The taskbar's touch keyboard button: ITipInvocation::Toggle(desktop window) on the running
 * TabTip server. False when the server is not running (the caller starts TabTip.exe and retries).
 */
export function toggleTouchKeyboard(): boolean {
  try {
    const tip = create(CLSID_UIHostNoLaunch, IID_ITipInvocation, 4 /* CLSCTX_LOCAL_SERVER */);
    if (!tip) return false;
    try {
      return com(tip, 3, ["ptr"], user32.symbols.GetDesktopWindow()) >= 0;
    } finally {
      release(tip);
    }
  } catch (error) {
    if (error instanceof FfiUnsupported) return false;
    throw error;
  }
}

// ---------- Recycle Bin ----------

/** Items and bytes in the Recycle Bin of every drive (SHQueryRecycleBinW, as Explorer). */
export function recycleBinInfo(): { items: number; bytes: number } | null {
  const info = new Uint8Array(24); // SHQUERYRBINFO: cbSize, then two 8-aligned __int64
  const view = new DataView(info.buffer);
  view.setUint32(0, 24, true);
  if (shell32.symbols.SHQueryRecycleBinW(null, info) !== 0) return null;
  return { bytes: Number(view.getBigInt64(8, true)), items: Number(view.getBigInt64(16, true)) };
}

/** Roots of the fixed drives ("C:\\"), the ones that keep a Recycle Bin folder. */
export function fixedDrives(): string[] {
  const mask = kernel32.symbols.GetLogicalDrives();
  const roots: string[] = [];
  for (let i = 0; i < 26; i++) {
    if (!(mask & (1 << i))) continue;
    const root = `${String.fromCharCode(65 + i)}:\\`;
    if (kernel32.symbols.GetDriveTypeW(encodeWide(root)) === 3 /* DRIVE_FIXED */) roots.push(root);
  }
  return roots;
}

/** "Esvaziar Lixeira": with Explorer's confirmation, progress and sound (flags 0). */
export function emptyRecycleBin(): boolean {
  return shell32.symbols.SHEmptyRecycleBinW(null, null, 0) >= 0;
}

// ---------- Wallpaper ----------

const CLSID_DesktopWallpaper = guid("C2CF3110-460E-4FC1-B9D0-8A1C0C9CC4BD");
const IID_IDesktopWallpaper = guid("B92B56A9-8B55-4E14-9A89-0199BBB6F93B");
let wallpaper: Pointer | null = null;

/** Runs `fn` on IDesktopWallpaper; a failed call drops the object (Explorer restarted) for the next try. */
function withWallpaper<T>(fn: (w: Pointer) => T | null): T | null {
  try {
    wallpaper ??= create(CLSID_DesktopWallpaper, IID_IDesktopWallpaper);
    if (!wallpaper) return null;
    const result = fn(wallpaper);
    if (result === null && wallpaper) {
      release(wallpaper);
      wallpaper = null;
    }
    return result;
  } catch (error) {
    if (error instanceof FfiUnsupported) return null;
    throw error;
  }
}

/** The current wallpaper file (the first monitor's when they differ) and whether a slideshow runs. */
export function readWallpaper(): { path: string; slideshow: boolean } | null {
  return withWallpaper((w) => {
    const out = new BigUint64Array(1);
    const hr = com(w, 4, ["ptr", "ptr"], null, out); // GetWallpaper(NULL): S_FALSE when monitors differ
    if (hr < 0) return null;
    let path = takeString(out);
    if (!path) {
      out[0] = 0n;
      if (com(w, 5, ["u32", "ptr"], 0, out) >= 0) {
        const monitor = takeString(out);
        out[0] = 0n;
        if (monitor && com(w, 4, ["ptr", "ptr"], encodeWide(monitor), out) >= 0) path = takeString(out);
      }
    }
    const state = new Uint32Array(1);
    com(w, 17, ["ptr"], state); // GetStatus: DSS_ENABLED 1, DSS_SLIDESHOW 2
    return { path, slideshow: (state[0]! & 2) !== 0 };
  });
}

/** Sets `path` on every monitor, as Settings > Background "Procurar fotos". */
export function setWallpaper(path: string): boolean {
  return withWallpaper((w) => (com(w, 3, ["ptr", "ptr"], null, encodeWide(path)) >= 0 ? true : null)) ?? false;
}

/** "Próxima tela de fundo" of the desktop menu while a slideshow runs. */
export function nextWallpaper(): boolean {
  return withWallpaper((w) => (com(w, 16, ["ptr", "i32"], null, 0 /* DSD_FORWARD */) >= 0 ? true : null)) ?? false;
}

/** The user's Pictures folder (FOLDERID_Pictures), wherever it is redirected (OneDrive). */
export function picturesFolder(): string {
  const out = new BigUint64Array(1);
  if (shell32.symbols.SHGetKnownFolderPath(guid("33E28130-4E1E-4676-835A-98395C3BC3BB"), 0, null, new Uint8Array(out.buffer)) !== 0) {
    if (out[0]) ole32.symbols.CoTaskMemFree(Number(out[0]));
    return "";
  }
  return takeString(out);
}
