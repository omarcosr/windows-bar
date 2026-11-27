import { threadsafeCallback, threadsafeComObject, type ThreadsafeCallback, type ThreadsafeComObject } from "@tarve/core";
import { CFunction, dlopen, read, toArrayBuffer, type Pointer, FfiUnsupported } from "./ffi";
import { decodeWide, encodeWide } from "./wide";

/** Volume (Core Audio over raw COM vtables), network and keyboard layout, through plain FFI. */

const ole32 = dlopen("ole32.dll", {
  CoInitializeEx: { args: ["ptr", "u32"], returns: "i32" },
  CoCreateInstance: { args: ["ptr", "ptr", "u32", "ptr", "ptr"], returns: "i32" },
  PropVariantClear: { args: ["ptr"], returns: "i32" },
});
const iphlpapi = dlopen("iphlpapi.dll", {
  GetNetworkConnectivityHint: { args: ["ptr"], returns: "u32" },
  GetBestInterface: { args: ["u32", "ptr"], returns: "u32" },
  GetIfEntry2: { args: ["ptr"], returns: "u32" },
  GetIfTable2: { args: ["ptr"], returns: "u32" },
  FreeMibTable: { args: ["ptr"], returns: "void" },
  NotifyNetworkConnectivityHintChange: { args: ["ptr", "ptr", "u8", "ptr"], returns: "u32" },
  NotifyRouteChange2: { args: ["u16", "ptr", "ptr", "u8", "ptr"], returns: "u32" },
  CancelMibChangeNotify2: { args: ["ptr"], returns: "u32" },
});
const user32 = dlopen("user32.dll", {
  GetKeyboardLayout: { args: ["u32"], returns: "u64" },
  GetKeyboardLayoutList: { args: ["i32", "ptr"], returns: "i32" },
  GetWindowThreadProcessId: { args: ["ptr", "ptr"], returns: "u32" },
  PostMessageW: { args: ["ptr", "u32", "u64", "i64"], returns: "i32" },
  ActivateKeyboardLayout: { args: ["u64", "u32"], returns: "u64" },
  GetClassNameW: { args: ["ptr", "ptr", "i32"], returns: "i32" },
  FindWindowExW: { args: ["ptr", "ptr", "ptr", "ptr"], returns: "ptr" },
});
const kernel32 = dlopen("kernel32.dll", {
  GetLocaleInfoW: { args: ["u32", "u32", "ptr", "i32"], returns: "i32" },
});
const wlanapi = dlopen("wlanapi.dll", {
  WlanOpenHandle: { args: ["u32", "ptr", "ptr", "ptr"], returns: "u32" },
  WlanEnumInterfaces: { args: ["ptr", "ptr", "ptr"], returns: "u32" },
  WlanQueryInterface: { args: ["ptr", "ptr", "u32", "ptr", "ptr", "ptr", "ptr"], returns: "u32" },
  WlanRegisterNotification: { args: ["ptr", "u32", "i32", "ptr", "ptr", "ptr", "ptr"], returns: "u32" },
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

// ---------- Audio endpoints ----------

/** eRender (the taskbar's speaker) or eCapture (quick settings' microphone). */
export type AudioFlow = 0 | 1;
/** The default each flow follows: the speaker the eMultimedia one, the microphone the eConsole one. */
const ROLE = [1, 0] as const;

export interface EndpointState {
  /** Master volume, 0..100. */
  level: number;
  muted: boolean;
  /** The device's name as the volume tip shows it ("Alto-falantes (Realtek(R) Audio)"). */
  device: string;
}

const CLSID_MMDeviceEnumerator = guid("BCDE0395-E52F-467C-8E3D-C4579291692E");
const IID_IMMDeviceEnumerator = guid("A95664D2-9614-4F35-A746-DE8DB63617E6");
const IID_IAudioEndpointVolume = guid("5CDF2C82-841E-4546-9722-0CF74078229A");
const IID_IAudioEndpointVolumeCallback = "{657804FA-D6AD-4496-8A60-352752AF4F89}";
const IID_IMMNotificationClient = "{7991EEC9-7E89-4D85-8390-6C703CEC60C0}";
// PKEY_Device_FriendlyName {A45C254E-DF1C-4EFD-8020-67D146A850E0}, 14.
const PKEY_Device_FriendlyName = new Uint8Array([...guid("A45C254E-DF1C-4EFD-8020-67D146A850E0"), 14, 0, 0, 0]);
let comReady = false;
let enumerator: Pointer | null = null;

function deviceEnumerator(): Pointer | null {
  if (!comReady) {
    ole32.symbols.CoInitializeEx(null, 2 /* COINIT_APARTMENTTHREADED */);
    comReady = true;
  }
  if (!enumerator) {
    const out = new BigUint64Array(1);
    if (ole32.symbols.CoCreateInstance(CLSID_MMDeviceEnumerator, null, 0x17, IID_IMMDeviceEnumerator, new Uint8Array(out.buffer)) !== 0 || !out[0]) return null;
    enumerator = Number(out[0]) as Pointer;
  }
  return enumerator;
}

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
      const text = Number(view.getBigUint64(8, true));
      let length = 0;
      while (length < 256 && read.u16(text, length * 2) !== 0) length++;
      return decodeWide(toArrayBuffer(text, 0, length * 2), 0, length * 2);
    } finally {
      ole32.symbols.PropVariantClear(value);
    }
  } finally {
    release(store);
  }
}

/** A flow's default device and its IAudioEndpointVolume, with the sink its changes arrive through while watched. */
interface Binding {
  device: Pointer;
  volume: Pointer;
  name: string;
  notify?: ThreadsafeCallback;
  sink?: ThreadsafeComObject;
}

function bind(flow: AudioFlow): Binding | null {
  const devices = deviceEnumerator();
  if (!devices) return null;
  const out = new BigUint64Array(1);
  if (com(devices, 4, ["i32", "i32", "ptr"], flow, ROLE[flow], out) !== 0 || !out[0]) return null; // GetDefaultAudioEndpoint
  const device = Number(out[0]) as Pointer;
  out[0] = 0n;
  if (com(device, 3, ["ptr", "u32", "ptr", "ptr"], IID_IAudioEndpointVolume, 0x17, null, out) !== 0 || !out[0]) {
    release(device);
    return null;
  }
  return { device, volume: Number(out[0]) as Pointer, name: "" };
}

function unbind(binding: Binding) {
  if (binding.sink) {
    com(binding.volume, 4, ["ptr"], Number(binding.sink.pointer)); // UnregisterControlChangeNotify
    binding.notify!.close();
    binding.sink.release();
  }
  release(binding.volume);
  release(binding.device);
}

function readState(binding: Binding): EndpointState {
  const level = new Float32Array(1);
  const muted = new Int32Array(1);
  com(binding.volume, 9, ["ptr"], level); // GetMasterVolumeLevelScalar
  com(binding.volume, 15, ["ptr"], muted); // GetMute
  return { level: Math.round(level[0]! * 100), muted: !!muted[0], device: binding.name || friendlyName(binding.device) };
}

interface Watch {
  binding: Binding | null;
  state: EndpointState | null;
  listeners: Set<{ fn: (state: EndpointState | null) => void }>;
  timer?: ReturnType<typeof setTimeout>;
}
const watches: [Watch | null, Watch | null] = [null, null];

/** Runs `fn` on the flow's default endpoint: the watched one, else one resolved for this call; null without a device. */
function withEndpoint<T>(flow: AudioFlow, fn: (binding: Binding) => T): T | null {
  try {
    const watched = watches[flow]?.binding;
    if (watched) return fn(watched);
    const binding = bind(flow);
    if (!binding) return null;
    try {
      return fn(binding);
    } finally {
      unbind(binding);
    }
  } catch (error) {
    if (error instanceof FfiUnsupported) return null;
    throw error;
  }
}

function emit(watch: Watch, state: EndpointState | null) {
  watch.state = state;
  for (const listener of watch.listeners) listener.fn(state);
}

/**
 * Binds the flow's current default device and subscribes to its volume and mute changes
 * (IAudioEndpointVolume::RegisterControlChangeNotify), as the speaker icon follows them: OnNotify
 * carries AUDIO_VOLUME_NOTIFICATION_DATA (bMuted at 16, fMasterVolume at 20), copied during the call.
 * A new sink per binding: closing the old one drops the late notifications of the previous device.
 */
function rebind(flow: AudioFlow) {
  const watch = watches[flow];
  if (!watch) return;
  if (watch.binding) unbind(watch.binding);
  watch.binding = null;
  let state: EndpointState | null = null;
  try {
    const binding = bind(flow);
    if (binding) {
      binding.name = friendlyName(binding.device);
      binding.notify = threadsafeCallback(
        (_self: bigint, data: Uint8Array | null) => {
          if (!data || watch.binding !== binding) return;
          const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
          emit(watch, { level: Math.round(view.getFloat32(20, true) * 100), muted: view.getInt32(16, true) !== 0, device: binding.name });
        },
        { args: ["ptr", "ptr"], copy: { arg: 1, bytes: 32 } },
      );
      binding.sink = threadsafeComObject({ iids: [IID_IAudioEndpointVolumeCallback], methods: [binding.notify] });
      com(binding.volume, 3, ["ptr"], Number(binding.sink.pointer)); // RegisterControlChangeNotify
      watch.binding = binding;
      state = readState(binding);
    }
  } catch (error) {
    if (!(error instanceof FfiUnsupported)) console.error("[audio]", error);
  }
  emit(watch, state);
}

/** Device events come in bursts (one per role, state and default): handled once per burst. */
function later(flow: AudioFlow, work: () => void) {
  const watch = watches[flow];
  if (!watch) return;
  clearTimeout(watch.timer);
  watch.timer = setTimeout(work, 50);
}

function renamed(flow: AudioFlow) {
  const watch = watches[flow];
  if (!watch?.binding) return;
  const name = friendlyName(watch.binding.device);
  if (name === watch.binding.name) return;
  watch.binding.name = name;
  if (watch.state) emit(watch, { ...watch.state, device: name });
}

/**
 * IMMNotificationClient, registered once while any flow is watched: a new default device
 * (OnDefaultDeviceChanged) or a device enabled, disabled or unplugged (OnDeviceStateChanged) binds
 * the default again; a property change (OnPropertyValueChanged) re-reads the bound device's name.
 */
let client: { sink: ThreadsafeComObject; callbacks: ThreadsafeCallback[] } | null = null;

function startClient() {
  const devices = deviceEnumerator();
  if (!devices) return;
  const each = (work: (flow: AudioFlow) => void) => () => {
    for (const flow of [0, 1] as const) if (watches[flow]) later(flow, () => work(flow));
  };
  const stateChanged = threadsafeCallback(each(rebind), { args: [] });
  const ignored = threadsafeCallback(() => {}, { args: [] });
  const defaultChanged = threadsafeCallback(
    (_self: bigint, flow: number, role: number) => {
      if ((flow === 0 || flow === 1) && role === ROLE[flow] && watches[flow]) later(flow, () => rebind(flow));
    },
    { args: ["ptr", "i32", "i32"] },
  );
  const propertyChanged = threadsafeCallback(each(renamed), { args: [] });
  // OnDeviceStateChanged, OnDeviceAdded, OnDeviceRemoved, OnDefaultDeviceChanged, OnPropertyValueChanged
  const sink = threadsafeComObject({ iids: [IID_IMMNotificationClient], methods: [stateChanged, ignored, ignored, defaultChanged, propertyChanged] });
  const callbacks = [stateChanged, ignored, defaultChanged, propertyChanged];
  if (com(devices, 6, ["ptr"], Number(sink.pointer)) !== 0) {
    for (const callback of callbacks) callback.close();
    sink.release();
    return;
  }
  client = { sink, callbacks };
}

function stopClient() {
  if (!client) return;
  if (enumerator) com(enumerator, 7, ["ptr"], Number(client.sink.pointer)); // UnregisterEndpointNotificationCallback
  for (const callback of client.callbacks) callback.close();
  client.sink.release();
  client = null;
}

/**
 * Follows the flow's default endpoint: `listener` gets its state now and after every change of
 * volume, mute, name or default device (null without one), from Core Audio's own notifications.
 * Returns the release function; the last release unregisters everything.
 */
export function watchEndpoint(flow: AudioFlow, listener: (state: EndpointState | null) => void): () => void {
  const entry = { fn: listener };
  let watch = watches[flow];
  if (!watch) {
    watch = watches[flow] = { binding: null, state: null, listeners: new Set() };
    try {
      if (!client) startClient();
    } catch (error) {
      if (!(error instanceof FfiUnsupported)) console.error("[audio]", error);
    }
    rebind(flow);
  }
  watch.listeners.add(entry);
  listener(watch.state);
  return () => {
    if (!watch.listeners.delete(entry) || watch.listeners.size) return;
    clearTimeout(watch.timer);
    watches[flow] = null;
    if (watch.binding) unbind(watch.binding);
    watch.binding = null;
    if (!watches[0] && !watches[1]) stopClient();
  };
}

/** Master volume (0..100), mute and name of the flow's default device, or null without one. */
export function readEndpoint(flow: AudioFlow): EndpointState | null {
  return withEndpoint(flow, readState);
}

/** The default playback device's state, as the taskbar's speaker shows it. */
export const readVolume = () => readEndpoint(0);

/** Sets the master volume (0..100), as the quick settings slider does; unmutes like it when raised. */
export function setVolume(level: number): boolean {
  const scalar = Math.max(0, Math.min(100, level)) / 100;
  return (
    withEndpoint(0, ({ volume }) => {
      const ok = com(volume, 7, ["f32", "ptr"], scalar, null) >= 0; // SetMasterVolumeLevelScalar
      if (scalar > 0) com(volume, 14, ["i32", "ptr"], 0, null); // SetMute(FALSE)
      return ok;
    }) ?? false
  );
}

/** Mutes or unmutes the flow's default device, as the speaker and microphone buttons in quick settings. */
export function setEndpointMuted(flow: AudioFlow, muted: boolean): boolean {
  return withEndpoint(flow, ({ volume }) => com(volume, 14, ["i32", "ptr"], muted ? 1 : 0, null) >= 0) ?? false; // SetMute (S_FALSE: already so)
}

export const setMuted = (muted: boolean) => setEndpointMuted(0, muted);

// ---------- Network ----------

export type NetworkKind = "wifi" | "ethernet" | "other" | "none";

const hint = new Uint8Array(16);
const ifIndex = new Uint32Array(1);
const ifRow = new Uint8Array(1352);

let wlan: number | null | undefined;

function wlanHandle(): number | null {
  if (wlan === undefined) {
    const version = new Uint32Array(1);
    const handle = new BigUint64Array(1);
    wlan = wlanapi.symbols.WlanOpenHandle(2, null, new Uint8Array(version.buffer), new Uint8Array(handle.buffer)) === 0 ? Number(handle[0]) : null;
  }
  return wlan;
}

/**
 * Signal quality and SSID of the connected Wi-Fi interface, from the WLAN service (the source the
 * taskbar's network icon uses): WlanQueryInterface(wlan_intf_opcode_current_connection).
 */
function readWifi(): { signal: number; name: string } {
  const W = wlanapi.symbols;
  const handle = wlanHandle();
  if (!handle) return { signal: 100, name: "" };
  const list = new BigUint64Array(1);
  if (W.WlanEnumInterfaces(handle, null, new Uint8Array(list.buffer)) !== 0 || !list[0]) return { signal: 100, name: "" };
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
      if (W.WlanQueryInterface(handle, guid, 7, null, new Uint8Array(size.buffer), new Uint8Array(data.buffer), null) !== 0 || !data[0]) continue;
      const attributes = Number(data[0]);
      try {
        // WLAN_CONNECTION_ATTRIBUTES: the association attributes start at 520 (SSID length, SSID
        // bytes), the signal quality (0-100) at 520 + 56.
        const length = Math.min(32, read.u32(attributes, 520));
        const name = new TextDecoder().decode(new Uint8Array(toArrayBuffer(attributes, 524, length)));
        return { signal: read.u32(attributes, 576), name };
      } finally {
        W.WlanFreeMemory(attributes);
      }
    }
  } finally {
    W.WlanFreeMemory(interfaces);
  }
  return { signal: 100, name: "" };
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
  let hardware = false;
  if (iphlpapi.symbols.GetIfEntry2(ifRow) === 0) {
    type = v.getUint32(1128, true);
    hardware = (ifRow[1152]! & 1) !== 0;
  }
  // A VPN or virtual adapter carrying the route (Tailscale, Hyper-V's vEthernet for WSL) is not
  // what the taskbar shows: its icon is the physical connection under it (Wi-Fi or cable).
  if (!hardware) type = physicalType() || type;
  if (type === 71) {
    if (network && !network.wlan) watchWlan(network);
    return { kind: "wifi", internet, ...readWifi() };
  }
  return { kind: type === 6 ? "ethernet" : "other", internet, signal: 100, name: "" };
}

/**
 * Calls `onChange` (once per burst) when what readNetwork returns may have changed, from the
 * system's notifications instead of a poll: the connectivity level (NotifyNetworkConnectivityHintChange),
 * the routes that pick the interface to the internet (NotifyRouteChange2) and, while on Wi-Fi, its
 * connection and signal quality (WlanRegisterNotification, ACM and MSM sources). Each calls back on a
 * system thread, taken by a threadsafe callback. Returns the release function; the last one cancels them all.
 */
const networkListeners = new Set<{ fn: () => void }>();
interface NetworkWatch {
  callbacks: ThreadsafeCallback[];
  handles: BigUint64Array;
  wlan: boolean;
  /** Creates one more callback that reports a change (once per burst); returns its address. */
  callback: () => number;
  timer?: ReturnType<typeof setTimeout>;
}
let network: NetworkWatch | null = null;

function startNetwork() {
  const state: NetworkWatch = {
    callbacks: [],
    handles: new BigUint64Array(2),
    wlan: false,
    callback: () => {
      const made = threadsafeCallback(changed, { args: [] });
      state.callbacks.push(made);
      return Number(made.pointer);
    },
  };
  const changed = () => {
    clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      for (const listener of networkListeners) listener.fn();
    }, 100);
  };
  const I = iphlpapi.symbols;
  I.NotifyNetworkConnectivityHintChange(state.callback(), null, 0, new Uint8Array(state.handles.buffer, 0, 8));
  I.NotifyRouteChange2(0 /* AF_UNSPEC */, state.callback(), null, 0, new Uint8Array(state.handles.buffer, 8, 8));
  network = state;
}

/**
 * The first WlanRegisterNotification of a process waits ~400 ms on the WLAN service: it is made only
 * once the route to the internet goes through Wi-Fi (readNetwork), never on a wired PC.
 */
function watchWlan(state: NetworkWatch) {
  const handle = wlanHandle();
  state.wlan = true;
  if (!handle) return;
  if (wlanapi.symbols.WlanRegisterNotification(handle, 0x8 | 0x10 /* ACM | MSM */, 1, state.callback(), null, null, null) !== 0) state.callbacks.pop()?.close();
}

function stopNetwork() {
  if (!network) return;
  clearTimeout(network.timer);
  for (const handle of network.handles) if (handle) iphlpapi.symbols.CancelMibChangeNotify2(Number(handle));
  if (network.wlan && wlan) wlanapi.symbols.WlanRegisterNotification(wlan, 0 /* WLAN_NOTIFICATION_SOURCE_NONE */, 0, null, null, null, null);
  for (const callback of network.callbacks) callback.close();
  network = null;
}

export function watchNetwork(onChange: () => void): () => void {
  const entry = { fn: onChange };
  if (!network) {
    try {
      startNetwork();
    } catch (error) {
      if (!(error instanceof FfiUnsupported)) console.error("[network]", error);
    }
  }
  networkListeners.add(entry);
  return () => {
    if (networkListeners.delete(entry) && !networkListeners.size) stopNetwork();
  };
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
const classBuf = new Uint16Array(64);
const CORE_WINDOW = encodeWide("Windows.UI.Core.CoreWindow");

/**
 * The window whose thread takes the keyboard for `hwnd`: a UWP app's frame (ApplicationFrameWindow)
 * belongs to ApplicationFrameHost, while the app types into its CoreWindow, a child from its own process.
 */
function inputWindow(hwnd: Pointer | null): Pointer | null {
  if (!hwnd) return null;
  const n = user32.symbols.GetClassNameW(hwnd, new Uint8Array(classBuf.buffer), 64);
  if (String.fromCharCode(...classBuf.subarray(0, Math.max(0, n))) !== "ApplicationFrameWindow") return hwnd;
  return user32.symbols.FindWindowExW(hwnd, null, CORE_WINDOW, null) || hwnd;
}

/**
 * Switches `hwnd`'s input language to the next one in the list, as Win+Space and the language button
 * do: WM_INPUTLANGCHANGEREQUEST (INPUTLANGCHANGE_FORWARD) posted to the window (a UWP app's
 * CoreWindow), whose DefWindowProc activates the layout on its thread. A window of this process gets
 * ActivateKeyboardLayout directly. Returns the HKL asked for, or null (no window, one layout only).
 */
export function nextKeyboardLayout(hwnd: Pointer | null): bigint | null {
  hwnd = inputWindow(hwnd);
  if (!hwnd) return null;
  const pid = new Uint32Array(1);
  const thread = user32.symbols.GetWindowThreadProcessId(hwnd, new Uint8Array(pid.buffer));
  if (!thread) return null;
  const current = BigInt(user32.symbols.GetKeyboardLayout(thread));
  const list = new BigUint64Array(16);
  const count = user32.symbols.GetKeyboardLayoutList(16, new Uint8Array(list.buffer));
  if (count < 2) return null;
  const layouts = [...list.slice(0, count)];
  const next = layouts[(layouts.indexOf(current) + 1) % count]!;
  if (pid[0] === process.pid) user32.symbols.ActivateKeyboardLayout(next, 0);
  else if (!user32.symbols.PostMessageW(hwnd, 0x50 /* WM_INPUTLANGCHANGEREQUEST */, 0x2n /* INPUTLANGCHANGE_FORWARD */, BigInt.asIntN(64, next))) return null;
  return next;
}

export function keyboardLayout(hwnd: Pointer | null): { language: string; layout: string; name: string; hkl: string } {
  hwnd = inputWindow(hwnd);
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
/**
 * The type of the physical adapter that is up and connected (GetIfTable2): Ethernet (6) before
 * Wi-Fi (71), as Windows routes over the cable when both are; 0 when there is none. MIB_IF_ROW2
 * (1352 bytes): Type at 1128, InterfaceAndOperStatusFlags at 1152 (bit 0 HardwareInterface),
 * OperStatus at 1156, MediaConnectState at 1164.
 */
export function physicalType(): number {
  const out = new BigUint64Array(1);
  if (iphlpapi.symbols.GetIfTable2(new Uint8Array(out.buffer)) !== 0 || !out[0]) return 0;
  const table = Number(out[0]) as Pointer;
  try {
    const count = read.u32(table, 0);
    if (!count) return 0;
    const v = new DataView(toArrayBuffer(table, 8, count * 1352));
    let found = 0;
    for (let i = 0; i < count; i++) {
      const at = i * 1352;
      if (!(v.getUint8(at + 1152) & 1) || v.getUint32(at + 1156, true) !== 1 || v.getUint32(at + 1164, true) !== 1) continue;
      const type = v.getUint32(at + 1128, true);
      if (type === 6) return 6;
      if (type === 71) found = 71;
    }
    return found;
  } finally {
    iphlpapi.symbols.FreeMibTable(table);
  }
}
