import { readUserValue } from "./shell-item";
import { iconPixels } from "./tray-host";
import { decodeWide, encodeWide } from "./wide";
import { CFunction, dlopen, ptr as ptrOf, read, toArrayBuffer, type Pointer } from "./ffi";

/**
 * An app's jump list, read from the same shell objects Explorer's taskbar builds it from:
 *  - the AppUserModelID through IApplicationResolver (what Explorer asks for a window or a pinned
 *    shortcut), so default IDs ("{6D809377-…}\\App\\app.exe") match the ones Windows stores under;
 *  - pinned / recent / frequent items from IAutomaticDestinationList (the AutomaticDestinations
 *    store; IApplicationDocumentLists is its read-only, documented face);
 *  - the app's own categories and tasks from IInternalCustomDestinationList (the CustomDestinations
 *    store that ICustomDestinationList writes).
 * The automatic and internal custom lists are the shell's undocumented interfaces (the IIDs Windows
 * 10/11 answer to); items are opened through their shell context menu's default verb and pinned or
 * unpinned with IAutomaticDestinationList::PinItem, as the jump list's pin button does.
 */

const ole32 = dlopen("ole32.dll", {
  CoInitializeEx: { args: ["ptr", "u32"], returns: "i32" },
  CoCreateInstance: { args: ["ptr", "ptr", "u32", "ptr", "ptr"], returns: "i32" },
  CoTaskMemFree: { args: ["ptr"], returns: "void" },
  PropVariantClear: { args: ["ptr"], returns: "i32" },
});
const shell32 = dlopen("shell32.dll", {
  SHCreateItemFromParsingName: { args: ["ptr", "ptr", "ptr", "ptr"], returns: "i32" },
});
const shlwapi = dlopen("shlwapi.dll", {
  SHLoadIndirectString: { args: ["ptr", "ptr", "u32", "ptr"], returns: "i32" },
});
const user32 = dlopen("user32.dll", {
  PrivateExtractIconsW: { args: ["ptr", "i32", "i32", "i32", "ptr", "ptr", "u32", "u32"], returns: "u32" },
  DestroyIcon: { args: ["ptr"], returns: "i32" },
  CreatePopupMenu: { args: [], returns: "ptr" },
  DestroyMenu: { args: ["ptr"], returns: "i32" },
  GetMenuDefaultItem: { args: ["ptr", "u32", "u32"], returns: "u32" },
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

const CLSID_ApplicationResolver = guid("660B90C8-73A9-4B58-8CAE-355B7F55341B");
const IID_IApplicationResolver8 = guid("DE25675A-72DE-44B4-9373-05170450C140");
const CLSID_AutomaticDestinationList = guid("F0AE1542-F497-484B-A175-A20DB09144BA");
const IID_IAutomaticDestinationList = guid("E9C5EF8D-FD41-4F72-BA87-EB03BAD5817C");
const CLSID_DestinationList = guid("77F10CF0-3DB5-4966-B520-B7C54FD35ED6");
const IID_IInternalCustomDestinationList = guid("507101CD-F6AD-46C8-8E20-EEB9E6BAC47F");
const IID_IObjectArray = guid("92CA9DCD-5622-4BBA-A805-5E9F541BD8C9");
const IID_IUnknown = guid("00000000-0000-0000-C000-000000000046");
const IID_IShellItem = guid("43826D1E-E718-42EE-BC55-A1E261C37BFE");
const IID_IShellLinkW = guid("000214F9-0000-0000-C000-000000000046");
const IID_IPropertyStore = guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99");
const IID_IContextMenu = guid("000214E4-0000-0000-C000-000000000046");
const BHID_SFUIObject = guid("3981E225-F559-11D3-8E3A-00C04F6837D5");
const PKEY_Title = pkey("F29F85E0-4FF9-1068-AB91-08002B27B3D9", 2);
const PKEY_AppUserModel_IsDestListSeparator = pkey("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3", 6);

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
const release = (obj: number) => void vcall(obj, 2, []);

function wideAt(address: number): string {
  let length = 0;
  while (length < 4096 && read.u16(address, length * 2) !== 0) length++;
  return length ? decodeWide(toArrayBuffer(address, 0, length * 2), 0, length * 2) : "";
}
function takeWide(address: number): string {
  try {
    return wideAt(address);
  } finally {
    ole32.symbols.CoTaskMemFree(address);
  }
}
const wideBuffer = (buffer: Uint8Array) => decodeWide(buffer.buffer as ArrayBuffer, 0, buffer.length).replace(/\0.*$/s, "");

/** "@shell32.dll,-1234" / "@{Package?ms-resource://…}" resolved as the shell shows it. */
function indirect(text: string): string {
  if (!text.startsWith("@")) return text;
  const out = new Uint8Array(1024);
  return shlwapi.symbols.SHLoadIndirectString(encodeWide(text), out, 512, null) === 0 ? wideBuffer(out) : text;
}

function create(clsid: Uint8Array, iid: Uint8Array): number {
  ensureCom();
  const out = new BigUint64Array(1);
  if (ole32.symbols.CoCreateInstance(clsid, null, 1 /* CLSCTX_INPROC_SERVER */, iid, new Uint8Array(out.buffer)) !== 0) return 0;
  return Number(out[0]);
}
function query(obj: number, iid: Uint8Array): number {
  const out = new BigUint64Array(1);
  return vcall(obj, 0, ["ptr", "ptr"], iid, new Uint8Array(out.buffer)) === 0 ? Number(out[0]) : 0;
}
function shellItem(path: string): number {
  ensureCom();
  const out = new BigUint64Array(1);
  return shell32.symbols.SHCreateItemFromParsingName(encodeWide(path), null, IID_IShellItem, new Uint8Array(out.buffer)) === 0 ? Number(out[0]) : 0;
}

let resolver = 0;
function appResolver(): number {
  return (resolver ||= create(CLSID_ApplicationResolver, IID_IApplicationResolver8));
}

/** The AppUserModelID Explorer files a window's jump list under (explicit or the default one). */
export function appIdForWindow(hwnd: number): string {
  const r = appResolver();
  if (!r) return "";
  const out = new BigUint64Array(1);
  const flags = new Int32Array(3);
  // IApplicationResolver::GetAppIDForWindow: slot 5.
  const hr = vcall(r, 5, ["ptr", "ptr", "ptr", "ptr", "ptr"], hwnd, new Uint8Array(out.buffer), new Uint8Array(flags.buffer, 0, 4), new Uint8Array(flags.buffer, 4, 4), new Uint8Array(flags.buffer, 8, 4));
  return hr === 0 && out[0] ? takeWide(Number(out[0])) : "";
}

/** The AppUserModelID of a shortcut (a pinned .lnk), as the taskbar resolves it. */
export function appIdForShortcut(path: string): string {
  const r = appResolver();
  const item = r ? shellItem(path) : 0;
  if (!item) return "";
  try {
    const out = new BigUint64Array(1);
    // IApplicationResolver::GetAppIDForShortcut: slot 3.
    return vcall(r, 3, ["ptr", "ptr"], item, new Uint8Array(out.buffer)) === 0 && out[0] ? takeWide(Number(out[0])) : "";
  } finally {
    release(item);
  }
}

/** Known folders the shell writes as their GUID at the head of a program's default AppUserModelID. */
const DEFAULT_ID_FOLDERS: [string, string][] = [
  ["{6D809377-6AF0-444B-8957-A3773F02200E}", process.env.ProgramW6432 ?? process.env.ProgramFiles ?? ""],
  ["{7C5A40EF-A0FB-4BFC-874A-C0F2E0B9FA8E}", process.env["ProgramFiles(x86)"] ?? ""],
  ["{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}", process.env.SystemRoot ? `${process.env.SystemRoot}\\System32` : ""],
  ["{D65231B0-B2F1-4857-A4CE-A8E7C6EA7D27}", process.env.SystemRoot ? `${process.env.SystemRoot}\\SysWOW64` : ""],
  ["{F38BF404-1D43-42F2-9305-67DE0B28FC23}", process.env.SystemRoot ?? ""],
];

/**
 * The default AppUserModelID of a program that is not running and has no shortcut to ask the
 * resolver about: its path, with the known-folder prefix written as the folder's GUID.
 */
export function defaultAppIdForProgram(path: string): string {
  const lower = path.toLowerCase();
  for (const [id, dir] of DEFAULT_ID_FOLDERS) {
    if (dir && lower.startsWith(`${dir.toLowerCase()}\\`)) return `${id}${path.slice(dir.length)}`;
  }
  return path;
}

export interface JumpItem {
  label: string;
  /** What the shell draws its icon from: a file path, the link's icon file or its target. */
  iconPath: string;
  /** The link's own icon resource (IShellLink::GetIconLocation), drawn instead when set. */
  iconIndex: number | null;
  /** In the list's "Fixado" category. */
  pinned: boolean;
  /** Only items the automatic list can hold are pinnable (files, folders, links). */
  pinnable: boolean;
  open(): void;
  togglePin(): void;
}

export interface JumpCategory {
  kind: "pinned" | "recent" | "frequent" | "custom" | "tasks";
  /** The app's own name for a custom category; "" for the shell's own categories. */
  title: string;
  items: JumpItem[];
}

/** COM objects the last list handed out, alive until the next list replaces them. */
let held: number[] = [];

interface Destination {
  obj: number;
  label: string;
  iconPath: string;
  iconIndex: number | null;
  /** Identity for de-duplication against the pinned list: parsing name or link target + args. */
  id: string;
  separator: boolean;
}

function describe(obj: number): Destination | null {
  const item = query(obj, IID_IShellItem);
  if (item) {
    try {
      const out = new BigUint64Array(1);
      // IShellItem::GetDisplayName: slot 5. SIGDN_NORMALDISPLAY, SIGDN_DESKTOPABSOLUTEPARSING.
      const label = vcall(item, 5, ["u32", "ptr"], 0, new Uint8Array(out.buffer)) === 0 && out[0] ? takeWide(Number(out[0])) : "";
      out[0] = 0n;
      const parsing = vcall(item, 5, ["u32", "ptr"], 0x80028000, new Uint8Array(out.buffer)) === 0 && out[0] ? takeWide(Number(out[0])) : "";
      return { obj, label, iconPath: parsing, iconIndex: null, id: parsing.toLowerCase(), separator: false };
    } finally {
      release(item);
    }
  }
  const link = query(obj, IID_IShellLinkW);
  if (!link) return null;
  try {
    let title = "";
    let separator = false;
    const store = query(link, IID_IPropertyStore);
    if (store) {
      const value = new Uint8Array(24);
      const view = new DataView(value.buffer);
      // IPropertyStore::GetValue: slot 5.
      if (vcall(store, 5, ["ptr", "ptr"], PKEY_Title, value) === 0 && view.getUint16(0, true) === 31 /* VT_LPWSTR */) {
        title = wideAt(Number(view.getBigUint64(8, true)));
      }
      ole32.symbols.PropVariantClear(value);
      if (vcall(store, 5, ["ptr", "ptr"], PKEY_AppUserModel_IsDestListSeparator, value) === 0 && view.getUint16(0, true) === 11 /* VT_BOOL */) {
        separator = view.getInt16(8, true) !== 0;
      }
      ole32.symbols.PropVariantClear(value);
      release(store);
    }
    // IShellLinkW: GetPath slot 3, GetArguments slot 10, GetIconLocation slot 16.
    const target = new Uint8Array(1040);
    vcall(link, 3, ["ptr", "i32", "ptr", "u32"], target, 520, null, 0);
    const args = new Uint8Array(4096);
    vcall(link, 10, ["ptr", "i32"], args, 2048);
    const icon = new Uint8Array(1040);
    const index = new Int32Array(1);
    vcall(link, 16, ["ptr", "i32", "ptr"], icon, 520, new Uint8Array(index.buffer));
    const path = wideBuffer(target);
    const iconFile = wideBuffer(icon);
    return {
      obj,
      label: indirect(title) || path.replace(/^.*\\/, ""),
      iconPath: iconFile || path,
      iconIndex: iconFile ? index[0]! : null,
      id: `${path}|${wideBuffer(args)}`.toLowerCase(),
      separator,
    };
  } finally {
    release(link);
  }
}

function destinations(array: number, max = Infinity): Destination[] {
  const list: Destination[] = [];
  try {
    const count = new Uint32Array(1);
    // IObjectArray: GetCount slot 3, GetAt slot 4.
    vcall(array, 3, ["ptr"], new Uint8Array(count.buffer));
    for (let i = 0; i < count[0]! && list.length < max; i++) {
      const out = new BigUint64Array(1);
      if (vcall(array, 4, ["u32", "ptr", "ptr"], i, IID_IUnknown, new Uint8Array(out.buffer)) !== 0 || !out[0]) continue;
      const obj = Number(out[0]);
      const d = describe(obj);
      if (d && !d.separator && d.label) {
        held.push(obj);
        list.push(d);
      } else {
        release(obj);
      }
    }
  } finally {
    release(array);
  }
  return list;
}

/** Opens a destination as the jump list does: its shell context menu's default verb. */
function invokeDefault(obj: number) {
  let menu = 0;
  const item = query(obj, IID_IShellItem);
  if (item) {
    const out = new BigUint64Array(1);
    // IShellItem::BindToHandler: slot 3.
    if (vcall(item, 3, ["ptr", "ptr", "ptr", "ptr"], null, BHID_SFUIObject, IID_IContextMenu, new Uint8Array(out.buffer)) === 0) menu = Number(out[0]);
    release(item);
  } else {
    menu = query(obj, IID_IContextMenu);
  }
  if (!menu) return;
  const hmenu = user32.symbols.CreatePopupMenu();
  try {
    // IContextMenu::QueryContextMenu (slot 3), CMF_DEFAULTONLY: just the verb a double-click runs.
    if (vcall(menu, 3, ["ptr", "u32", "u32", "u32", "u32"], hmenu, 0, 1, 0x7fff, 1) < 0) return;
    const id = user32.symbols.GetMenuDefaultItem(hmenu, 0, 0);
    const openVerb = new TextEncoder().encode("open\0");
    // CMINVOKECOMMANDINFO (56 bytes on x64): cbSize, fMask, hwnd, lpVerb at 16, nShow at 40.
    const info = new Uint8Array(56);
    const view = new DataView(info.buffer);
    view.setUint32(0, 56, true);
    // lpVerb: the default item's offset (MAKEINTRESOURCE), else the "open" verb by name.
    view.setBigUint64(16, id !== 0xffffffff && id >= 1 ? BigInt(id - 1) : BigInt(ptrOf(openVerb)), true);
    view.setInt32(40, 1 /* SW_SHOWNORMAL */, true);
    // IContextMenu::InvokeCommand: slot 4.
    vcall(menu, 4, ["ptr"], info);
  } finally {
    user32.symbols.DestroyMenu(hmenu);
    release(menu);
  }
}

const TRACK_DOCS = "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced";

/**
 * The jump list Explorer would show for an app: "Fixado" first, then the app's categories in its
 * order (custom ones, the known Recent/Frequent one, "Tarefas"); apps without a custom list get
 * the default Recent category. Recent/frequent items obey "Mostrar itens abertos recentemente…"
 * (Start_TrackDocs) and the "JumpListItems_Maximum" count, and skip what is already pinned.
 */
export function readJumpList(appId: string): JumpCategory[] {
  for (const obj of held) release(obj);
  held = [];
  if (!appId) return [];
  const id = encodeWide(appId);
  const auto = create(CLSID_AutomaticDestinationList, IID_IAutomaticDestinationList);
  const custom = create(CLSID_DestinationList, IID_IInternalCustomDestinationList);
  if (auto) held.push(auto);
  if (custom) held.push(custom);
  // IAutomaticDestinationList::Initialize: slot 3.
  const autoReady = !!auto && vcall(auto, 3, ["ptr", "ptr", "ptr"], id, null, null) === 0;
  const trackDocs = readUserValue(TRACK_DOCS, "Start_TrackDocs", "dword") !== 0;
  const max = Number(readUserValue(TRACK_DOCS, "JumpListItems_Maximum", "dword") ?? 10) || 10;

  // IAutomaticDestinationList::GetList (slot 5): 0 pinned, 1 recent, 2 frequent; flag 1 drops unnamed.
  const autoList = (type: number, count: number) => {
    if (!autoReady) return [];
    const out = new BigUint64Array(1);
    if (vcall(auto, 5, ["i32", "i32", "i32", "ptr", "ptr"], type, count, 1, IID_IObjectArray, new Uint8Array(out.buffer)) !== 0 || !out[0]) return [];
    return destinations(Number(out[0]));
  };
  const pinnedList = autoList(0, 100);
  const pinnedIds = new Set(pinnedList.map((d) => d.id));

  const toItem = (d: Destination, pinnable: boolean): JumpItem => {
    const pinned = pinnedIds.has(d.id);
    return {
      label: d.label,
      iconPath: d.iconPath,
      iconIndex: d.iconIndex,
      pinned,
      pinnable: pinnable && autoReady,
      open: () => invokeDefault(d.obj),
      // IAutomaticDestinationList::PinItem (slot 7): -1 appends to the pinned list, -2 unpins.
      togglePin: () => void (autoReady && vcall(auto, 7, ["ptr", "i32"], d.obj, pinned ? -2 : -1)),
    };
  };
  const unpinned = (list: Destination[]) => list.filter((d) => !pinnedIds.has(d.id)).slice(0, max);

  const categories: JumpCategory[] = [];
  if (pinnedList.length) categories.push({ kind: "pinned", title: "", items: pinnedList.map((d) => toItem(d, true)) });

  let customCount = 0;
  const count = new Uint32Array(1);
  // IInternalCustomDestinationList: SetApplicationID slot 4, GetCategoryCount slot 6.
  if (custom && vcall(custom, 4, ["ptr"], id) === 0 && vcall(custom, 6, ["ptr"], new Uint8Array(count.buffer)) === 0) customCount = count[0]!;
  for (let i = 0; i < customCount; i++) {
    // APPDESTCATEGORY: type at 0 (0 custom, 1 known, 2 tasks), name / known subtype at 8.
    const cat = new Uint8Array(64);
    const view = new DataView(cat.buffer);
    // GetCategory (slot 7) with GETCATFLAG_DEFAULT.
    if (vcall(custom, 7, ["u32", "u32", "ptr"], i, 1, cat) !== 0) continue;
    const type = view.getInt32(0, true);
    if (type === 1) {
      if (!trackDocs) continue;
      const frequent = view.getInt32(8, true) === 1; // KDC_FREQUENT = 1, KDC_RECENT = 2
      const items = unpinned(autoList(frequent ? 2 : 1, max + pinnedList.length));
      if (items.length) categories.push({ kind: frequent ? "frequent" : "recent", title: "", items: items.map((d) => toItem(d, true)) });
      continue;
    }
    let title = "";
    if (type === 0) {
      const name = Number(view.getBigUint64(8, true));
      if (name) title = indirect(takeWide(name));
    }
    const out = new BigUint64Array(1);
    // EnumerateCategoryDestinations: slot 9.
    if (vcall(custom, 9, ["u32", "ptr", "ptr"], i, IID_IObjectArray, new Uint8Array(out.buffer)) !== 0 || !out[0]) continue;
    const list = destinations(Number(out[0]));
    const items = type === 2 ? list : list.filter((d) => !pinnedIds.has(d.id));
    if (items.length) categories.push({ kind: type === 2 ? "tasks" : "custom", title, items: items.map((d) => toItem(d, type !== 2)) });
  }
  // No custom list: the shell's default jump list is the Recent category.
  if (!customCount && trackDocs) {
    const items = unpinned(autoList(1, max + pinnedList.length));
    if (items.length) categories.push({ kind: "recent", title: "", items: items.map((d) => toItem(d, true)) });
  }
  // The taskbar draws "Tarefas" last whatever the order the app committed its list in.
  return [...categories.filter((c) => c.kind !== "tasks"), ...categories.filter((c) => c.kind === "tasks")];
}


/**
 * A link destination's own icon as RGBA at `size` physical px: the icon resource its
 * IconLocation names (Chrome's site favicons, Terminal's profile icons), as the jump list draws it.
 */
export function linkIconPixels(file: string, index: number, size: number) {
  const handle = new BigUint64Array(1);
  const id = new Uint32Array(1);
  const count = user32.symbols.PrivateExtractIconsW(encodeWide(file), index, size, size, new Uint8Array(handle.buffer), new Uint8Array(id.buffer), 1, 0);
  if (!count || count === 0xffffffff || !handle[0]) return null;
  try {
    return iconPixels(Number(handle[0]));
  } finally {
    user32.symbols.DestroyIcon(Number(handle[0]));
  }
}
