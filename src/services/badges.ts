import { store } from "@tarve/core";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createPoller } from "./poller";
import { acquireTaskbarHost, overlays } from "./taskbar-host";
import { openReadonly } from "../runtime/sqlite";
import type { ReadonlyDatabase } from "../runtime/sqlite";

/**
 * Unread counts and other badges apps put on their taskbar button. Two sources:
 * - Win32 apps (Discord, Telegram, Electron apps) draw an overlay icon with ITaskbarList3,
 *   which reaches the dock while it hosts the task band (services/taskbar-host.ts).
 * - Packaged apps (WhatsApp, Teams, Mail) post a badge notification; Windows keeps it in the
 *   notification database, read here every few seconds.
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

const dbPoller = createPoller(3000, async () => {
  if (readingBadges) return;
  readingBadges = true;
  try {
    await readPackageBadges();
  } catch (error) {
    // The database is busy now and then (Windows writes to it); try again next tick.
    db?.close();
    db = null;
    if (!String(error).includes("locked")) console.error("[badges]", error);
  } finally {
    readingBadges = false;
  }
});

/** Starts both badge sources; returns the release function. */
export function acquireBadges(): () => void {
  const host = acquireTaskbarHost();
  const poll = dbPoller.acquire();
  return () => {
    host();
    poll();
  };
}

/** `C:\\Program Files\\WindowsApps\\Name_1.2.3.0_x64__publisher\\App.exe` -> `Name_publisher`. */
export function packageFamilyOf(exe: string): string | undefined {
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
  return overlay ? { text: "", image: overlay.image } : undefined;
}
