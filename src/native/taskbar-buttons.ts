import { CFunction, dlopen, read, toArrayBuffer, FfiUnsupported, type Pointer } from "./ffi";
import { decodeWide, encodeWide } from "./wide";
import { explorerTray } from "./win32";

/**
 * Reads Explorer's taskbar buttons through UI Automation (raw COM vtables).
 *
 * ITaskbarList caches the task band window the first time an app uses it, so apps started
 * before the dock keep sending overlay badges and progress to Explorer only. Explorer exposes
 * both on each button's HelpText ("1 Unread Notification", "Operação 30 porcentagem
 * concluída"), which is what this returns, keyed by the button's AppUserModelID.
 */

export interface ExplorerButton {
  /** AppUserModelID, e.g. "Chrome", "dev.empryo.desktop", or a path for apps without one. */
  appId: string;
  name: string;
  /** Overlay description and progress text, "" when the button shows neither. */
  help: string;
}

const ole32 = dlopen("ole32.dll", {
  CoInitializeEx: { args: ["ptr", "u32"], returns: "i32" },
  CoCreateInstance: { args: ["ptr", "ptr", "u32", "ptr", "ptr"], returns: "i32" },
});
const user32 = dlopen("user32.dll", { FindWindowExW: { args: ["ptr", "ptr", "ptr", "ptr"], returns: "ptr" } });
const oleaut32 = dlopen("oleaut32.dll", {
  SysAllocString: { args: ["ptr"], returns: "ptr" },
  SysFreeString: { args: ["ptr"], returns: "void" },
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
  return call!(obj, ...values.map((value) => (ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : value)));
}

const release = (obj: Pointer) => com(obj, 2, []);

const CLSID_CUIAutomation = guid("ff48dba4-60ef-4201-aa87-54103eef594e");
const IID_IUIAutomation = guid("30cbe57d-d9d0-452a-ab13-7ac5ac4825ee");
const UIA_ClassNamePropertyId = 30012;
const TreeScope_Descendants = 4;
const VT_BSTR = 8;

// IUIAutomation slots.
const ElementFromHandle = 6;
const CreatePropertyCondition = 23;
// IUIAutomationElement slots.
const FindAll = 6;
const get_CurrentName = 23;
const get_CurrentAutomationId = 29;
const get_CurrentHelpText = 31;
const CreateCacheRequest = 20;
const FindAllBuildCache = 8;
const get_CachedName = 55;
const get_CachedAutomationId = 61;
const get_CachedHelpText = 63;
// IUIAutomationCacheRequest slots and property ids.
const AddProperty = 3;
const put_AutomationElementMode = 11;
const UIA_NamePropertyId = 30005;
const UIA_AutomationIdPropertyId = 30011;
const UIA_HelpTextPropertyId = 30013;
// IUIAutomationElementArray slots.
const get_Length = 3;
const GetElement = 4;

let automation: Pointer | null = null;
let condition: Pointer | null = null;
/** Fetches the three properties with the search, in one cross-process call instead of 3 per button. */
let cache: Pointer | null = null;
let unsupported = false;
const out = new BigUint64Array(1);

function outPtr(): Pointer | null {
  return out[0] ? (Number(out[0]) as unknown as Pointer) : null;
}

function bstrText(bstr: Pointer | null): string {
  if (!bstr) return "";
  const bytes = read.u32((bstr as number) - 4);
  const text = bytes ? decodeWide(toArrayBuffer(bstr, 0, bytes), 0, bytes) : "";
  oleaut32.symbols.SysFreeString(bstr);
  return text;
}

function stringProp(element: Pointer, slot: number): string {
  out[0] = 0n;
  if (com(element, slot, ["ptr"], out) !== 0) return "";
  return bstrText(outPtr());
}

function init(): boolean {
  if (automation && condition) return true;
  ole32.symbols.CoInitializeEx(null, 2 /* COINIT_APARTMENTTHREADED */);
  out[0] = 0n;
  if (ole32.symbols.CoCreateInstance(CLSID_CUIAutomation, null, 1 /* CLSCTX_INPROC_SERVER */, IID_IUIAutomation, new Uint8Array(out.buffer)) !== 0) return false;
  automation = outPtr();
  if (!automation) return false;
  // VARIANT (VT_BSTR) with the class name of the task list buttons; x64 passes it by reference.
  const bstr = oleaut32.symbols.SysAllocString(encodeWide("Taskbar.TaskListButtonAutomationPeer")) as Pointer;
  const variant = new Uint8Array(24);
  const v = new DataView(variant.buffer);
  v.setUint16(0, VT_BSTR, true);
  v.setBigUint64(8, BigInt(bstr as number), true);
  out[0] = 0n;
  const hr = com(automation, CreatePropertyCondition, ["i32", "ptr", "ptr"], UIA_ClassNamePropertyId, variant, out);
  oleaut32.symbols.SysFreeString(bstr);
  condition = hr === 0 ? outPtr() : null;
  out[0] = 0n;
  if (com(automation, CreateCacheRequest, ["ptr"], out) === 0 && out[0]) {
    cache = outPtr()!;
    for (const id of [UIA_NamePropertyId, UIA_AutomationIdPropertyId, UIA_HelpTextPropertyId]) com(cache, AddProperty, ["i32"], id);
    // AutomationElementMode_None: only the cached values come back, no live element references.
    com(cache, put_AutomationElementMode, ["i32"], 0);
  }
  return !!condition;
}

const bridgeClass = encodeWide("Windows.UI.Composition.DesktopWindowContentBridge");

/**
 * Where the buttons live: the XAML island inside Explorer's taskbar. Asked through the taskbar
 * itself, UIA finds nothing once the dock has hidden it (SW_HIDE); the island still answers.
 */
function taskbarRoot(): Pointer | null {
  const tray = explorerTray();
  if (!tray) return null;
  return (user32.symbols.FindWindowExW(tray, null, bridgeClass, null) as Pointer | null) ?? tray;
}

/** Explorer's task list buttons, or null when they cannot be read (no Explorer taskbar, no UIA). */
export function readExplorerButtons(tray: Pointer | null = taskbarRoot()): ExplorerButton[] | null {
  if (unsupported) return null;
  try {
    if (!init() || !tray) return null;
    out[0] = 0n;
    if (com(automation!, ElementFromHandle, ["ptr", "ptr"], tray, out) !== 0 || !out[0]) return null;
    const root = outPtr()!;
    try {
      out[0] = 0n;
      const found = cache
        ? com(root, FindAllBuildCache, ["i32", "ptr", "ptr", "ptr"], TreeScope_Descendants, condition, cache, out)
        : com(root, FindAll, ["i32", "ptr", "ptr"], TreeScope_Descendants, condition, out);
      if (found !== 0 || !out[0]) return null;
      const array = outPtr()!;
      try {
        const length = new Int32Array(1);
        com(array, get_Length, ["ptr"], length);
        const buttons: ExplorerButton[] = [];
        for (let i = 0; i < length[0]!; i++) {
          out[0] = 0n;
          if (com(array, GetElement, ["i32", "ptr"], i, out) !== 0 || !out[0]) continue;
          const element = outPtr()!;
          try {
            const id = stringProp(element, cache ? get_CachedAutomationId : get_CurrentAutomationId);
            buttons.push({
              appId: id.replace(/^Appid:\s*/i, ""),
              name: stringProp(element, cache ? get_CachedName : get_CurrentName),
              help: stringProp(element, cache ? get_CachedHelpText : get_CurrentHelpText),
            });
          } finally {
            release(element);
          }
        }
        return buttons;
      } finally {
        release(array);
      }
    } finally {
      release(root);
    }
  } catch (error) {
    if (error instanceof FfiUnsupported) {
      unsupported = true;
      return null;
    }
    throw error;
  }
}
