import { store } from "@tarve/core";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "../config";
import iconScript from "../../scripts/extract-icons.ps1" with { type: "text" };

// v2: icons from IShellItemImageFactory (sharp, with Store apps); older blurry ones are skipped.
const cacheDir = join(configDir, "icons-v2");
mkdirSync(cacheDir, { recursive: true });
const scriptPath = join(cacheDir, "extract-icons.ps1");
writeFileSync(scriptPath, iconScript);

/** exe path (lowercase) -> PNG path, filled as icons are extracted; reading it re-renders on arrival. */
export const icons = store<Record<string, string>>({});

const pending = new Set<string>();
let queued: string[] = [];
let running = false;

const pngFor = (exe: string) => join(cacheDir, `${Bun.hash(exe.toLowerCase()).toString(16)}.png`);

export function iconFor(exe: string): string | undefined {
  const key = exe.toLowerCase();
  const known = icons[key];
  if (known) return known;
  if (!exe || pending.has(key)) return undefined;
  const png = pngFor(exe);
  if (existsSync(png)) {
    icons[key] = png;
    return png;
  }
  pending.add(key);
  queued.push(exe);
  queueMicrotask(flush);
  return undefined;
}

async function flush() {
  if (running || queued.length === 0) return;
  running = true;
  const batch = queued;
  queued = [];
  const jobs = batch.map((exe) => `${exe}|${pngFor(exe)}`).join("\n");
  const listPath = join(cacheDir, "jobs.txt");
  writeFileSync(listPath, jobs);
  try {
    const proc = Bun.spawn(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, listPath], {
      stdout: "ignore",
      stderr: "pipe",
      windowsHide: true,
    });
    await proc.exited;
  } catch (error) {
    console.error("[icons]", error);
  }
  for (const exe of batch) {
    const png = pngFor(exe);
    if (existsSync(png)) icons[exe.toLowerCase()] = png;
  }
  running = false;
  if (queued.length) flush();
}
