import { CFunction, dlopen, read, toArrayBuffer, type Pointer, FfiUnsupported } from "./ffi";
import { decodeWide } from "./wide";

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
const wlanapi = dlopen("wlanapi.dll", {
  WlanOpenHandle: { args: ["u32", "ptr", "ptr", "ptr"], returns: "u32" },
  WlanEnumInterfaces: { args: ["ptr", "ptr", "ptr"], returns: "u32" },
  WlanQueryInterface: { args: ["ptr", "ptr", "u32", "ptr", "ptr", "ptr", "ptr"], returns: "u32" },
  WlanFreeMemory: { args: ["ptr"], returns: "void" },
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
    call = new CFunction({ ptr: fn, args: ["ptr", ...args] as never, returns: "i32" }) as never;
    fnCache.set(key, call!);
  }
  return call!(obj, ...values.map(value => ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : value));
}

const release = (obj: Pointer) => com(obj, 2, []);

const CLSID_MMDeviceEnumerator = guid("BCDE0395-E52F-467C-8E3D-C4579291692E");
const IID_IMMDeviceEnumerator = guid("A95664D2-9614-4F35-A746-DE8DB63617E6");
const IID_IAudioEndpointVolume = guid("5CDF2C82-841E-4546-9722-0CF74078229A");
let comReady = false;
let enumerator: Pointer | null = null;
const out = new BigUint64Array(1);

// PKEY_Device_FriendlyName {A45C254E-DF1C-4EFD-8020-67D146A850E0}, 14: "Alto-falantes (Realtek(R) Audio)".
const PKEY_Device_FriendlyName = new Uint8Array([...guid("A45C254E-DF1C-4EFD-8020-67D146A850E0"), 14, 0, 0, 0]);
const ole32Props = dlopen("ole32.dll", { PropVariantClear: { args: ["ptr"], returns: "i32" } });
let deviceCache = { name: "", at: 0 };

/** The default device's name as the volume tip shows it; re-read every 10 s (it rarely changes). */
function deviceName(device: Pointer): string {
  if (Date.now() - deviceCache.at < 10_000) return deviceCache.name;
  deviceCache.at = Date.now();
  out[0] = 0n;
  if (com(device, 4, ["u32", "ptr"], 0 /* STGM_READ */, out) !== 0 || !out[0]) return "";
  const store = Number(out[0]) as unknown as Pointer;
  try {
    const value = new Uint8Array(24);
    if (com(store, 5, ["ptr", "ptr"], PKEY_Device_FriendlyName, value) !== 0) return deviceCache.name;
    try {
      const view = new DataView(value.buffer);
      if (view.getUint16(0, true) !== 31 /* VT_LPWSTR */) return "";
      const text = Number(view.getBigUint64(8, true));
      let length = 0;
      while (length < 256 && read.u16(text, length * 2) !== 0) length++;
      deviceCache.name = decodeWide(toArrayBuffer(text, 0, length * 2), 0, length * 2);
      return deviceCache.name;
    } finally {
      ole32Props.symbols.PropVariantClear(value);
    }
  } finally {
    release(store);
  }
}

/** Runs `fn` on the default playback device's IAudioEndpointVolume (the one the taskbar's speaker drives); null without one. */
function withEndpoint<T>(fn: (volume: Pointer, device: Pointer) => T, fresh = false): T | null {
  try {
    if (!comReady) {
      ole32.symbols.CoInitializeEx(null, 2 /* COINIT_APARTMENTTHREADED */);
      comReady = true;
    }
    if (!enumerator) {
      out[0] = 0n;
      if (ole32.symbols.CoCreateInstance(CLSID_MMDeviceEnumerator, null, 0x17, IID_IMMDeviceEnumerator, new Uint8Array(out.buffer)) !== 0) return null;
      enumerator = Number(out[0]) as unknown as Pointer;
    }
    // Finding the default device and activating its volume asks the audio service (~2 ms): the
    // pair is kept for 5 s, so a new default device shows within 5 s; changes always re-resolve.
    if (fresh || !endpoint || Date.now() - endpoint.at > 5_000) {
      dropEndpoint();
      out[0] = 0n;
      if (com(enumerator, 4, ["i32", "i32", "ptr"], 0 /* eRender */, 1 /* eMultimedia */, out) !== 0 || !out[0]) return null;
      const device = Number(out[0]) as unknown as Pointer;
      out[0] = 0n;
      if (com(device, 3, ["ptr", "u32", "ptr", "ptr"], IID_IAudioEndpointVolume, 0x17, null, out) !== 0 || !out[0]) {
        release(device);
        return null;
      }
      endpoint = { device, volume: Number(out[0]) as unknown as Pointer, at: Date.now() };
    }
    return fn(endpoint.volume, endpoint.device);
  } catch (error) {
    if (error instanceof FfiUnsupported) return null;
    throw error;
  }
}

let endpoint: { device: Pointer; volume: Pointer; at: number } | null = null;

function dropEndpoint() {
  if (!endpoint) return;
  release(endpoint.volume);
  release(endpoint.device);
  endpoint = null;
}

/** Master volume of the default playback device (0..100) and its name, or null without one. */
export function readVolume(): { level: number; muted: boolean; device: string } | null {
  return withEndpoint((volume, device) => {
    const level = new Float32Array(1);
    const muted = new Int32Array(1);
    com(volume, 9, ["ptr"], level); // GetMasterVolumeLevelScalar
    com(volume, 15, ["ptr"], muted); // GetMute
    return { level: Math.round(level[0]! * 100), muted: !!muted[0], device: deviceName(device) };
  });
}

/** Sets the master volume (0..100), as the quick settings slider does; unmutes like it when raised. */
export function setVolume(level: number): boolean {
  const scalar = Math.max(0, Math.min(100, level)) / 100;
  return (
    withEndpoint((volume) => {
      const ok = com(volume, 7, ["f32", "ptr"], scalar, null) >= 0; // SetMasterVolumeLevelScalar
      if (scalar > 0) com(volume, 14, ["i32", "ptr"], 0, null); // SetMute(FALSE)
      return ok;
    }, true) ?? false
  );
}

/** Mutes or unmutes the default playback device, as the speaker button in quick settings. */
export function setMuted(muted: boolean): boolean {
  return withEndpoint((volume) => com(volume, 14, ["i32", "ptr"], muted ? 1 : 0, null) >= 0, true) ?? false; // SetMute (S_FALSE: already so)
}

// ---------- Network ----------

export type NetworkKind = "wifi" | "ethernet" | "other" | "none";

const hint = new Uint8Array(16);
const ifIndex = new Uint32Array(1);
const ifRow = new Uint8Array(1352);
let wifi = { signal: 100, name: "", at: 0 };

let wlan: number | null | undefined;

/**
 * Signal quality and SSID of the connected Wi-Fi interface, from the WLAN service (the source the
 * taskbar's network icon uses): WlanQueryInterface(wlan_intf_opcode_current_connection). It answers
 * from the service's cached state (well under a millisecond), so it is read every 5 s.
 */
function refreshWifi() {
  if (Date.now() - wifi.at < 5_000) return;
  wifi.at = Date.now();
  const W = wlanapi.symbols;
  if (wlan === undefined) {
    const version = new Uint32Array(1);
    const handle = new BigUint64Array(1);
    wlan = W.WlanOpenHandle(2, null, new Uint8Array(version.buffer), new Uint8Array(handle.buffer)) === 0 ? Number(handle[0]) : null;
  }
  if (!wlan) return;
  const list = new BigUint64Array(1);
  if (W.WlanEnumInterfaces(wlan, null, new Uint8Array(list.buffer)) !== 0 || !list[0]) return;
  const interfaces = Number(list[0]);
  try {
    const count = read.u32(interfaces, 0);
    for (let i = 0; i < count; i++) {
      // WLAN_INTERFACE_INFO_LIST: two DWORDs, then 532-byte entries (GUID, description, state).
      const item = interfaces + 8 + i * 532;
      if (read.u32(item, 16 + 512) !== 1 /* wlan_interface_state_connected */) continue;
      const guid = new Uint8Array(toArrayBuffer(item, 0, 16));
      const size = new Uint32Array(1);
      const data = new BigUint64Array(1);
      if (W.WlanQueryInterface(wlan, guid, 7, null, new Uint8Array(size.buffer), new Uint8Array(data.buffer), null) !== 0 || !data[0]) continue;
      const attributes = Number(data[0]);
      try {
        // WLAN_CONNECTION_ATTRIBUTES: the association attributes start at 520 (SSID length, SSID
        // bytes), the signal quality (0-100) at 520 + 56.
        const length = Math.min(32, read.u32(attributes, 520));
        const name = new TextDecoder().decode(new Uint8Array(toArrayBuffer(attributes, 524, length)));
        wifi = { signal: read.u32(attributes, 576), name, at: wifi.at };
        return;
      } finally {
        W.WlanFreeMemory(attributes);
      }
    }
  } finally {
    W.WlanFreeMemory(interfaces);
  }
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
  if (iphlpapi.symbols.GetBestInterface(0x08080808, new Uint8Array(ifIndex.buffer)) !== 0) return { kind: "none", internet: false, signal: 0, name: "" };
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
  const n = kernel32.symbols.GetLocaleInfoW(lcid, type, new Uint8Array(localeBuf.buffer), localeBuf.length);
  return n > 1 ? decodeWide(localeBuf.buffer, 0, (n - 1) * 2) : "";
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
  const count = user32.symbols.GetKeyboardLayoutList(16, new Uint8Array(list.buffer));
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
