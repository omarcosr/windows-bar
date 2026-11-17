import { CFunction, dlopen, ptr as ptrOf, read, toArrayBuffer, type Pointer } from "./ffi";
import { decodeWide, encodeWide } from "./wide";

/**
 * Shell items read and acted on in-process, the way Explorer does: their properties from the
 * shell's property system (link target, AppUserModelID, display name), their context-menu verbs
 * through IContextMenu, and the registry values Explorer keeps.
 */

const shell32 = dlopen("shell32.dll", {
  SHGetKnownFolderPath: { args: ["ptr", "u32", "ptr", "ptr"], returns: "i32" },
  SHGetPropertyStoreFromParsingName: { args: ["ptr", "ptr", "u32", "ptr", "ptr"], returns: "i32" },
  SHCreateItemFromParsingName: { args: ["ptr", "ptr", "ptr", "ptr"], returns: "i32" },
});
const ole32 = dlopen("ole32.dll", {
  CoInitializeEx: { args: ["ptr", "u32"], returns: "i32" },
  PropVariantClear: { args: ["ptr"], returns: "i32" },
  CoTaskMemFree: { args: ["ptr"], returns: "void" },
});
const user32 = dlopen("user32.dll", {
  CreatePopupMenu: { args: [], returns: "ptr" },
  DestroyMenu: { args: ["ptr"], returns: "i32" },
});
const advapi32 = dlopen("advapi32.dll", {
  RegGetValueW: { args: ["u64", "ptr", "ptr", "u32", "ptr", "ptr", "ptr"], returns: "i32" },
});

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
const pkey = (fmtid: string, pid: number) => new Uint8Array([...guid(fmtid), pid & 0xff, (pid >> 8) & 0xff, 0, 0]);

export const PKEY = {
  /** System.Link.TargetParsingPath: what a shortcut points at. */
  linkTarget: pkey("B9B4B3FC-2B51-4A42-B5D8-324146AFCF25", 2),
  /** System.AppUserModel.ID: the app identity the taskbar groups and matches by. */
  appUserModelId: pkey("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3", 5),
  /** System.ItemNameDisplay: the name Explorer and Start show. */
  displayName: pkey("B725F130-47EF-101A-A5F1-02608C9EEBAC", 10),
};

const IID_IPropertyStore = guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99");
const IID_IShellItem = guid("43826D1E-E718-42EE-BC55-A1E261C37BFE");
const IID_IContextMenu = guid("000214E4-0000-0000-C000-000000000046");
const BHID_SFUIObject = guid("3981E225-F559-11D3-8E3A-00C04F6837D5");

let comReady = false;
function ensureCom() {
  if (comReady) return;
  ole32.symbols.CoInitializeEx(null, 2 /* COINIT_APARTMENTTHREADED */);
  comReady = true;
}

const calls = new Map<string, (...args: unknown[]) => number>();
function vcall(obj: number, index: number, args: string[], ...values: unknown[]): number {
  const fn = read.ptr(read.ptr(obj, 0) as Pointer, index * 8) as Pointer;
  const key = `${fn}:${args.join(",")}`;
  let call = calls.get(key);
  if (!call) {
    call = new CFunction({ ptr: fn, args: ["ptr", ...args] as never, returns: "i32" }) as never;
    calls.set(key, call!);
  }
  return call!(obj, ...values);
}

function wideAt(address: number): string {
  let length = 0;
  while (length < 2048 && read.u16(address, length * 2) !== 0) length++;
  return length ? decodeWide(toArrayBuffer(address, 0, length * 2), 0, length * 2) : "";
}

/** The path of a known folder ("{6D809377-…}" is Program Files), or "" when Windows has none. */
export function knownFolderPath(id: string): string {
  const out = new BigUint64Array(1);
  if (shell32.symbols.SHGetKnownFolderPath(guid(id), 0, null, new Uint8Array(out.buffer)) !== 0 || !out[0]) return "";
  try {
    return wideAt(Number(out[0]));
  } finally {
    ole32.symbols.CoTaskMemFree(Number(out[0]));
  }
}

/**
 * The program behind an AppUserModelID as the shell resolves it: the default ID of an unnamed app
 * is its path with a known-folder prefix ("{6D809377-…}\\Google\\Chrome\\…\\chrome.exe"); a named
 * ID ("Chrome", "Microsoft.VisualStudioCode") resolves through its Start entry's link target.
 * Lower-cased; "" when the shell knows no program for it.
 */
const programCache = new Map<string, string>();
export function programOfAppId(id: string): string {
  const cached = programCache.get(id);
  if (cached !== undefined) return cached;
  let program = "";
  const folder = /^(\{[0-9a-f-]{36}\})\\(.+)$/i.exec(id);
  if (folder) {
    const base = knownFolderPath(folder[1]!);
    if (base) program = `${base}\\${folder[2]}`;
  } else if (/^[a-z]:\\/i.test(id)) {
    program = id;
  } else {
    program = itemStrings(`shell:AppsFolder\\${id}`, [PKEY.linkTarget])[0] ?? "";
  }
  program = (program ?? "").toLowerCase();
  if (programCache.size > 256) programCache.clear();
  programCache.set(id, program);
  return program;
}

/** String properties of a shell item (a path or a shell: name), "" for the ones it lacks. */
export function itemStrings(path: string, keys: Uint8Array[]): string[] {
  ensureCom();
  const out = new BigUint64Array(1);
  if (shell32.symbols.SHGetPropertyStoreFromParsingName(encodeWide(path), null, 0 /* GPS_DEFAULT */, IID_IPropertyStore, new Uint8Array(out.buffer)) !== 0 || !out[0]) {
    return keys.map(() => "");
  }
  const store = Number(out[0]);
  try {
    return keys.map((key) => {
      const value = new Uint8Array(24);
      // IPropertyStore::GetValue: slot 5.
      if (vcall(store, 5, ["ptr", "ptr"], key, value) !== 0) return "";
      try {
        const view = new DataView(value.buffer);
        if (view.getUint16(0, true) !== 31 /* VT_LPWSTR */) return "";
        const text = Number(view.getBigUint64(8, true));
        return text ? wideAt(text) : "";
      } finally {
        ole32.symbols.PropVariantClear(value);
      }
    });
  } finally {
    vcall(store, 2, []);
  }
}

/**
 * Runs a context-menu verb of a shell item ("taskbarunpin", "open", …) as Explorer's menu does:
 * IShellItem → IContextMenu, filled with QueryContextMenu, then InvokeCommand by the verb's name.
 */
export function invokeVerb(path: string, verb: string): boolean {
  ensureCom();
  const out = new BigUint64Array(1);
  if (shell32.symbols.SHCreateItemFromParsingName(encodeWide(path), null, IID_IShellItem, new Uint8Array(out.buffer)) !== 0 || !out[0]) return false;
  const item = Number(out[0]);
  try {
    out[0] = 0n;
    // IShellItem::BindToHandler: slot 3.
    if (vcall(item, 3, ["ptr", "ptr", "ptr", "ptr"], null, BHID_SFUIObject, IID_IContextMenu, new Uint8Array(out.buffer)) !== 0 || !out[0]) return false;
    const menu = Number(out[0]);
    const hmenu = user32.symbols.CreatePopupMenu();
    try {
      // IContextMenu::QueryContextMenu (slot 3) with CMF_NORMAL, so the handlers add their verbs.
      if (vcall(menu, 3, ["ptr", "u32", "u32", "u32", "u32"], hmenu, 0, 1, 0x7fff, 0) < 0) return false;
      const verbText = new TextEncoder().encode(`${verb}\0`);
      // CMINVOKECOMMANDINFO (56 bytes on x64): cbSize, fMask, hwnd, lpVerb, …, nShow at 40.
      const info = new Uint8Array(56);
      const view = new DataView(info.buffer);
      view.setUint32(0, 56, true);
      view.setBigUint64(16, BigInt(ptrOf(verbText)), true);
      view.setInt32(40, 1 /* SW_SHOWNORMAL */, true);
      // IContextMenu::InvokeCommand: slot 4.
      return vcall(menu, 4, ["ptr"], info) >= 0;
    } finally {
      user32.symbols.DestroyMenu(hmenu);
      vcall(menu, 2, []);
    }
  } finally {
    vcall(item, 2, []);
  }
}

const kernel32 = dlopen("kernel32.dll", {
  FindFirstFileW: { args: ["ptr", "ptr"], returns: "ptr" },
  FindNextFileW: { args: ["ptr", "ptr"], returns: "i32" },
  FindClose: { args: ["ptr"], returns: "i32" },
});

/** File names in `dir` matching `pattern` ("*.lnk"), without folders. */
export function listFiles(dir: string, pattern: string): string[] {
  // WIN32_FIND_DATAW: attributes at 0, cFileName (WCHAR[260]) at 44.
  const data = new Uint8Array(592);
  const view = new DataView(data.buffer);
  const handle = kernel32.symbols.FindFirstFileW(encodeWide(`${dir}\\${pattern}`), data);
  if (!handle || handle === -1 || BigInt.asIntN(64, BigInt(handle)) === -1n) return [];
  const names: string[] = [];
  try {
    do {
      if (view.getUint32(0, true) & 0x10 /* FILE_ATTRIBUTE_DIRECTORY */) continue;
      names.push(decodeWide(data.buffer, 44, 520).replace(/\0.*$/s, ""));
    } while (kernel32.symbols.FindNextFileW(handle, data));
  } finally {
    kernel32.symbols.FindClose(handle);
  }
  return names;
}

const HKCU = 0xffffffff80000001n;

/** A binary or DWORD value under HKEY_CURRENT_USER, or null when it is missing. */
export function readUserValue(sub: string, name: string, type: "binary" | "dword"): Uint8Array | number | null {
  const size = new Uint32Array(1);
  const flags = type === "dword" ? 0x10 : 0x8; // RRF_RT_REG_DWORD / RRF_RT_REG_BINARY
  if (advapi32.symbols.RegGetValueW(HKCU, encodeWide(sub), encodeWide(name), flags, null, null, new Uint8Array(size.buffer)) !== 0) return null;
  const data = new Uint8Array(Math.max(4, size[0]!));
  if (advapi32.symbols.RegGetValueW(HKCU, encodeWide(sub), encodeWide(name), flags, null, data, new Uint8Array(size.buffer)) !== 0) return null;
  return type === "dword" ? new DataView(data.buffer).getUint32(0, true) : data.subarray(0, size[0]!);
}
