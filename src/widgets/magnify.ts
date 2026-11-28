import { store, type Style } from "@tarve/core";
import { config, reservesSpace, type WidgetInstance } from "../config";
import { dockEdge, dockVertical, taskbarPrefs } from "../services/taskbar-prefs";
import { COMPACT_PAD, ui } from "../theme";
import { cursorPos, topWindowAt } from "../native/win32";
import { onShellEvent, watchPointerLeave } from "../native/shell-events";

/**
 * The macOS Dock magnification ("macos" hover effect): the icons near the pointer grow along a
 * bell curve centred on it, and their slots widen so the neighbours make room. Everything is
 * computed from the pointer's position in the row's *unmagnified* layout, so the layout is a pure
 * function of where the pointer is and never chases itself.
 */
export type MagnifyRowId = "dock" | "preview";

/** Pointer position over each row, in unmagnified px from its first slot; null while outside. */
const pointer = store({ dock: null as number | null, preview: null as number | null });
const enteredAt: Record<MagnifyRowId, number> = { dock: 0, preview: 0 };
const widths: Partial<Record<MagnifyRowId, number>> = {};
const watchers: Partial<Record<MagnifyRowId, () => void>> = {};

function release(id: MagnifyRowId) {
  watchers[id]?.();
  delete watchers[id];
  if (pointer[id] !== null) pointer[id] = null;
}

/**
 * A pointer that leaves the window fast (off the screen edge, onto another window) may not
 * deliver the row's hover-out, which would leave the icons magnified. While a row is magnified,
 * the shell-events worker follows the cursor (EVENT_OBJECT_LOCATIONCHANGE on OBJID_CURSOR, hooked
 * only meanwhile): once it is over another window, the row lets go.
 */
function watch(id: MagnifyRowId) {
  if (watchers[id]) return;
  const p = cursorPos();
  const owner = Number(topWindowAt(p.x, p.y) ?? 0);
  if (!owner) return;
  const stop = watchPointerLeave(owner);
  const off = onShellEvent((event) => {
    if (event.type === "pointerLeft" && event.owner === owner) release(id);
  });
  watchers[id] = () => {
    off();
    stop();
  };
}

/** Geometry of one magnifying row. */
export interface MagnifyMetrics {
  /** Base slot width (all slots equal, no gap). */
  slot: number;
  /** Base icon size. */
  icon: number;
  /** Height of the slot the icon is centred in. */
  height: number;
  /** Room above the slot the icon may grow into before the window clips it. */
  headroom: number;
}

export interface MagnifyRow {
  count: number;
  slot: number;
  /** Padding before the first slot, inside the measured box. */
  inset: number;
  /** How the row grows: 0 keeps its left edge, 0.5 grows on both sides (centred), 1 keeps its right edge. */
  anchor: number;
}

export const magnifying = () => config.hoverEffect === "macos";

/** The dock row runs down a column on a side edge: the effect works along y and grows across x. */
const columnRow = (id: MagnifyRowId) => id === "dock" && dockVertical();

/** Radius of the bell, in slots: like the Dock, about three icons each side react. */
const RANGE = 3;

function speed() {
  return Math.max(0, Math.min(600, Number(config.hoverSpeed ?? 170)));
}

/** Peak scale: from the intensity slider, but never taller than the window can show. */
function maxScale(m: MagnifyMetrics) {
  const k = Math.max(0.25, Math.min(2, Number(config.hoverIntensity ?? 100) / 100));
  const wanted = 1 + 0.6 * k;
  // The icon grows up from its bottom edge, which stays put.
  // 2 px spare against rounding on scaled screens.
  const cap = ((m.height + m.icon) / 2 + m.headroom - 2) / m.icon;
  return Math.max(1, Math.min(wanted, cap));
}

/** Icon size at the peak of the bell, in px. */
export function peakSize(m: MagnifyMetrics) {
  return Math.ceil(m.icon * maxScale(m));
}

/** Props for the row: tracks the pointer while it is over the row. */
export function magnifyRowProps(id: MagnifyRowId, row: () => MagnifyRow, onResize?: () => void) {
  return {
    onSize: ({ borderBox }: { borderBox: { width: number; height: number } }) => {
      // The row's length along the dock.
      widths[id] = columnRow(id) ? borderBox.height : borderBox.width;
      onResize?.();
    },
    onPointerMove: (point: { x: number; y: number }) => {
      const x = columnRow(id) ? point.y : point.x;
      const r = row();
      const base = r.count * r.slot;
      // What the magnification added to the row; with a centred row half of it lies left of the
      // first slot, so the unmagnified position stays where it is on screen.
      const extra = Math.max(0, (widths[id] ?? base + 2 * r.inset) - 2 * r.inset - base);
      const u = Math.max(-r.slot, Math.min(base + r.slot, x - r.inset - r.anchor * extra));
      if (pointer[id] === null) enteredAt[id] = Date.now();
      pointer[id] = u;
      watch(id);
    },
    onHover: (inside: boolean) => {
      if (!inside) release(id);
    },
  };
}

/** The bell: scale of slot `index` with the pointer at unmagnified position `u`. */
function bell(u: number, index: number, m: MagnifyMetrics, peak: number) {
  const d = Math.abs(u - (index + 0.5) * m.slot);
  const range = RANGE * m.slot;
  if (d >= range) return 1;
  return 1 + (peak - 1) * ((1 + Math.cos((Math.PI * d) / range)) / 2);
}

/** Scale of the icon in slot `index` (0-based) for the current pointer. */
export function magnifyScale(id: MagnifyRowId, index: number, m: MagnifyMetrics) {
  const u = pointer[id];
  if (u === null || !magnifying()) return 1;
  return bell(u, index, m, maxScale(m));
}

/** The most width `count` slots can gain, wherever the pointer is. */
export function maxExtra(count: number, m: MagnifyMetrics) {
  if (!magnifying() || count <= 0) return 0;
  const peak = maxScale(m);
  // Asked several times per render (window room, app slots, reportSize) with the same inputs;
  // the scan is O(8·count²) cosines, so the last answers are kept.
  const key = `${count}|${m.slot}|${peak}`;
  const known = extraCache.get(key);
  if (known !== undefined) return known;
  let most = 0;
  for (let u = 0; u <= count * m.slot; u += m.slot / 8) {
    let extra = 0;
    for (let i = 0; i < count; i++) extra += m.slot * (bell(u, i, m, peak) - 1);
    most = Math.max(most, extra);
  }
  if (extraCache.size > 64) extraCache.clear();
  extraCache.set(key, Math.ceil(most));
  return Math.ceil(most);
}

const extraCache = new Map<string, number>();

/** Width the magnification adds to a row right now (as laid out, transitions included). */
export function currentExtra(id: MagnifyRowId, count: number, slot: number, inset = 0) {
  const w = widths[id];
  return w === undefined ? 0 : Math.max(0, w - 2 * inset - count * slot);
}

/**
 * Styles of one magnified icon. Sizes go through layout, not `transform`: an Image under a
 * transformed node is clipped to its untransformed box, which cut the top off the grown icons.
 */
export interface Magnified {
  /** On the slot: its width grows with the icon, pushing the neighbours aside. */
  slot: Style;
  /** An absolute box in the slot holding the icon: bottom edge fixed, grows upward, centred. */
  box: Style;
  /** On the icon (Image or View) inside `box`: its animated width and height. */
  icon: Style;
  size: number;
  /** Half the width the slot gained, to keep slot decorations at their own size. */
  grow: number;
  /** A slot-sized absolute box that follows the icon's top-right corner, for the badge. */
  corner: Style;
}

/** Styles for the icon in slot `index` (0-based), magnified for the current pointer. */
export function magnifyStyles(id: MagnifyRowId, index: number, m: MagnifyMetrics): Magnified {
  const s = magnifyScale(id, index, m);
  const ms = speed();
  // Entering and leaving ease in the configured time; while the pointer moves the icons follow it
  // closely, as on macOS.
  const following = pointer[id] !== null && Date.now() - enteredAt[id] > ms;
  const duration = following ? Math.min(ms, 60) : ms;
  const t = { duration, easing: "easeOut" as const };
  const size = Math.round(m.icon * s * 10) / 10;
  const grow = (m.slot * (s - 1)) / 2;
  const rise = size - m.icon;
  if (columnRow(id)) {
    // Down a side-edge column: the slot grows in height, the icon grows away from the screen edge
    // (its outer side stays put, as its bottom does in a row), centred along the column.
    const right = dockEdge() === "right";
    const outer = (m.height - m.icon) / 2;
    const along = Math.round(m.slot * s * 10) / 10;
    return {
      slot: { height: along, transition: { height: t } },
      box: { position: "absolute", top: 0, bottom: 0, [right ? "right" : "left"]: outer, width: size, justify: "center", transition: { width: t } },
      icon: { width: size, height: size, transition: { width: t, height: t } },
      size,
      grow,
      // The badge follows the icon's top-right corner.
      corner: { position: "absolute", top: (along - size) / 2 - (m.slot - m.icon) / 2, left: right ? 0 : rise, width: m.height, height: m.slot, transition: { top: t, left: t } },
    };
  }
  return {
    slot: { width: Math.round(m.slot * s * 10) / 10, transition: { width: t } },
    box: {
      position: "absolute",
      left: 0,
      right: 0,
      bottom: (m.height - m.icon) / 2,
      height: size,
      align: "center",
      transition: { height: t },
    },
    icon: { width: size, height: size, transition: { width: t, height: t } },
    size,
    grow,
    corner: { position: "absolute", top: -rise, left: grow + rise / 2, width: m.slot, height: m.height, transition: { top: t, left: t } },
  };
}

/* The dock's Start + Apps group, in config order. Apps widgets report how many icons they show. */
const appCounts = new Map<string, number>();

export function setAppCount(instanceId: string, count: number) {
  appCounts.set(instanceId, count);
}

const groupCore = (type: string) => type === "start" || type === "apps";

/** Search box sizes, in app slots, so the group's slots stay equal for the magnification. */
export const SEARCH_TYPE = "launcher-search";
export type SearchLook = "system" | "hidden" | "icon" | "label" | "normal" | "wide";

/** The look a search widget draws: "system" follows Windows' taskbar Search setting. */
export function searchLook(look: string): Exclude<SearchLook, "system"> {
  if (look !== "system") return (["hidden", "icon", "label", "normal", "wide"].includes(look) ? look : "normal") as Exclude<SearchLook, "system">;
  return (["hidden", "icon", "normal", "label"] as const)[taskbarPrefs.search];
}

export function searchSlots(look: string) {
  return { hidden: 0, icon: 1, label: 2, normal: 4, wide: 5 }[searchLook(look)];
}

/**
 * Whether a widget sits in the Start + Apps group. Search joins it when placed right next to
 * Start or Apps, as the taskbar's Search sits between Start and the app buttons.
 */
export function inDockGroup(id: string, list: readonly WidgetInstance[] = config.widgets) {
  const i = list.findIndex((w) => w.id === id);
  const w = list[i];
  if (!w) return false;
  if (groupCore(w.type)) return true;
  if (w.type !== SEARCH_TYPE) return false;
  return groupCore(list[i - 1]?.type ?? "") || groupCore(list[i + 1]?.type ?? "");
}

function slotsOf(w: WidgetInstance) {
  if (w.type === "start") return 1;
  if (w.type === "apps") return appCounts.get(w.id) ?? 0;
  if (w.type === SEARCH_TYPE && inDockGroup(w.id)) return searchSlots(String((w.config as { width?: string }).width ?? "system"));
  return 0;
}

/**
 * Room for the Start + Apps group. Like the taskbar, app icons that do not fit go behind a "•••"
 * button instead of running under the other widgets: the dock measures the other widgets and the
 * screen, and each apps widget takes the slots left, in order.
 */
export const dockRoom = store({
  /** Logical width of the dock's monitor (0 until known). */
  screen: 0,
  /** Measured widths of the widgets outside the group. */
  widths: {} as Record<string, number>,
  /** App slots the group has room for. */
  appSlots: Infinity,
});

export function noteSlotWidth(id: string, width: number) {
  if (Math.abs((dockRoom.widths[id] ?? -1) - width) > 0.5) dockRoom.widths = { ...dockRoom.widths, [id]: width };
}

/** Slots the group spends on Start and Search (everything but app icons). */
export function fixedGroupSlots() {
  let n = 0;
  for (const w of config.widgets) if (w.type !== "apps") n += slotsOf(w);
  return n;
}

const appWanted = new Map<string, number>();

/** How many icon slots apps widget `id` may use when it has `wanted` icons. */
export function appRoom(id: string, wanted: number) {
  appWanted.set(id, wanted);
  let left = dockRoom.appSlots;
  for (const w of config.widgets) {
    if (w.type !== "apps") continue;
    if (w.id === id) break;
    left -= appWanted.get(w.id) ?? 0;
  }
  return Math.max(1, left);
}

/** Index of `local` (an icon of widget `instanceId`) across the whole group. */
export function dockIndex(instanceId: string, local: number) {
  let index = 0;
  for (const w of config.widgets) {
    if (w.id === instanceId) return index + local;
    index += slotsOf(w);
  }
  return index + local;
}

/** The dock's slots: the icon may grow over the dock padding and, in the strip, its margin. */
export function dockMetrics(): MagnifyMetrics {
  const strip = reservesSpace() && config.mode !== "full" ? Number(config.bottomMargin) || 0 : 0;
  // Across a side-edge column the bar pads its tiles by COMPACT_PAD only.
  return { slot: ui.app.slot, icon: ui.app.icon, height: ui.tile.height, headroom: (dockVertical() ? COMPACT_PAD : ui.dock.padding) + strip };
}

export function dockCount() {
    let n = 0;
    for (const w of config.widgets) n += slotsOf(w);
    return n;
}
