import { config } from "./config";
import { systemScale } from "./native/shell-icon";
import { taskbarPrefs } from "./services/taskbar-prefs";
/**
 * Visual tokens for the dock. Spacing runs on a 2 px grid: the dock pads its 52 px tiles by 6,
 * widgets sit 6 apart, app icons sit in 44 px slots (12 px between 32 px icons).
 * Values follow lumabar's dark dock: near-black, graphite tiles.
 */
export const BAR_HEIGHT_MIN = 40;
export const BAR_HEIGHT_MAX = 80;

/** config.barHeight, or (0, the default) the height of the Windows taskbar. */
function barHeight() {
  const h = Number(config.barHeight) || taskbarPrefs.height;
  return Math.max(BAR_HEIGHT_MIN, Math.min(BAR_HEIGHT_MAX, Math.round(h / 2) * 2));
}

/**
 * A logical length that lands on whole device pixels (even ones with `even`). Icons drawn at a
 * fractional size or position are resampled by the renderer and come out blurred; on scaled
 * screens (125 %, 150 %) most logical lengths do, so icon sizes and their offsets snap to this.
 */
export function devicePx(logical: number, even = false) {
  const scale = systemScale();
  const px = even ? Math.round((logical * scale) / 2) * 2 : Math.round(logical * scale);
  return px / scale;
}

export const ui = {
  dock: {
    // Opaque: a translucent fill gets a darker 1 px fringe where the renderer antialiases its edge.
    background: "#0c0c0e",
    /** 18 by default: tile radius + padding, so the corners run parallel. */
    get radius() {
      return Math.max(0, Math.min(32, Number(config.cornerRadius ?? 18)));
    },
    padding: 6,
    get gap() {
      return Math.max(0, Math.min(16, Number(config.widgetGap ?? 6)));
    },
    /** The user's bar height (config.barHeight); reading it re-renders on change. */
    get height() {
      return barHeight();
    },
  },
  tile: {
    background: "#1c1c1f",
    hover: "#252529",
    border: "rgba(255,255,255,0.05)",
    radius: 12,
    /**
     * Square controls inside a tile (album art, media buttons): the tile minus 5 px above and
     * below, at most 30, on even device pixels so they centre on whole pixels.
     */
    get control() {
      return devicePx(Math.min(30, this.height - 10), true);
    },
    /**
     * Two lines of text in a tile (clock, media, language), sized so both fit with room to spare:
     * the 48 px Windows-height bar gets the taskbar clock's 12 px lines.
     */
    get lines() {
      const compact = this.height < 44;
      return compact
        ? { primary: 12, secondary: 11, gap: 0, lineHeight: 1.2 }
        : { primary: 13, secondary: 12, gap: 2, lineHeight: 1.25 };
    },
    /** The bar minus its padding. */
    get height() {
      // Even device pixels, so an icon centred in the tile sits on whole pixels.
      return devicePx(barHeight() - 12, true);
    },
  },
  /** One slot per app icon (and the Start button): the icon sits centred, the indicator below it. */
  app: {
    /** 32 px in the default 64 px bar, scaled with the bar, on even pixels. */
    get icon() {
      const scale = Math.max(0.7, Math.min(1.3, Number(config.iconScale ?? 100) / 100));
      // Half the bar, as Windows draws 24 px icons on its 48 px taskbar.
      const base = barHeight() / 2;
      // Never taller than the tile minus room for the running indicator; even device pixels: the shell renders the icon at exactly that size and the GPU draws it 1:1.
      return devicePx(Math.max(16, Math.min(barHeight() - 22, base * scale)), true);
    },
    get slot() {
      // Even device pixels too, so the centred icon starts on a whole pixel.
      return devicePx(this.icon + 12, true);
    },
    /**
     * The square behind an app (in front, asking for attention, hovered): centred on the icon like
     * the Windows 11 taskbar button, as large as the slot allows. Even device pixels, so its edges
     * and the icon inside it land on whole pixels.
     */
    get plate() {
      // 4 px narrower than the slot, as Windows 11 draws its 40 px plate in a 44 px button:
      // neighbouring plates (in front + asking for attention) keep a gap instead of touching.
      return Math.min(this.slot - devicePx(4, true), ui.tile.height);
    },
  },
  text: "#f5f5f7",
  muted: "#8e8e93",
  faint: "#5a5a60",
  green: "#30d158",
  red: "#ff3b1f",
  blue: "#0a84ff",
  orange: "#d97757",
  track: "#2c2c30",
  danger: "#ff453a",
} as const;

/** The bar background at the user's opacity (the theme's #0c0c0e). */
export function dockBackground(opacity: number) {
  const a = Math.max(0.2, Math.min(1, opacity));
  return a >= 1 ? ui.dock.background : `rgba(12,12,14,${a.toFixed(2)})`;
}

/** `color` (rgb()/rgba()/#rrggbb) with its channels scaled by 1 - amount: 0.15 is 15% darker. */
export function darken(color: string, amount = 0.15) {
  const k = 1 - amount;
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(color);
  const parts = hex ? hex.slice(1).map((h) => parseInt(h, 16)) : rgb ? rgb[1]!.split(",").map((v) => parseFloat(v)) : null;
  if (!parts) return color;
  const [r, g, b, a] = parts as [number, number, number, number?];
  const c = (v: number) => Math.round(v * k);
  return a === undefined ? `rgb(${c(r)},${c(g)},${c(b)})` : `rgba(${c(r)},${c(g)},${c(b)},${a})`;
}

export const numeric = { fontVariantNumeric: "tabular-nums" } as const;
