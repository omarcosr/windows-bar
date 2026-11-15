import { appConfigDirectory, store, toRaw } from "@tarve/core";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface WidgetInstance {
  /** Unique per placed widget; several clocks can live on the dock at once. */
  id: string;
  type: string;
  config: Record<string, unknown>;
}

export type DockMode = "floating" | "full";

export interface DockConfig {
  version: 1;
  widgets: WidgetInstance[];
  /** Reserve a strip at the bottom of the screen so maximized windows stop above the dock. */
  reserveSpace: boolean;
  /** Hide the Windows taskbar while the dock runs (restored on exit). */
  hideNativeTaskbar: boolean;
  /** "floating": a centred pill above the screen edge. "full": a bar across the whole screen, like the Windows taskbar. */
  mode: DockMode;
  /** Opacity of the bar's background, 0.2–1; icons and widgets stay opaque. */
  opacity: number;
  /** Live window previews when the pointer rests on an app icon. */
  hoverPreview: boolean;
  /** Gap between the dock and the bottom of the screen, in logical px. */
  bottomMargin: number;
}

export const configDir = appConfigDirectory("windows-bar");
const configPath = join(configDir, "config.json");

export const defaultConfig = (): DockConfig => ({
  version: 1,
  reserveSpace: true,
  hideNativeTaskbar: false,
  mode: "floating",
  hoverPreview: true,
  opacity: 1,
  bottomMargin: 8,
  widgets: [
    { id: "clock-1", type: "clock-weather", config: {} },
    { id: "revenue-1", type: "revenue", config: {} },
    { id: "start-1", type: "start", config: {} },
    { id: "apps-1", type: "apps", config: {} },
    { id: "system-1", type: "system", config: {} },
    { id: "media-1", type: "now-playing", config: {} },
  ],
});

function load(): DockConfig {
  try {
    if (existsSync(configPath)) {
      const parsed = JSON.parse(readFileSync(configPath, "utf8").replace(/^\uFEFF/, "")) as Partial<DockConfig>;
      return { ...defaultConfig(), ...parsed, version: 1 };
    }
  } catch (error) {
    console.error("[config] could not read", configPath, error);
  }
  return defaultConfig();
}

/** Live configuration: changing it re-renders the dock; call saveConfig() to persist. */
export const config = store(load());

let saveTimer: ReturnType<typeof setTimeout> | undefined;

export function saveConfig() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      mkdirSync(configDir, { recursive: true });
      writeFileSync(configPath, JSON.stringify(toRaw(config), null, 2));
    } catch (error) {
      console.error("[config] could not save", error);
    }
  }, 250);
}

export function newInstanceId(type: string) {
  return `${type}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}
