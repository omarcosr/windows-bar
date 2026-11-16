import { CFunction, dlopen, read, type Pointer } from "bun:ffi";

/** Volume (Core Audio over raw COM vtables), network and keyboard layout, through plain FFI. */

const ole32 = dlopen("ole32.dll", {
  CoInitializeEx: { args: ["ptr", "u32"], returns: "i32" },
  CoCreateInstance: { args: ["ptr", "ptr", "u32", "ptr", "ptr"], returns: "i32" },
});
const iphlpapi = dlopen("iphlpapi.dll", {
  GetNetworkConnectivityHint: { args: ["ptr"], returns: "u32" },
  GetBestInterface: { args: ["u32", "ptr"], returns: "u32" },
  GetIfEntry2: { args: ["ptr"], returns: "u32" },
});
const user32 = dlopen("user32.dll", {
  GetKeyboardLayout: { args: ["u32"], returns: "u64" },
  GetKeyboardLayoutList: { args: ["i32", "ptr"], returns: "i32" },
  GetWindowThreadProcessId: { args: ["ptr", "ptr"], returns: "u32" },
});
const kernel32 = dlopen("kernel32.dll", {
  GetLocaleInfoW: { args: ["u32", "u32", "ptr", "i32"], returns: "i32" },
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

const fnCache = new Map<string, (...args: unknown[]) => number>();

/** Calls slot `index` of a COM object's vtable; `args` are the FFI types after `this`. */
function com(obj: Pointer, index: number, args: string[], ...values: unknown[]): number {
  const vtbl = read.ptr(obj, 0) as Pointer;
  const fn = read.ptr(vtbl, index * 8) as Pointer;
  const key = `${fn}:${args.join(",")}`;
  let call = fnCache.get(key);
  if (!call) {
    call = CFunction({ ptr: fn, args: ["ptr", ...args] as never, returns: "i32" }) as never;
    fnCache.set(key, call!);
  }
  return call!(obj, ...values);
}

const release = (obj: Pointer) => com(obj, 2, []);

const CLSID_MMDeviceEnumerator = guid("BCDE0395-E52F-467C-8E3D-C4579291692E");
const IID_IMMDeviceEnumerator = guid("A95664D2-9614-4F35-A746-DE8DB63617E6");
const IID_IAudioEndpointVolume = guid("5CDF2C82-841E-4546-9722-0CF74078229A");
let comReady = false;
let enumerator: Pointer | null = null;
const out = new BigUint64Array(1);

/** Master volume of the default playback device (0..100), or null without one. */
export function readVolume(): { level: number; muted: boolean } | null {
  if (!comReady) {
    ole32.symbols.CoInitializeEx(null, 2 /* COINIT_APARTMENTTHREADED */);
    comReady = true;
  }
  if (!enumerator) {
    out[0] = 0n;
    if (ole32.symbols.CoCreateInstance(CLSID_MMDeviceEnumerator, null, 0x17, IID_IMMDeviceEnumerator, out) !== 0) return null;
    enumerator = Number(out[0]) as unknown as Pointer;
  }
  out[0] = 0n;
  if (com(enumerator, 4, ["i32", "i32", "ptr"], 0 /* eRender */, 1 /* eMultimedia */, out) !== 0 || !out[0]) return null;
  const device = Number(out[0]) as unknown as Pointer;
  try {
    out[0] = 0n;
    if (com(device, 3, ["ptr", "u32", "ptr", "ptr"], IID_IAudioEndpointVolume, 0x17, null, out) !== 0 || !out[0]) return null;
    const volume = Number(out[0]) as unknown as Pointer;
    try {
      const level = new Float32Array(1);
      const muted = new Int32Array(1);
      com(volume, 9, ["ptr"], level);
      com(volume, 15, ["ptr"], muted);
      return { level: Math.round(level[0]! * 100), muted: !!muted[0] };
    } finally {
      release(volume);
    }
  } finally {
    release(device);
  }
}

// ---------- Network ----------

export type NetworkKind = "wifi" | "ethernet" | "other" | "none";

const hint = new Uint8Array(16);
const ifIndex = new Uint32Array(1);
const ifRow = new Uint8Array(1352);
let wifi = { signal: 100, name: "", at: 0, running: false };

/**
 * Signal and network name of the Wi-Fi connection. The WLAN API blocks for ~400 ms per query,
 * which would stall the dock (and the tray it hosts), so this asks netsh in the background.
 */
function refreshWifi() {
  if (wifi.running || Date.now() - wifi.at < 20_000) return;
  wifi.running = true;
  const proc = Bun.spawn(["netsh", "wlan", "show", "interfaces"], { stdout: "pipe", stderr: "ignore", windowsHide: true });
  new Response(proc.stdout)
    .text()
    .then((text) => {
      const signal = /:\s*(\d+)\s*%/.exec(text);
      const ssid = /^\s*SSID\s*:\s*(.+)$/m.exec(text);
      wifi = { signal: signal ? Number(signal[1]) : wifi.signal, name: ssid?.[1]?.trim() ?? "", at: Date.now(), running: false };
    })
    .catch(() => (wifi = { ...wifi, at: Date.now(), running: false }));
}

export function readNetwork(): { kind: NetworkKind; internet: boolean; signal: number; name: string } {
  let internet = true;
  if (iphlpapi.symbols.GetNetworkConnectivityHint(hint) === 0) {
    const level = new DataView(hint.buffer).getInt32(0, true);
    // 1 none, 2 local only, 3 internet, 4 constrained (captive portal)
    if (level === 1) return { kind: "none", internet: false, signal: 0, name: "" };
    internet = level === 3 || level === 0;
  }
  // The interface the route to the internet goes through; Wi-Fi is IF_TYPE_IEEE80211 (71).
  if (iphlpapi.symbols.GetBestInterface(0x08080808, ifIndex) !== 0) return { kind: "none", internet: false, signal: 0, name: "" };
  ifRow.fill(0);
  const v = new DataView(ifRow.buffer);
  v.setUint32(8, ifIndex[0]!, true);
  let type = 0;
  if (iphlpapi.symbols.GetIfEntry2(ifRow) === 0) type = v.getUint32(1128, true);
  if (type === 71) {
    refreshWifi();
    return { kind: "wifi", internet, signal: wifi.signal, name: wifi.name };
  }
  return { kind: type === 6 ? "ethernet" : "other", internet, signal: 100, name: "" };
}

// ---------- Keyboard layout ----------

const localeBuf = new Uint16Array(128);

function localeInfo(lcid: number, type: number) {
  const n = kernel32.symbols.GetLocaleInfoW(lcid, type, localeBuf, localeBuf.length);
  return n > 1 ? Buffer.from(localeBuf.buffer, 0, (n - 1) * 2).toString("utf16le") : "";
}

/**
 * The input language of `hwnd`'s thread as the Windows tray writes it: the ISO 639-2 language
 * ("POR") and the short layout name ("PTB", numbered when the language has several layouts).
 */
export function keyboardLayout(hwnd: Pointer | null): { language: string; layout: string; name: string; hkl: string } {
  const thread = hwnd ? user32.symbols.GetWindowThreadProcessId(hwnd, null) : 0;
  const hkl = BigInt(user32.symbols.GetKeyboardLayout(thread));
  const langId = Number(hkl & 0xffffn);
  const language = localeInfo(langId, 0x67 /* LOCALE_SISO639LANGNAME2 */).toUpperCase();
  const abbrev = localeInfo(langId, 0x3 /* LOCALE_SABBREVLANGNAME */).toUpperCase();
  const list = new BigUint64Array(16);
  const count = user32.symbols.GetKeyboardLayoutList(16, list);
  // Base layout first (ABNT before ABNT2), so the numbers follow the ones Windows shows.
  const base = (h: bigint) => ((h >> 16n) & 0xffffn) === (h & 0xffffn);
  const same = [...list.slice(0, count)]
    .filter((h) => (h & 0xffffn) === BigInt(langId))
    .sort((a, b) => (base(a) === base(b) ? (a < b ? -1 : 1) : base(a) ? -1 : 1));
  const index = same.indexOf(hkl);
  return {
    language,
    layout: same.length > 1 && index >= 0 ? `${abbrev}${index + 1}` : abbrev,
    // "Português (Brasil)", in the system's own language.
    name: localeInfo(langId, 0x2 /* LOCALE_SLOCALIZEDDISPLAYNAME */),
    hkl: hkl.toString(16),
  };
}
