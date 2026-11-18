import { store } from "@tarve/core";
import { programOfAppId } from "../native/shell-item";
import { readExplorerButtons, watchExplorerButtons, type ExplorerButton } from "../native/taskbar-buttons";
import { onShellEvent } from "../native/shell-events";
import { dockCovered, onDockCoveredChange } from "./poller";

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
 * Explorer's UIA events (a button's HelpText changed, buttons added or removed) trigger a read of
 * the buttons, one cross-process UIA search (15–20 ms in the app). A burst of events (a progress
 * bar moving, a window opening) is one read, never closer than GAP to the last one. Nothing is
 * read while the dock cannot be seen (covered, locked, screen off): the change waits until it can.
 */
const GAP = 1000;
const SETTLE = 250;
let timer: ReturnType<typeof setTimeout> | undefined;
let users = 0;
let lastRead = 0;
let stopWatch: (() => void) | null = null;
let offShell: (() => void) | undefined;
let retry: ReturnType<typeof setTimeout> | undefined;

/** True while a flyout is open (set by main.tsx): the blocking UIA read waits, so it never stalls it. */
let busy: () => boolean = () => false;
export function pauseExplorerButtonsWhile(check: () => boolean) {
  busy = check;
}

/** A change that came while the dock could not be seen; read when it can again. */
let waiting = false;
onDockCoveredChange(() => {
  if (dockCovered() || !waiting || !users) return;
  waiting = false;
  clearTimeout(timer);
  timer = undefined;
  read();
});

/** Explorer changed a button: read once the burst settles. */
function changed() {
  if (!users || waiting || timer) return;
  timer = setTimeout(read, Math.max(SETTLE, GAP - (Date.now() - lastRead)));
}

function read() {
  timer = undefined;
  if (dockCovered()) {
    waiting = true;
    return;
  }
  if (busy()) {
    // The flyout closes on the next click elsewhere; try again then.
    if (users) timer = setTimeout(read, 1000);
    return;
  }
  lastRead = Date.now();
  try {
    const buttons = readExplorerButtons();
    const list = buttons ? buttons.filter((b) => b.help.trim()) : [];
    if (buttons && JSON.stringify(list) !== JSON.stringify(explorerButtons.list)) {
      if (process.env.TRAY_DEBUG) console.log("[explorer-buttons]", buttons.length, JSON.stringify(list));
      explorerButtons.list = list;
    }
  } catch (error) {
    console.error("[explorer-buttons]", error);
  }
}

/** Subscribes to Explorer's taskbar (again after Explorer restarts) and reads it once. */
function watch(tries = 0) {
  clearTimeout(retry);
  stopWatch?.();
  try {
    stopWatch = watchExplorerButtons(changed);
  } catch (error) {
    stopWatch = null;
    console.error("[explorer-buttons]", error);
  }
  // A restarted Explorer announces TaskbarCreated before its XAML taskbar is up.
  if (!stopWatch && tries < 5) retry = setTimeout(() => users && watch(tries + 1), 2000);
  clearTimeout(timer);
  timer = undefined;
  waiting = false;
  read();
}

/** Starts reading Explorer's buttons; returns the release function. */
export function acquireExplorerButtons(): () => void {
  if (users++ === 0) {
    offShell = onShellEvent((event) => {
      if (event.type === "explorerRestarted") watch();
    });
    watch();
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--users === 0) {
      clearTimeout(timer);
      clearTimeout(retry);
      timer = undefined;
      offShell?.();
      offShell = undefined;
      stopWatch?.();
      stopWatch = null;
    }
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
