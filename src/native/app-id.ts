import { CFunction, dlopen, read, toArrayBuffer, type Pointer } from "./ffi";
import { decodeWide } from "./wide";

/**
 * A window's AppUserModelID as the taskbar reads it: from the window's property store
 * (PKEY_AppUserModel_ID). ApplicationFrameHost sets it on every Store app frame, minimized ones
 * included, where the app's CoreWindow (and so its process) is not there to ask.
 */

const shell32 = dlopen("shell32.dll", {
  SHGetPropertyStoreForWindow: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
});
const ole32 = dlopen("ole32.dll", {
  CoInitializeEx: { args: ["ptr", "u32"], returns: "i32" },
  PropVariantClear: { args: ["ptr"], returns: "i32" },
});

// IID_IPropertyStore {886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99}
const IID_IPropertyStore = Uint8Array.from([
  0xeb, 0x8e, 0x6d, 0x88, 0xf2, 0x8c, 0x46, 0x44, 0x8d, 0x02, 0xcd, 0xba, 0x1d, 0xbd, 0xcf, 0x99,
]);
// PKEY_AppUserModel_ID: {9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3}, 5
const PKEY_AppUserModel_ID = Uint8Array.from([
  0x55, 0x28, 0x4c, 0x9f, 0x79, 0x9f, 0x39, 0x4b, 0xa8, 0xd0, 0xe1, 0xd4, 0x2d, 0xe1, 0xd5, 0xf3, 5, 0, 0, 0,
]);
const VT_LPWSTR = 31;

let comReady = false;
const calls = new Map<string, (...args: unknown[]) => number>();
function vcall(obj: Pointer, index: number, args: string[], ...values: unknown[]): number {
  const fn = read.ptr(read.ptr(obj, 0) as unknown as Pointer, index * 8) as unknown as Pointer;
  const key = `${fn}:${args.join(",")}`;
  let call = calls.get(key);
  if (!call) {
    call = new CFunction({ ptr: fn, args: ["ptr", ...args] as never, returns: "i32" }) as never;
    calls.set(key, call!);
  }
  return call!(obj, ...values);
}

function wideAt(address: Pointer): string {
  let length = 0;
  while (length < 1024 && read.u16(address, length * 2) !== 0) length++;
  return length ? decodeWide(toArrayBuffer(address, 0, length * 2), 0, length * 2) : "";
}

/** The AppUserModelID set on the window, or "" when it has none. */
export function windowAppId(hwnd: Pointer): string {
  if (!comReady) {
    ole32.symbols.CoInitializeEx(null, 2);
    comReady = true;
  }
  const out = new BigUint64Array(1);
  if (shell32.symbols.SHGetPropertyStoreForWindow(hwnd, IID_IPropertyStore, new Uint8Array(out.buffer)) !== 0 || !out[0]) return "";
  const store = Number(out[0]) as unknown as Pointer;
  try {
    const value = new Uint8Array(24);
    // IPropertyStore::GetValue(REFPROPERTYKEY, PROPVARIANT*): slot 5.
    if (vcall(store, 5, ["ptr", "ptr"], PKEY_AppUserModel_ID, value) !== 0) return "";
    try {
      const view = new DataView(value.buffer);
      if (view.getUint16(0, true) !== VT_LPWSTR) return "";
      const text = Number(view.getBigUint64(8, true)) as unknown as Pointer;
      return text ? wideAt(text) : "";
    } finally {
      ole32.symbols.PropVariantClear(value);
    }
  } finally {
    vcall(store, 2, []);
  }
}
