import { readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { PKEY, itemStrings, knownFolderPath } from "../native/shell-item";

/**
 * Shortcut lists read where the shell keeps them: the Recent folder (shell:recent, what Explorer's
 * "Recentes" and the jump lists show) and the two Start menu Programs folders.
 */

const FOLDERID_Recent = "{AE50C081-EBD2-438A-8655-8A092E34987A}";
const FOLDERID_Programs = "{A77F5D77-2E2B-44C3-A6A2-ABA601054A51}";
const FOLDERID_CommonPrograms = "{0139D44E-6AFE-49F2-8690-3DAFCAE6FFB8}";

export interface Shortcut {
  /** The .lnk itself: what Explorer and Start open (ShellExecute). */
  path: string;
  /** Its name as the shell shows it (the file name without .lnk). */
  name: string;
  /** What it points at, "" for shell items without a file path. */
  target: string;
  modified: number;
}

const targetCache = new Map<string, string>();
function targetOf(lnk: string) {
  let target = targetCache.get(lnk);
  if (target === undefined) {
    target = itemStrings(lnk, [PKEY.linkTarget])[0] ?? "";
    if (targetCache.size > 512) targetCache.clear();
    targetCache.set(lnk, target);
  }
  return target;
}

/** The newest items of shell:recent, newest first. */
export function recentItems(limit = 12): Shortcut[] {
  const dir = knownFolderPath(FOLDERID_Recent);
  if (!dir) return [];
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => /\.lnk$/i.test(n));
  } catch {
    return [];
  }
  const items = names.map((n) => {
    const path = join(dir, n);
    let modified = 0;
    try {
      modified = statSync(path).mtimeMs;
    } catch {}
    return { path, name: n.replace(/\.lnk$/i, ""), target: "", modified };
  });
  items.sort((a, b) => b.modified - a.modified);
  // Files and folders only, once each, as Explorer's "Recentes" lists them (not URI shortcuts
  // such as ms-screenclip: that apps also drop there).
  const out: Shortcut[] = [];
  const seen = new Set<string>();
  for (const item of items.slice(0, limit * 6)) {
    const target = targetOf(item.path);
    if (!/^([a-z]:\\|\\\\)/i.test(target) || seen.has(target.toLowerCase())) continue;
    seen.add(target.toLowerCase());
    out.push({ ...item, name: basename(target) || item.name.replace(/ \(\d+\)$/, ""), target });
    if (out.length >= limit) break;
  }
  return out;
}

let startCache: { at: number; list: Shortcut[] } | null = null;

/** Every shortcut of the Start menu (user and all-users Programs folders), cached for a minute. */
export function startMenuShortcuts(): Shortcut[] {
  if (startCache && Date.now() - startCache.at < 60_000) return startCache.list;
  const list: Shortcut[] = [];
  const seen = new Set<string>();
  const walk = (dir: string, depth: number) => {
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry);
      if (/\.lnk$/i.test(entry)) {
        const name = basename(entry, entry.slice(-4));
        if (/^(uninstall|desinstalar)/i.test(name) || seen.has(name.toLowerCase())) continue;
        seen.add(name.toLowerCase());
        list.push({ path, name, target: "", modified: 0 });
      } else if (depth < 3 && !/\.\w{2,4}$/.test(entry)) {
        try {
          if (statSync(path).isDirectory()) walk(path, depth + 1);
        } catch {}
      }
    }
  };
  for (const id of [FOLDERID_Programs, FOLDERID_CommonPrograms]) {
    const dir = knownFolderPath(id);
    if (dir) walk(dir, 0);
  }
  list.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  startCache = { at: Date.now(), list };
  return list;
}

/** The Start shortcut that starts `program` (a lower-cased exe path), if any. */
export function shortcutFor(program: string): Shortcut | undefined {
  const wanted = program.toLowerCase();
  return startMenuShortcuts().find((s) => {
    s.target ||= targetOf(s.path);
    return s.target.toLowerCase() === wanted;
  });
}
