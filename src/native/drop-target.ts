import { CFunction, dlopen, read, type Pointer } from "./ffi";
import { encodeWide } from "./wide";

/**
 * Files dropped on a taskbar button, handed over as Explorer does: the shell's own drop target of
 * the pinned item (the .lnk, the program or shell:AppsFolder\<AUMID>) gets a data object of the
 * files through IDropTarget, so the app starts with them exactly as when they are dropped on that
 * shortcut in Explorer (arguments, working folder, packaged-app activation included).
 *
 * The dock's window itself is an OLE drop target through @tarve/core (`onFileDrop`), which uses
 * RegisterDragDrop; this module only forwards the drop to the shell item.
 */

const shell32 = dlopen("shell32.dll", {
  SHCreateItemFromParsingName: { args: ["ptr", "ptr", "ptr", "ptr"], returns: "i32" },
  SHParseDisplayName: { args: ["ptr", "ptr", "ptr", "u32", "ptr"], returns: "i32" },
  SHCreateShellItemArrayFromIDLists: { args: ["u32", "ptr", "ptr"], returns: "i32" },
});
const ole32 = dlopen("ole32.dll", {
  CoInitializeEx: { args: ["ptr", "u32"], returns: "i32" },
  CoTaskMemFree: { args: ["ptr"], returns: "void" },
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

const IID_IShellItem = guid("43826D1E-E718-42EE-BC55-A1E261C37BFE");
const IID_IDropTarget = guid("00000122-0000-0000-C000-000000000046");
const IID_IDataObject = guid("0000010E-0000-0000-C000-000000000046");
const BHID_SFUIObject = guid("3981E225-F559-11D3-8E3A-00C04F6837D5");
const BHID_DataObject = guid("B8C0BD9F-ED24-455C-83E6-D5390C4FE8C4");

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

/** IDataObject of `paths` from the shell (IShellItemArray → BHID_DataObject), as Explorer builds it. */
function dataObjectOf(paths: string[]): number | null {
  const pidls = new BigUint64Array(paths.length);
  try {
    for (let i = 0; i < paths.length; i++) {
      const out = new BigUint64Array(1);
      if (shell32.symbols.SHParseDisplayName(encodeWide(paths[i]!), null, new Uint8Array(out.buffer), 0, null) < 0 || !out[0]) return null;
      pidls[i] = out[0];
    }
    const out = new BigUint64Array(1);
    if (shell32.symbols.SHCreateShellItemArrayFromIDLists(paths.length, new Uint8Array(pidls.buffer), new Uint8Array(out.buffer)) < 0 || !out[0]) return null;
    const array = Number(out[0]);
    try {
      out[0] = 0n;
      // IShellItemArray::BindToHandler: slot 3.
      if (vcall(array, 3, ["ptr", "ptr", "ptr", "ptr"], null, BHID_DataObject, IID_IDataObject, new Uint8Array(out.buffer)) < 0 || !out[0]) return null;
      return Number(out[0]);
    } finally {
      vcall(array, 2, []);
    }
  } finally {
    for (const pidl of pidls) if (pidl) ole32.symbols.CoTaskMemFree(Number(pidl));
  }
}

/** The shell's IDropTarget of a shell item (shortcut, program, packaged app), or null. */
function dropTargetOf(target: string): number | null {
  const out = new BigUint64Array(1);
  if (shell32.symbols.SHCreateItemFromParsingName(encodeWide(target), null, IID_IShellItem, new Uint8Array(out.buffer)) < 0 || !out[0]) return null;
  const item = Number(out[0]);
  try {
    out[0] = 0n;
    // IShellItem::BindToHandler: slot 3.
    if (vcall(item, 3, ["ptr", "ptr", "ptr", "ptr"], null, BHID_SFUIObject, IID_IDropTarget, new Uint8Array(out.buffer)) < 0 || !out[0]) return null;
    return Number(out[0]);
  } finally {
    vcall(item, 2, []);
  }
}

/**
 * Drops `paths` on the shell item `target` (DragEnter, then Drop), as Explorer does when files are
 * dropped on a shortcut or program: the item's drop handler starts it with the files. False when
 * the item takes no files (its DragEnter answers DROPEFFECT_NONE) or the shell refused.
 */
export function dropFilesOn(target: string, paths: string[], point: { x: number; y: number }): boolean {
  if (!paths.length) return false;
  ensureCom();
  const data = dataObjectOf(paths);
  if (data === null) return false;
  try {
    const drop = dropTargetOf(target);
    if (drop === null) return false;
    try {
      // POINTL goes by value in one register: x in the low 32 bits, y in the high.
      const pt = (BigInt(point.y >>> 0) << 32n) | BigInt(point.x >>> 0);
      const effect = new Uint32Array([7 /* DROPEFFECT_COPY | MOVE | LINK */]);
      // IDropTarget::DragEnter: slot 3, with the left button held (MK_LBUTTON) as during a drag.
      if (vcall(drop, 3, ["ptr", "u32", "u64", "ptr"], data, 1, pt, effect) < 0 || effect[0] === 0) {
        vcall(drop, 5, []); // DragLeave
        return false;
      }
      effect[0] = 7;
      // IDropTarget::Drop: slot 6, button released.
      return vcall(drop, 6, ["ptr", "u32", "u64", "ptr"], data, 0, pt, effect) >= 0 && effect[0] !== 0;
    } finally {
      vcall(drop, 2, []);
    }
  } finally {
    vcall(data, 2, []);
  }
}
