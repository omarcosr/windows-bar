/**
 * Visual tokens for the dock. Spacing runs on a 2 px grid: the dock pads its 52 px tiles by 6,
 * widgets sit 6 apart, app icons sit in 44 px slots (12 px between 32 px icons).
 * Values follow lumabar's dark dock: near-black, graphite tiles.
 */
export const ui = {
  dock: {
    // Opaque: a translucent fill gets a darker 1 px fringe where the renderer antialiases its edge.
    background: "#0c0c0e",
    radius: 18, // tile radius + padding, so the corners run parallel
    padding: 6,
    gap: 6,
    height: 64,
  },
  tile: {
    background: "#1c1c1f",
    hover: "#252529",
    border: "rgba(255,255,255,0.05)",
    radius: 12,
    height: 52,
  },
  /** One slot per app icon (and the Start button): the icon sits centred, the indicator below it. */
  app: {
    slot: 44,
    icon: 32,
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
