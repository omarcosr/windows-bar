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

/**
 * config.barHeight, or (0, the default) the height of the Windows taskbar, less a floating dock's
 * strip margins when it reserves space. Off the bottom edge
 * the hidden taskbar keeps its strip reserved (Windows auto-hides it only at the bottom) and the
 * dock covers that strip, so there the bar is the taskbar's own thickness, less the strip margins.
 */
/** The height set in Settings (config.barHeight, or the taskbar's), margins included. */
export function configuredHeight() {
  return Math.max(BAR_HEIGHT_MIN, Math.min(BAR_HEIGHT_MAX, Math.round((Number(config.barHeight) || taskbarPrefs.height) / 2) * 2));
}

function barHeight() {
  const hidden = config.hideNativeTaskbar || config.mode === "full";
  if (taskbarPrefs.edge !== "bottom" && hidden) {
    const margins = config.mode === "floating" && config.reserveSpace ? 2 * (Number(config.bottomMargin) || 0) : 0;
    return Math.max(32, Math.min(BAR_HEIGHT_MAX, Math.floor((taskbarPrefs.height - margins) / 2) * 2));
  }
  const h = configuredHeight();
  // A floating dock's strip (the bar plus its margins) is as thick as a full bar: switching modes
  // then keeps the reserved strip, and a new work area holds the window manager for ~0.65 s.
  if (config.mode === "floating" && config.reserveSpace) return Math.max(32, h - 2 * (Number(config.bottomMargin) || 0));
  return h;
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

/** A side-edge column's padding across it, in logical px: its compact tiles get the room. */
export const COMPACT_PAD = 3;

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
    /** Hover on a joined tile (transparent on the shared card): the taskbar button's white wash. */
    hoverJoined: "rgba(255,255,255,0.06)",
    /** Side padding of a tile's content; `round` where it starts with a round icon or ring. */
    inset: { side: 10, round: 8 },
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

/**
 * The hover fill of a tile with its own colour: a little lighter on a dark colour, a little darker
 * on a light one, as the taskbar washes its buttons (white over dark, black over light).
 */
export function hoverShade(color: string) {
  // #rgb is #rrggbb with each digit doubled.
  const full = /^#[0-9a-f]{3}$/i.test(color) ? `#${[...color.slice(1)].map((d) => d + d).join("")}` : color;
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(full);
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(color);
  const parts = hex ? hex.slice(1).map((h) => parseInt(h, 16)) : rgb ? rgb[1]!.split(",").map((v) => parseFloat(v)) : null;
  if (!parts) return color;
  const [r, g, b, a] = parts as [number, number, number, number?];
  const light = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.6;
  const mix = (v: number) => Math.round(light ? v * 0.92 : v + (255 - v) * 0.07);
  return a === undefined ? `rgb(${mix(r)},${mix(g)},${mix(b)})` : `rgba(${mix(r)},${mix(g)},${mix(b)},${Math.min(1, a + 0.06)})`;
}

export const numeric = { fontVariantNumeric: "tabular-nums" } as const;
