import { appConfigDirectory, store, toRaw } from "@tarve/core";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface WidgetInstance {
  /** Unique per placed widget; several clocks can live on the dock at once. */
  id: string;
  type: string;
  config: Record<string, unknown>;
}

export type HoverEffect = "zoom" | "lift" | "glow" | "highlight" | "none";

export type GlowColor = "accent" | "white" | "blue" | "purple" | "green" | "orange";

export type DockMode = "floating" | "full";

export type DockAlign = "system" | "center" | "left";

export interface DockConfig {
  version: 1;
  widgets: WidgetInstance[];
  /** Reserve a strip at the bottom of the screen so maximized windows stop above the dock. */
  reserveSpace: boolean;
  /** Floating dock with reserved space: paint the strip in the colour of the app in front. */
  stripFollowsApp: boolean;
  /** Hide the Windows taskbar while the dock runs (restored on exit). */
  hideNativeTaskbar: boolean;
  /** "floating": a centred pill above the screen edge. "full": a bar across the whole screen, like the Windows taskbar. */
  mode: DockMode;
  /** How app icons react to the pointer. */
  hoverEffect: HoverEffect;
  /** Strength of the hover effect, in % of the default (25–200). */
  hoverIntensity: number;
  /** Duration of the hover animation, in ms. */
  hoverSpeed: number;
  /** Colour of the glow effect: Windows' accent colour or a fixed one. */
  glowColor: GlowColor;
  /** Icons sink a little while pressed. */
  pressEffect: boolean;
  /** App, Start and tray icon size in % of the size that fits the bar height (70–130). */
  iconScale: number;
  /** Height of the bar in logical px (56–80): tiles and app icons scale with it. */
  barHeight: number;
  /** Opacity of the bar's background, 0.2–1; icons and widgets stay opaque. */
  opacity: number;
  /** Live window previews when the pointer rests on an app icon. */
  hoverPreview: boolean;
  /** Gap between the dock and the bottom of the screen, in logical px. */
  bottomMargin: number;
  /** Where Start and the apps sit: following Windows' own taskbar alignment, or fixed. */
  align: DockAlign;
  /** Corner radius of the floating dock, in logical px. */
  cornerRadius: number;
  /** Space between widgets, in logical px. */
  widgetGap: number;
  /** The strip's colour changes with the top-down gradient (off: at once). */
  colorTransition: boolean;
  /** The small pill under the icon of a running app. */
  runningIndicator: boolean;
  /** A faded copy behind the icon of an app with several windows. */
  stackedIcons: boolean;
  /** A click on an app with several windows: its window list, or straight to the last one used. */
  multiWindowClick: "list" | "recent";
  /** How long the pointer rests on an icon before its preview opens, in ms. */
  previewDelay: number;
  /** Start with Windows (HKCU Run key); mirrored from the registry at startup. */
  autostart: boolean;
  /** Download new versions on their own; they install when the user restarts the app. */
  autoUpdate: boolean;
}

export const configDir = appConfigDirectory("windows-bar");
const configPath = join(configDir, "config.json");

export const defaultConfig = (): DockConfig => ({
  version: 1,
  reserveSpace: true,
  hideNativeTaskbar: false,
  stripFollowsApp: true,
  mode: "floating",
  hoverPreview: true,
  opacity: 1,
  barHeight: 64,
  iconScale: 100,
  hoverEffect: "zoom",
  hoverIntensity: 100,
  hoverSpeed: 170,
  glowColor: "accent",
  pressEffect: true,
  bottomMargin: 8,
  align: "system",
  cornerRadius: 18,
  widgetGap: 6,
  colorTransition: true,
  runningIndicator: true,
  stackedIcons: true,
  multiWindowClick: "list",
  previewDelay: 450,
  autostart: false,
  autoUpdate: true,
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
