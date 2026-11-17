import { store } from "@tarve/core";
import { invokeVerb, itemStrings, listFiles, PKEY, readUserValue } from "../native/shell-item";
import { appIdKey } from "./windows";
import { onWatchChange } from "../native/shell-events";

/**
 * The apps pinned to the Windows taskbar, in the taskbar's order, read from where Explorer keeps
 * them: the shortcuts in "User Pinned\\TaskBar", ordered as the Taskband Favorites value lists
 * them, plus Store apps pinned by AppUserModelID (they have no shortcut).
 */
export interface TaskbarPin {
  /** What the taskbar starts: the pinned .lnk (with its arguments and AppUserModelID) or shell:AppsFolder\\<AUMID>. */
  path: string;
  /** The taskbar's identity for it: its AppUserModelID key, or the lower-cased target program. */
  key: string;
  /** The lower-cased target program, which windows without an AppUserModelID are matched by. */
  program: string;
  /** Program the icon is read from. */
  exe: string;
  name: string;
}

export const taskbarPins = store({ items: [] as TaskbarPin[], loaded: false });

const TASKBAND = "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Taskband";
const PINNED_DIR = `${process.env.APPDATA}\\Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar`;

/** Byte offset of `text` (UTF-16) in the Favorites value: the pins' order. */
function offsetIn(blob: Uint8Array, text: string): number {
  const needle = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i++) {
    needle[i * 2] = text.charCodeAt(i) & 0xff;
    needle[i * 2 + 1] = text.charCodeAt(i) >> 8;
  }
  outer: for (let i = 0; i + needle.length <= blob.length; i++) {
    for (let j = 0; j < needle.length; j++) if (blob[i + j] !== needle[j]) continue outer;
    return i;
  }
  return Number.MAX_SAFE_INTEGER;
}

/** Store apps pinned by AppUserModelID: "<package family>!<app>" strings in the Favorites value. */
function packagedPins(blob: Uint8Array): { at: number; id: string; name: string }[] {
  const found: { at: number; id: string; name: string }[] = [];
  const seen = new Set<string>();
  for (const odd of [0, 1]) {
    let text = "";
    for (let i = odd; i + 1 < blob.length; i += 2) text += String.fromCharCode(blob[i]! | (blob[i + 1]! << 8));
    for (const match of text.matchAll(/[\w.-]+_[a-z0-9]{13}![\w.-]+/g)) {
      // The PIDL bytes before the ID can read as letters too: the shell confirms the real ID.
      for (let cut = 0; cut < 4; cut++) {
        const id = match[0].slice(cut);
        if (seen.has(id)) break;
        const [name] = itemStrings(`shell:AppsFolder\\${id}`, [PKEY.displayName]);
        if (!name) continue;
        seen.add(id);
        found.push({ at: odd + 2 * (match.index! + cut), id, name });
        break;
      }
    }
  }
  return found;
}

function readPins(): TaskbarPin[] {
  const blob = readUserValue(TASKBAND, "Favorites", "binary");
  const favorites = blob instanceof Uint8Array ? blob : new Uint8Array(0);
  const pins: (TaskbarPin & { at: number })[] = [];
  for (const file of listFiles(PINNED_DIR, "*.lnk")) {
    const path = `${PINNED_DIR}\\${file}`;
    const [target, appId] = itemStrings(path, [PKEY.linkTarget, PKEY.appUserModelId]);
    const program = (target || path).toLowerCase();
    pins.push({
      at: offsetIn(favorites, file),
      path,
      key: appId ? appIdKey(appId) : program,
      program,
      exe: target || path,
      name: file.replace(/\.lnk$/i, ""),
    });
  }
  for (const app of packagedPins(favorites)) {
    const path = `shell:AppsFolder\\${app.id}`;
    pins.push({ at: app.at, path, key: appIdKey(app.id), program: path.toLowerCase(), exe: path, name: app.name });
  }
  return pins.sort((a, b) => a.at - b.at).map(({ at: _, ...pin }) => pin);
}

/** Explorer bumps FavoritesChanges on every pin, unpin and reorder. */
function favoritesStamp(): string {
  return String(readUserValue(TASKBAND, "FavoritesChanges", "dword") ?? "");
}

/**
 * "Desafixar da barra de tarefas": Windows' own verb on the pinned shortcut (or Store app), invoked
 * through the item's shell context menu as Explorer's menu does.
 */
export async function unpinFromTaskbar(pin: TaskbarPin): Promise<boolean> {
  const ok = invokeVerb(pin.path, "taskbarunpin");
  await refreshPins?.();
  return ok;
}

let refreshPins: (() => Promise<void>) | undefined;
let watching = false;

export function watchTaskbarPins() {
  if (watching) return;
  watching = true;
  let stamp: string | null = null;
  const tick = async () => {
    try {
      const next = favoritesStamp();
      if (next === stamp && taskbarPins.loaded) return;
      const items = readPins();
      stamp = next;
      if (JSON.stringify(items) !== JSON.stringify(taskbarPins.items)) taskbarPins.items = items;
      taskbarPins.loaded = true;
    } catch (error) {
      console.error("[taskbar-pins]", error);
    }
  };
  refreshPins = async () => {
    stamp = null;
    taskbarPins.loaded = false;
    await tick();
  };
  void tick();
  // Explorer writes Taskband\Favorites and the User Pinned\TaskBar shortcuts on every pin,
  // unpin and reorder: their change notifications drive the refresh, nothing is polled.
  onWatchChange(["taskband", "pinned"], () => void tick());
}
