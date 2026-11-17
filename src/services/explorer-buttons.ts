import { store } from "@tarve/core";
import { programOfAppId } from "../native/shell-item";
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

/**
 * A UIA search of Explorer's taskbar costs 15–20 ms in the app (130 ms under Bun). There is no event
 * to wait for instead: UIA change handlers call back on UIA's own threads, which the JS runtime's FFI
 * cannot take. So it runs every 2 s while a button shows progress, every 5 s while one shows a
 * badge, and otherwise backs off (doubling) to 30 s.
 */
const FAST = 2000;
const BADGES = 5000;
const SLOW = 30_000;
let delay = FAST;
let timer: ReturnType<typeof setTimeout> | undefined;
let users = 0;

function tick() {
  try {
    const buttons = readExplorerButtons();
    const list = buttons ? buttons.filter((b) => b.help.trim()) : [];
    // Progress moves by the second; a count changes now and then; nothing shown, back off.
    const progress = list.some((b) => parse(b.help).progress !== undefined);
    delay = progress ? FAST : list.length ? BADGES : Math.min(SLOW, delay * 2);
    if (buttons && JSON.stringify(list) !== JSON.stringify(explorerButtons.list)) {
      if (process.env.TRAY_DEBUG) console.log("[explorer-buttons]", buttons.length, JSON.stringify(list));
      explorerButtons.list = list;
    }
  } catch (error) {
    console.error("[explorer-buttons]", error);
  }
  if (users) timer = setTimeout(tick, delay);
}

/** Starts reading Explorer's buttons; returns the release function. */
export function acquireExplorerButtons(): () => void {
  if (users++ === 0) {
    delay = FAST;
    tick();
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--users === 0) clearTimeout(timer);
  };
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

/**
 * Does Explorer's button `b` belong to the app at `exe` (a path, or shell:AppsFolder\<AUMID>)?
 * The button carries the app's AppUserModelID; the shell resolves it to its program.
 */
function matches(exe: string, b: ExplorerButton) {
  const path = exe.toLowerCase();
  if (path.startsWith("shell:appsfolder\\")) return b.appId.toLowerCase() === path.slice("shell:appsfolder\\".length);
  const program = programOfAppId(b.appId);
  if (program === path) return true;
  // File Explorer's ID resolves to its shell folder, not to explorer.exe.
  if (b.appId.toLowerCase() === "microsoft.windows.explorer") return /\\windows\\explorer\.exe$/.test(path);
  // Squirrel-installed apps (GitHub Desktop, Discord): the Start entry starts a launcher of the
  // same name one folder up, which runs the versioned copy ("…\\app-3.6.11\\GitHubDesktop.exe").
  const slash = program.lastIndexOf("\\");
  return slash > 0 && path.startsWith(program.slice(0, slash + 1)) && path.endsWith(program.slice(slash));
}

/** What Explorer shows on the app's button, or undefined when it shows nothing. */
export function explorerStateFor(exe: string): ButtonState | undefined {
  const button = explorerButtons.list.find((b) => matches(exe, b));
  return button ? parse(button.help) : undefined;
}
