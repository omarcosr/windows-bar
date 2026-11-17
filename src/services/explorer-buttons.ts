import { store } from "@tarve/core";
import { basename } from "node:path";
import { createPoller } from "./poller";
import { readExplorerButtons, type ExplorerButton } from "../native/taskbar-buttons";

/**
 * Badges and progress as Explorer shows them on its own taskbar buttons (native/taskbar-buttons.ts).
 * Apps started before the dock talk to Explorer only, so this is what lets their counts and
 * progress show up on the dock too.
 */

export interface ButtonState {
  /** Count from the overlay description ("1 Unread Notification" -> "1"), "" for a plain dot, undefined without a badge. */
  badge?: string;
  /** 0..1 while the app reports progress. */
  progress?: number;
}

/** Only the buttons Explorer shows something on (overlay or progress). */
export const explorerButtons = store({ list: [] as ExplorerButton[] });

const poller = createPoller(2000, () => {
  const buttons = readExplorerButtons();
  if (!buttons) return;
  const list = buttons.filter((b) => b.help.trim());
  if (JSON.stringify(list) === JSON.stringify(explorerButtons.list)) return;
  if (process.env.TRAY_DEBUG) console.log("[explorer-buttons]", buttons.length, JSON.stringify(list));
  explorerButtons.list = list;
});

/** Starts reading Explorer's buttons; returns the release function. */
export function acquireExplorerButtons(): () => void {
  return poller.acquire();
}

// "Operação 29.999695 porcentagem concluída", "Operation 30 percent complete", "30%".
const PROGRESS = /[^\d,;.]*?(\d+(?:[.,]\d+)?)\s*(?:%|porcent\w*|percent\w*|pour\s*cent\w*|prozent\w*)[^,;]*/i;

function parse(help: string): ButtonState {
  const state: ButtonState = {};
  const progress = PROGRESS.exec(help);
  if (progress) state.progress = Math.min(1, Math.max(0, Number(progress[1]!.replace(",", ".")) / 100));
  const rest = (progress ? help.replace(progress[0], "") : help).replace(/^[\s,;.]+|[\s,;.]+$/g, "");
  if (rest) {
    const count = /\d+/.exec(rest)?.[0];
    const n = count ? Number(count) : -1;
    // "0 Unread Notifications": the app keeps a description at zero, Windows shows no count then.
    if (n !== 0) state.badge = n > 99 ? "99+" : n > 0 ? String(n) : "";
  }
  return state;
}

/** Does Explorer's button `b` belong to the app at `exe` (a path, or shell:AppsFolder\<AUMID>)? */
function matches(exe: string, b: ExplorerButton) {
  const id = b.appId.toLowerCase();
  const path = exe.toLowerCase();
  if (path.startsWith("shell:appsfolder\\")) return id === path.slice("shell:appsfolder\\".length);
  const base = basename(path).replace(/\.exe$/, "");
  if (!base) return false;
  // "chrome", "microsoft.windows.explorer", "{folder}\\windowspowershell\\v1.0\\powershell.exe".
  if (id === base || id.endsWith(`\\${base}.exe`) || id.split(/[.\\!_]/).includes(base)) return true;
  // "dev.empryo.desktop" for Empryo.exe, "com.squirrel.githubdesktop.githubdesktop" for GitHubDesktop.exe.
  return base.length >= 4 && (id.includes(base) || b.name.toLowerCase().startsWith(base));
}

/** What Explorer shows on the app's button, or undefined when it shows nothing. */
export function explorerStateFor(exe: string): ButtonState | undefined {
  const button = explorerButtons.list.find((b) => matches(exe, b));
  return button ? parse(button.help) : undefined;
}
