import { dlopen, read, toArrayBuffer } from "./ffi";
import { decodeWide, encodeWide } from "./wide";

/**
 * A program's name as Windows shows it on the taskbar (jump list title, tooltips): the
 * FileDescription in its version resource ("Google Chrome", not "chrome").
 */
const version = dlopen("version.dll", {
  GetFileVersionInfoSizeW: { args: ["ptr", "ptr"], returns: "u32" },
  GetFileVersionInfoW: { args: ["ptr", "u32", "u32", "ptr"], returns: "i32" },
  VerQueryValueW: { args: ["ptr", "ptr", "ptr", "ptr"], returns: "i32" },
});
const V = version.symbols;

const cache = new Map<string, string>();

function query(block: Uint8Array, path: string): { at: number; length: number } | null {
  const out = new BigUint64Array(1);
  const len = new Uint32Array(1);
  if (!V.VerQueryValueW(block, encodeWide(path), new Uint8Array(out.buffer), new Uint8Array(len.buffer)) || !out[0] || !len[0]) return null;
  return { at: Number(out[0]), length: len[0]! };
}

export function fileDescription(exe: string): string {
  const key = exe.toLowerCase();
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let name = "";
  try {
    const path = encodeWide(exe);
    const size = V.GetFileVersionInfoSizeW(path, null);
    if (size) {
      const block = new Uint8Array(size);
      if (V.GetFileVersionInfoW(path, 0, size, block)) {
        // The first language/code page the file declares, then the usual US English/Unicode one.
        const languages: string[] = [];
        const translation = query(block, "\\VarFileInfo\\Translation");
        if (translation && translation.length >= 4) {
          const lang = read.u16(translation.at, 0);
          const page = read.u16(translation.at, 2);
          languages.push(lang.toString(16).padStart(4, "0") + page.toString(16).padStart(4, "0"));
        }
        languages.push("040904b0", "040904e4");
        for (const language of languages) {
          const value = query(block, `\\StringFileInfo\\${language}\\FileDescription`);
          if (!value) continue;
          // VerQueryValueW returns the length in characters, terminator included.
          name = decodeWide(toArrayBuffer(value.at, 0, value.length * 2), 0, value.length * 2).replace(/\0.*$/s, "").trim();
          if (name) break;
        }
      }
    }
  } catch {
    name = "";
  }
  if (cache.size > 512) cache.clear();
  cache.set(key, name);
  return name;
}
