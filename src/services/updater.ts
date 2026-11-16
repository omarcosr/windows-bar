import { canInstallUpdate, checkForUpdate, cleanupUpdate, downloadUpdate, installUpdate, store, type Update } from "@tarve/core";
import pkg from "../../package.json" with { type: "json" };
import { config } from "../config";

/**
 * Self-updates from GitHub Releases, the Tarve way: `bun run release` builds, signs (tarve release)
 * and uploads WindowsBar.exe and latest.json; the app checks the signed manifest, downloads the
 * new executable, verifies it and swaps itself (installUpdate restarts it).
 */
export const UPDATE_REPO = "omarcosr/windows-bar";
/** WINDOWSBAR_UPDATE_URL points a copy at another feed (local tests); the manifest is still verified. */
const UPDATE_URL = process.env.WINDOWSBAR_UPDATE_URL || `https://github.com/${UPDATE_REPO}/releases/latest/download/latest.json`;
/** Ed25519 public key from `tarve keygen`; its private half (windows-bar-update.key) signs releases. */
const UPDATE_PUBLIC_KEY = "vE8Xw8cUxDOZnioS0ka0KelRK+2HT7wy2Aou4RDce6Q=";
const CHECK_EVERY = 6 * 60 * 60 * 1000;

export const APP_VERSION: string = pkg.version;

export type UpdateStatus = "idle" | "checking" | "current" | "available" | "downloading" | "ready" | "error" | "unsupported";

export const updater = store({
  status: "idle" as UpdateStatus,
  version: "",
  notes: "",
  progress: 0,
  error: "",
  checkedAt: 0,
});

let pending: Update | null = null;
let downloaded = "";

/** A built, installed copy (not `bun src/main.tsx`) in a folder it can write to. */
export function updatesSupported() {
  return !/\\bun(\.exe)?$/i.test(process.execPath) && canInstallUpdate();
}

export async function checkNow(): Promise<void> {
  if (!updatesSupported()) {
    updater.status = "unsupported";
    return;
  }
  if (updater.status === "checking" || updater.status === "downloading") return;
  updater.status = "checking";
  updater.error = "";
  try {
    const update = await checkForUpdate({ url: UPDATE_URL, publicKey: UPDATE_PUBLIC_KEY, currentVersion: APP_VERSION });
    updater.checkedAt = Date.now();
    if (!update) {
      pending = null;
      updater.status = "current";
      return;
    }
    pending = update;
    Object.assign(updater, { status: "available", version: update.version, notes: update.notes ?? "" });
    if (config.autoUpdate) await download();
  } catch (error) {
    Object.assign(updater, { status: "error", error: error instanceof Error ? error.message : String(error) });
  }
}

/** Downloads and verifies the pending update; it is installed by restartToUpdate(). */
export async function download(): Promise<void> {
  if (!pending || updater.status === "downloading") return;
  updater.status = "downloading";
  updater.progress = 0;
  try {
    downloaded = await downloadUpdate(pending, {
      onProgress: (received, total) => {
        updater.progress = total ? received / total : 0;
      },
    });
    updater.status = "ready";
  } catch (error) {
    Object.assign(updater, { status: "error", error: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * Swaps the executable for the downloaded one and starts it; this process exits (its exit handlers
 * give the strip and the Windows taskbar back first).
 */
export function restartToUpdate() {
  if (downloaded) installUpdate(downloaded, { restart: true });
}


/** Checks, downloads and installs right away (`WindowsBar.exe --update`); restarts when there is one. */
export async function updateNow(): Promise<void> {
  if (updater.status !== "ready") await checkNow();
  if (updater.status === "available") await download();
  if (updater.status === "ready") restartToUpdate();
}

/** Removes what the previous update left, then checks a minute after start and every 6 h. */
export function startUpdater() {
  if (!updatesSupported()) {
    updater.status = "unsupported";
    return;
  }
  try {
    cleanupUpdate();
  } catch {
    // Nothing left behind, or not removable yet.
  }
  setTimeout(() => void checkNow(), 60_000);
  setInterval(() => void checkNow(), CHECK_EVERY);
}
