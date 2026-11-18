import { store } from "@tarve/core";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { onWatchChange } from "../native/shell-events";
import { acquireTaskbarHost, overlays } from "./taskbar-host";
import { acquireExplorerButtons, explorerStateFor } from "./explorer-buttons";
import { openReadonly } from "../runtime/sqlite";
import type { ReadonlyDatabase } from "../runtime/sqlite";

/**
 * Unread counts and other badges apps put on their taskbar button. Two sources:
 * - Win32 apps (Discord, Telegram, Electron apps) draw an overlay icon with ITaskbarList3,
 *   which reaches the dock while it hosts the task band (services/taskbar-host.ts).
 *   Apps that were running before the dock keep talking to Explorer only; their count is read
 *   from Explorer's own button (services/explorer-buttons.ts).
 * - Packaged apps (WhatsApp, Teams, Mail) post a badge notification; Windows keeps it in the
 *   notification database, read here again whenever Windows writes to its folder.
 */

export interface Badge {
  /** "44", "99+", or "" when the badge is a picture or a dot. */
  text: string;
  /** Overlay icon PNG: Win32 apps draw their badge (count included) as a small icon. */
  image: string;
}

/** Badge value by package family name (`Name_publisherId`), e.g. { "5319275A.WhatsAppDesktop_cv1t1ezwj8rmp": "44" }. */
export const packageBadges = store<Record<string, string>>({});

const dbPath = join(process.env.LOCALAPPDATA ?? "", "Microsoft", "Windows", "Notifications", "wpndatabase.db");
let db: ReadonlyDatabase | null = null;

let readingBadges = false;

async function readPackageBadges() {
  if (!db) {
    if (!existsSync(dbPath)) return;
    db = await openReadonly(dbPath);
  }
  const rows = db.all<{ id: string; payload: string }>(
    "select h.PrimaryId as id, cast(n.Payload as text) as payload from Notification n join NotificationHandler h on h.RecordId = n.HandlerId where n.Type = 'badge'",
  );
  const next: Record<string, string> = {};
  for (const row of rows) {
    const value = /value\s*=\s*"([^"]*)"/.exec(row.payload ?? "")?.[1];
    const family = row.id.split("!")[0]!;
    if (value && value !== "none" && value !== "0") next[family] = value;
  }
  for (const key of Object.keys(packageBadges)) if (!(key in next)) delete packageBadges[key];
  for (const [key, value] of Object.entries(next)) if (packageBadges[key] !== value) packageBadges[key] = value;
}

/** Reads the notification database's badges; runs when Windows writes the database (its folder's change notification). */
async function refreshBadges() {
  if (readingBadges) return;
  readingBadges = true;
  try {
    await readPackageBadges();
  } catch (error) {
    // The database is busy now and then (Windows writes to it); read again on its next write.
    db?.close();
    db = null;
    if (!String(error).includes("locked")) console.error("[badges]", error);
  } finally {
    readingBadges = false;
  }
}

/** Starts both badge sources; returns the release function. */
export function acquireBadges(): () => void {
  const host = acquireTaskbarHost();
  void refreshBadges();
  const offWrites = onWatchChange(["notifications"], () => void refreshBadges(), 300);
  const explorer = acquireExplorerButtons();
  return () => {
    host();
    offWrites();
    explorer();
  };
}

/**
 * The package family of a packaged app: from its AppUserModelID ("shell:AppsFolder\\Name_publisher!App"),
 * which is how the dock identifies running packaged apps; a WindowsApps path otherwise
 * (`C:\\Program Files\\WindowsApps\\Name_1.2.3.0_x64__publisher\\App.exe` -> `Name_publisher`).
 */
export function packageFamilyOf(exe: string): string | undefined {
  const id = /^shell:AppsFolder\\([^!]+)!/i.exec(exe);
  if (id) return id[1];
  const m = /\\WindowsApps\\([^_\\]+)_[^\\]*?__([^\\]+)\\/i.exec(exe);
  return m ? `${m[1]}_${m[2]}` : undefined;
}

const countText = (n: number) => (n > 99 ? "99+" : String(n));

/** The badge to draw on an app icon, or undefined. Reads stores, so the icon follows changes. */
export function badgeFor(exe: string): Badge | undefined {
  const family = packageFamilyOf(exe);
  if (family) {
    const value = Object.entries(packageBadges).find(([key]) => key.toLowerCase() === family.toLowerCase())?.[1];
    if (value) return { text: /^\d+$/.test(value) ? countText(Number(value)) : "", image: "" };
  }
  const key = exe.toLowerCase();
  const overlay = Object.values(overlays).find((o) => o.key === key);
  if (overlay) return { text: "", image: overlay.image };
  // Apps started before the dock badge Explorer's button only: take the count from there.
  const badge = explorerStateFor(exe)?.badge;
  return badge !== undefined ? { text: badge, image: "" } : undefined;
}
