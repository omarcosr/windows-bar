import { Circle, Image, Path, Polyline, Pressable, Row, Svg, SvgRect, Text, View, type Child, type DraggableProps, type DropTargetProps, type Style } from "@tarve/core";
import { Fragment } from "@tarve/core/jsx-runtime";
import { COMPACT_PAD, devicePx, hoverShade, numeric, ui } from "../theme";
import { config, type GlowColor, type HoverEffect } from "../config";
import { dockEdge, dockVertical, taskbarPrefs } from "../services/taskbar-prefs";
import { hideTip, hoverTip } from "../menu/hover-tip";
import { hidePeek } from "../menu/widget-peek";
import { fullForm } from "./form";
import { formatDatePicture } from "../native/locale-format";
import { tileDragProps } from "../dock/state";

/**
 * The graphite card every dock widget sits on. Its content is one row, centred vertically, padded
 * 10 px on both sides (8 px on the left when it starts with a round icon or ring: `lead="round"`).
 *
 * With `onClick` it answers the pointer like a Windows 11 taskbar button: a lighter fill on hover
 * (a lighter or darker shade of a tile's own colour), a small press, the hand cursor. Without one it
 * draws no hover at all (no affordance where a click does nothing). `tip` shows the dock's hover tip
 * (the taskbar's info popup) after a moment: the lines that explain what the numbers are.
 */
export function Tile(props: {
  width?: number;
  padding?: Style["padding"];
  /** "round": the tile starts with a round icon or ring, which sits 8 px from the edge. */
  lead?: "round";
  background?: string;
  gap?: number;
  onClick?: () => void;
  onContextMenu?: () => void;
  /** The hover tip: `id` unique in the dock (use the instance id), `lines` read while it shows. */
  tip?: { id: string; lines: () => string[] };
  /** The gallery preview: no tip. */
  preview?: boolean;
  /**
   * On a side edge: "full" keeps everything the tile shows, stacked (the taskbar's own items:
   * tray, status icons, clock, language); by default the tile is minimal (see minimalTree) and
   * the dock shows the whole widget beside it on hover (menu/widget-peek.tsx).
   */
  side?: "full";
  /** The minimal tile's icon (a tool's mark, see brand-icons.tsx) instead of the tile's first element. */
  icon?: Child;
  /** The data under the minimal tile's icon: the percentage, the count, the balance. */
  value?: string;
  valueColor?: string;
  style?: Style;
  children?: Child;
}) {
  // Joined widgets sit on one shared card (the dock draws it); a tile with its own colour keeps it.
  const joined = config.joinWidgets === true;
  // On a side edge the dock's own tiles take their compact form (see compactTile); the gallery's
  // previews and the hover peek keep the full one.
  const compact = compactView(!!props.preview);
  const minimal = compact && props.side !== "full";
  // A minimal tile's details are the peek; the peek itself shows no tips over it.
  const tip = props.preview || minimal || fullForm() ? undefined : props.tip;
  // A minimal tile with its own icon sits on the dock's tile colour (a white calendar page would hide it).
  const own_bg = minimal && props.icon ? undefined : props.background;
  const style: Style = compact ? compactTile(own_bg ?? (joined ? "rgba(0,0,0,0)" : ui.tile.background), joined, minimal) : {
    width: props.width,
    height: ui.tile.height,
    radius: ui.tile.radius,
    background: props.background ?? (joined ? "rgba(0,0,0,0)" : ui.tile.background),
    borderWidth: joined ? 0 : 1,
    borderColor: ui.tile.border,
    padding: props.padding ?? { left: props.lead === "round" ? ui.tile.inset.round : ui.tile.inset.side, right: ui.tile.inset.side },
    gap: props.gap ?? 8,
    direction: "row",
    align: "center",
    overflow: "hidden",
    // One line per text (inherited): a tile is a single row, and a label that wrapped to a second
    // line pushed the rows under it out of the tile ("demo" tags, reset times, model names).
    whiteSpace: "nowrap",
    shrink: 0,
  };
  // A widget's own sizes and padding are made for the row; the compact tile keeps its own.
  const own = compact ? withoutBox(props.style) : props.style;
  const children = minimal
    ? props.icon
      ? compactTree(
          <View style={{ align: "center", gap: 3 }}>
            {props.icon}
            {props.value ? (
              <Text size={11} weight={700} color={props.valueColor ?? ui.text} style={{ ...numeric, lineHeight: 1 }}>
                {props.value}
              </Text>
            ) : null}
          </View>,
        )
      : minimalTree(props.children)
    : compact
      ? compactTree(props.children)
      : props.children;
  const tipProps = tip
    ? {
        id: tip.id,
        onPointerMove: () => hoverTip(tip.id, tip.lines, true),
        onPointerLeave: () => hoverTip(tip.id, tip.lines, false),
      }
    : {};
  if (!props.onClick && !props.onContextMenu)
    return (
      <View {...tipProps} style={{ ...style, ...own }}>
        {children}
      </View>
    );
  const clickable = !!props.onClick;
  return (
    <Pressable
      {...tipProps}
      // In the dock the tile carries its widget when dragged, as the widget's slot does elsewhere.
      {...(!props.preview && !fullForm() ? tileDragProps() : {})}
      // Dock tiles never keep the keyboard, like taskbar buttons (Enter after a click must not re-press).
      focusable={false}
      onClick={
        props.onClick
          ? () => {
              hideTip();
              hidePeek();
              props.onClick!();
            }
          : undefined
      }
      onContextMenu={props.onContextMenu}
      style={{
        ...style,
        // The hand and the press feedback only where a left click does something.
        cursor: clickable ? "pointer" : "default",
        hover: clickable ? { background: props.background ? hoverShade(props.background) : joined ? ui.tile.hoverJoined : ui.tile.hover } : undefined,
        active: clickable ? { transform: "scale(0.97)" } : undefined,
        transition: { background: { duration: 140, easing: "easeOut" }, transform: { duration: 90, easing: "easeOut" } },
        // A widget's own hover/active (style) wins over the defaults above.
        ...own,
      }}
    >
      {children}
    </Pressable>
  );
}

/**
 * The compact tile of a dock on a side edge, the way Windows draws its vertical taskbar: as wide
 * as the bar's tiles, its content (icon, ring, the number) stacked and centred, as tall as it needs.
 * Text that is still wider is cut at the tile's edge.
 */
function compactTile(background: string, joined: boolean, minimal: boolean): Style {
  return {
    width: compactTileWidth(),
    // Minimal: a square, like the app icons' slots around it.
    ...(minimal ? { height: compactTileWidth() } : { minHeight: ui.tile.height }),
    radius: ui.tile.radius,
    background,
    borderWidth: joined ? 0 : 1,
    borderColor: ui.tile.border,
    padding: { top: 6, bottom: 6, left: 2, right: 2 },
    gap: 3,
    direction: "column",
    align: "center",
    justify: "center",
    overflow: "hidden",
    whiteSpace: "nowrap",
    shrink: 0,
  };
}

/**
 * The tile's content for the compact tile, rewritten before it renders (elements are plain
 * { type, props } until then): Lines, Meter and Sparkline get `compact` (the value alone; tracks
 * and charts no wider than the tile); rows become centred columns, so what sat side by side
 * stacks; a box wider than the tile narrows to it; text ends in an ellipsis at the tile's edge
 * instead of being cut through a letter. Components a widget defines itself are left as they are.
 */
function compactTree(node: Child): Child {
  if (Array.isArray(node)) return node.map((n) => compactTree(n as Child)) as Child;
  if (!node || typeof node !== "object" || !("type" in node)) return node;
  const vnode = node as { type: unknown; props: Record<string, unknown>; key?: unknown };
  const props = vnode.props ?? {};
  const kids = props.children === undefined ? undefined : compactTree(props.children as Child);
  const next: Record<string, unknown> = { ...props, ...(kids !== undefined ? { children: kids } : {}) };
  let type = vnode.type;
  const room = compactWidth();
  const style = (props.style ?? {}) as Style;
  if (type === Lines || type === Meter || type === Sparkline) next.compact = true;
  else if (type === Text) {
    next.style = { ...style, maxWidth: room, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "center" };
    // Smaller type where the text would not fit the tile (about 0.58 em per character), down
    // to 8 px; past that it ends in an ellipsis.
    const text = typeof props.children === "string" || typeof props.children === "number" ? String(props.children) : null;
    const size = typeof props.size === "number" ? props.size : 13;
    const fit = text ? Math.floor(room / (Math.max(1, text.length) * 0.58)) : size;
    const capped = size > 13 ? Math.max(13, Math.min(size, Math.round(room * 0.4))) : size;
    if (Math.min(capped, fit) !== size) next.size = Math.max(8, Math.min(capped, fit));
  } else if (type === Row || type === View || type === Pressable) {
    const row = type === Row || style.direction === "row";
    const wide = typeof style.width === "number" && style.width > room;
    if (row || wide) {
      if (type === Row) type = View;
      next.style = {
        ...style,
        ...(row ? { direction: "column", align: "center", gap: Math.min(2, Number(style.gap ?? 2)) } : {}),
        ...(wide ? { width: room } : {}),
      };
    }
  }
  return { ...vnode, type, props: next } as unknown as Child;
}

/**
 * The minimal tile of a side-edge dock: its first element alone (the icon, ring, badge or the
 * time), in its compact form; the rest is in the hover peek.
 */
function minimalTree(node: Child): Child {
  const first = (n: Child): Child => {
    if (Array.isArray(n)) {
      for (const item of n) {
        const hit = first(item as Child);
        if (hit !== null && hit !== undefined && hit !== false) return hit;
      }
      return null;
    }
    if (n === null || n === undefined || n === false || n === true || n === "") return null;
    if (typeof n === "object" && "type" in n && ((n as { type: unknown }).type === Fragment || (n as { type: unknown }).type === "fragment")) return first((n as { props: { children?: Child } }).props.children);
    // A row lays things side by side (art, then title and artist): its first one is the essential.
    // A column (the time over the date) stays whole.
    if (typeof n === "object" && "type" in n) {
      const v = n as { type: unknown; props: { style?: Style; children?: Child } };
      if (v.type === Row || ((v.type === View || v.type === Pressable) && v.props.style?.direction === "row")) {
        const inner = first(v.props.children);
        // A pressable row keeps its press (the media tile's click) around the one element.
        if (inner !== null) return v.type === Pressable ? ({ ...v, props: { ...v.props, children: inner } } as unknown as Child) : inner;
      }
    }
    return n;
  };
  return compactTree(first(node));
}

/** A widget's style without the box it sets for the row (size, padding, direction). */
function withoutBox(style: Style | undefined): Style | undefined {
  if (!style) return style;
  const { width: _w, height: _h, minWidth: _mw, padding: _p, direction: _d, gap: _g, ...rest } = style as Style & Record<string, unknown>;
  return rest as Style;
}

/**
 * A calendar's mark for the minimal tile of a side-edge dock: the weekday over the day of the
 * month, in Windows' own weekday abbreviation.
 */
export function DayMark(props: { now?: Date }) {
  const now = props.now ?? new Date();
  return (
    <View style={{ align: "center", gap: 0 }}>
      <Text size={9} weight={700} color={ui.red} style={{ lineHeight: 1.1, textTransform: "uppercase" }}>
        {formatDatePicture(now, "ddd").replace(/\.$/, "")}
      </Text>
      <Text size={16} weight={700} color={ui.text} style={{ ...numeric, lineHeight: 1.1 }}>
        {String(now.getDate())}
      </Text>
    </View>
  );
}

/**
 * Whether a widget draws its compact form: in the dock (not a gallery preview) on a side edge,
 * where its tile is as wide as the bar's tiles. Widgets show the essential there: icon and number.
 */
export function compactView(preview: boolean) {
  return !preview && !fullForm() && dockVertical();
}

/**
 * A compact tile's width: the side-edge bar less 3 px each side (the column's padding, see
 * Dock.tsx), so the time and numbers get the room Windows gives them on its 60 px vertical taskbar.
 */
export function compactTileWidth() {
  return ui.dock.height - 2 * COMPACT_PAD;
}

export { COMPACT_PAD };

/** Room inside a compact tile (see compactTile), for text, meters and charts. */
export function compactWidth() {
  return compactTileWidth() - 6;
}

/**
 * A slot's box from its length along the dock and its thickness across it: width x height in a
 * row, the other way round in the column of a side-edge dock.
 */
export function axisBox(along: number, across: number): { width: number; height: number } {
  return dockVertical() ? { width: across, height: along } : { width: along, height: across };
}

/**
 * Two text lines of a metric (label above, value below, or the reverse with `valueFirst`), on the
 * bar's line metrics (ui.tile.lines) so both always fit the tile from 40 to 80 px; numbers use
 * tabular figures so they do not jitter as they tick.
 */
export function Lines(props: {
  label: Child;
  value: Child;
  valueColor?: string;
  labelColor?: string;
  valueFirst?: boolean;
  align?: "start" | "end" | "center";
  width?: number;
  flex?: number;
  /** In a compact tile (set by Tile, see compactTree). */
  compact?: boolean;
}) {
  const l = ui.tile.lines;
  // The compact tile of a side-edge dock shows the essential: the value alone, centred.
  if (props.compact) {
    return (
      <Text size={l.secondary} weight={650} color={props.valueColor ?? ui.text} style={{ ...numeric, lineHeight: l.lineHeight }}>
        {props.value}
      </Text>
    );
  }
  const label = (
    <Text size={l.secondary} weight={500} color={props.labelColor ?? ui.muted} style={{ ...numeric, lineHeight: l.lineHeight }}>
      {props.label}
    </Text>
  );
  const value = (
    <Text size={l.primary} weight={650} color={props.valueColor ?? ui.text} style={{ ...numeric, lineHeight: l.lineHeight }}>
      {props.value}
    </Text>
  );
  return (
    <View
      style={{
        direction: "column",
        gap: l.gap,
        justify: "center",
        align: props.align ?? "start",
        width: props.width,
        flex: props.flex,
        minWidth: 0,
        shrink: props.width ? 0 : 1,
      }}
    >
      {props.valueFirst ? value : label}
      {props.valueFirst ? label : value}
    </View>
  );
}

/** A line chart scaled into width x height with a dot on the latest value. */
export function Sparkline(props: { values: readonly number[]; width: number; height: number; color: string; compact?: boolean }) {
  const { values, height, color } = props;
  const width = props.compact ? Math.min(props.width, compactWidth()) : props.width;
  if (values.length < 2) return <View style={{ width, height }} />;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pad = 3;
  const pts = values.map((v, i) => {
    const x = pad + (i / (values.length - 1)) * (width - pad * 2);
    const y = pad + (1 - (v - min) / span) * (height - pad * 2);
    return [x, y] as const;
  });
  const last = pts[pts.length - 1]!;
  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `M ${pts[0]![0]} ${height} L ${pts.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(" L ")} L ${last[0]} ${height} Z`;
  return (
    <Svg width={width} height={height} viewBox={[0, 0, width, height]}>
      <Path d={area} fill={color} fill-opacity={0.14} stroke="none" />
      <Polyline points={line} fill="none" stroke={color} stroke-width={1.8} stroke-linejoin="round" stroke-linecap="round" />
      <Circle cx={last[0]} cy={last[1]} r={2.6} fill={color} stroke="none" />
    </Svg>
  );
}

/** A thin rounded progress track. */
export function Meter(props: { value: number; width: number; color?: string; height?: number; compact?: boolean }) {
  const h = props.height ?? 5;
  const width = props.compact ? Math.min(props.width, compactWidth()) : props.width;
  const fill = Math.max(0, Math.min(1, props.value)) * width;
  return (
    <View style={{ width, height: h, radius: h / 2, background: ui.track, overflow: "hidden", shrink: 0 }}>
      <View
        style={{
          width: Math.max(fill, h),
          height: h,
          radius: h / 2,
          background: props.color ?? ui.green,
          transition: { width: { duration: 400, easing: "easeOut" } },
        }}
      />
    </View>
  );
}

/** Round icon button used by media controls. */
export function RoundButton(props: { size?: number; background?: string; onClick: () => void; children: Child }) {
  const size = props.size ?? ui.tile.control;
  const bg = props.background ?? "#2a2a2e";
  return (
    <Pressable
      onClick={props.onClick}
      style={{
        width: size,
        height: size,
        radius: size / 2,
        background: bg,
        align: "center",
        justify: "center",
        cursor: "pointer",
        shrink: 0,
        hover: { transform: "scale(1.06)" },
        active: { transform: "scale(0.92)" },
      }}
    >
      {props.children}
    </Pressable>
  );
}

export const glyphs = {
  play: (size: number, color = "#fff") => (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.6-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z" fill={color} stroke="none" />
    </Svg>
  ),
  pause: (size: number, color = "#fff") => (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <SvgRect x={6} y={5} width={4} height={14} rx={1.2} fill={color} stroke="none" />
      <SvgRect x={14} y={5} width={4} height={14} rx={1.2} fill={color} stroke="none" />
    </Svg>
  ),
  next: (size: number, color = "#fff") => (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d="M5 6.2v11.6a.8.8 0 0 0 1.2.7l8.6-5.8a.8.8 0 0 0 0-1.4L6.2 5.5a.8.8 0 0 0-1.2.7Z" fill={color} stroke="none" />
      <SvgRect x={16.5} y={5.5} width={2.6} height={13} rx={1} fill={color} stroke="none" />
    </Svg>
  ),
  previous: (size: number, color = "#fff") => (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d="M19 6.2v11.6a.8.8 0 0 1-1.2.7L9.2 12.7a.8.8 0 0 1 0-1.4l8.6-5.8a.8.8 0 0 1 1.2.7Z" fill={color} stroke="none" />
      <SvgRect x={4.9} y={5.5} width={2.6} height={13} rx={1} fill={color} stroke="none" />
    </Svg>
  ),
};

/**
 * Four rounded squares, silver on graphite, like the lumabar start tile. With `gradient` (top-left to
 * bottom-right) one gradient runs across all four, as on the Windows 11 Start button; that one is
 * drawn as SVG bytes, since the Svg nodes take only plain fills.
 */
export function WindowsLogo(props: { size: number; color?: string; gradient?: readonly [string, string] }) {
  const s = props.size;
  const fill = props.color ?? "#e9e9ee";
  const q = s * 0.44;
  const g = s - q * 2;
  if (props.gradient) {
    const [from, to] = props.gradient;
    const rect = (x: number, y: number) => `<rect x="${x}" y="${y}" width="${q}" height="${q}" rx="${s * 0.05}" fill="url(#g)"/>`;
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">` +
      `<defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="${s}" y2="${s}"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs>` +
      rect(0, 0) + rect(q + g, 0) + rect(0, q + g) + rect(q + g, q + g) +
      "</svg>";
    return <Image src={{ bytes: new TextEncoder().encode(svg), mediaType: "image/svg+xml", cacheKey: `winlogo:${s}:${from}:${to}` }} width={s} height={s} fit="fill" style={{ radius: 0 }} />;
  }
  const square = (x: number, y: number) => <SvgRect x={x} y={y} width={q} height={q} rx={s * 0.05} fill={fill} stroke="none" />;
  return (
    <Svg width={s} height={s} viewBox={[0, 0, s, s]}>
      {square(0, 0)}
      {square(q + g, 0)}
      {square(0, q + g)}
      {square(q + g, q + g)}
    </Svg>
  );
}

export function Dot(props: { color: string; size?: number; width?: number }) {
  const size = props.size ?? 4;
  return (
    <View
      style={{
        width: props.width ?? size,
        height: size,
        radius: size / 2,
        background: props.color,
        transition: { width: { duration: 180, easing: "easeOut" } },
      }}
    />
  );
}

export function Spacer() {
  return <Row style={{ flex: 1 }} />;
}

export const hoverEffects: { value: HoverEffect; label: string }[] = [
  { value: "zoom", label: "Ampliar" },
  { value: "macos", label: "macOS" },
  { value: "lift", label: "Elevar" },
  { value: "glow", label: "Brilho" },
  { value: "highlight", label: "Realce do Windows" },
  { value: "none", label: "Nenhum" },
];

/**
 * The hover and press styles of a dock icon (apps, Start, tray), after config.hoverEffect:
 * zoom grows the icon a little, lift raises it, glow lights it in the accent colour, highlight
 * only tints its slot. Animated both ways.
 */
export const glowColors: { value: GlowColor; label: string; color: string | null }[] = [
  { value: "accent", label: "Destaque do Windows", color: null },
  { value: "white", label: "Branco", color: "#ffffff" },
  { value: "blue", label: "Azul", color: "#0a84ff" },
  { value: "purple", label: "Roxo", color: "#bf5af2" },
  { value: "green", label: "Verde", color: "#30d158" },
  { value: "orange", label: "Laranja", color: "#ff9f0a" },
];

export function glowColor(): string {
  return glowColors.find((g) => g.value === config.glowColor)?.color ?? taskbarPrefs.accent;
}

/** Two-digit hex alpha for 0..1. */
const alpha = (a: number) =>
  Math.round(Math.max(0, Math.min(1, a)) * 255)
    .toString(16)
    .padStart(2, "0");

/**
 * The taskbar's buttons answer over the bar's whole height (Fitts's law: the pointer pushed against
 * the screen's bottom edge still hits the icon). A button in the dock is the tile's height, inside
 * the bar's padding: this transparent child reaches from the bar's top to its bottom edge and takes
 * the same press, right-click and hover. Place it as the button's first child (`position:
 * "relative"` button); `height` is the button's own height.
 */
export function HitReach(props: {
  height: number;
  onClick?: () => void;
  onContextMenu?: () => void;
  onHover?: (hovered: boolean) => void;
  /**
   * The button's drag-and-drop props: the press lands on this child, and a drag only starts from
   * the pressed node (and drops reach the innermost target), so a draggable button passes them here too.
   */
  drag?: DraggableProps & DropTargetProps;
}) {
  const reach = Math.max(0, (ui.dock.height - props.height) / 2);
  if (!reach) return null;
  // Across the bar: up and down in a row, left and right in the column of a side-edge dock.
  const box = dockVertical() ? { left: -reach, right: -reach, top: 0, bottom: 0 } : { top: -reach, bottom: -reach, left: 0, right: 0 };
  return (
    <Pressable
      aria-hidden
      focusable={false}
      onClick={props.onClick}
      onContextMenu={props.onContextMenu}
      onHover={props.onHover}
      {...props.drag}
      style={{ position: "absolute", ...box, cursor: "pointer" }}
    />
  );
}

/**
 * `magnified`: the icon sits in a magnifying row (Start and the apps), which draws the "macos"
 * effect itself; elsewhere (tray) "macos" falls back to a plain zoom.
 */
/**
 * The Windows 11 taskbar button's hover: a faint plate with a hairline edge, faded in. Drawn as
 * its own node behind the icon (`plate` box), shown when the pointer is over the button: the
 * button must be a `group`.
 */
export function windowsHoverPlate(): Style {
  const k = Math.max(0.25, Math.min(2, Number(config.hoverIntensity ?? 100) / 100));
  const ms = Math.max(0, Math.min(600, Number(config.hoverSpeed ?? 120)));
  const white = (a: number) => `rgba(255,255,255,${Math.min(0.3, a * k).toFixed(3)})`;
  return {
    background: "rgba(255,255,255,0)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0)",
    transition: { background: { duration: ms, easing: "easeOut" }, borderColor: { duration: ms, easing: "easeOut" } },
    groupHover: { background: white(0.06), borderColor: white(0.04) },
  };
}

/** "highlight" draws the Windows 11 plate: buttons that have one (apps, Start) draw it themselves. */
export const windowsHighlight = () => config.hoverEffect === "highlight";

export function iconHover(options?: { magnified?: boolean; plate?: boolean }): Style {
  const effect = config.hoverEffect ?? "zoom";
  // 1 is the default look; the slider goes from a quarter to twice as strong.
  const k = Math.max(0.25, Math.min(2, Number(config.hoverIntensity ?? 100) / 100));
  const ms = Math.max(0, Math.min(600, Number(config.hoverSpeed ?? 170)));
  const transition: Style["transition"] = {
    transform: { duration: ms, easing: "easeOut" },
    background: { duration: ms, easing: "easeOut" },
    boxShadow: { duration: Math.round(ms * 1.2), easing: "easeOut" },
  };
  const active = config.pressEffect === false ? undefined : { transform: "scale(0.9)" };
  const px = (n: number) => Math.round(n * k * 10) / 10;
  // Away from the screen edge the dock sits on: up from the bottom, right from the left edge…
  const inward = (n: number) => ({ bottom: `translateY(-${n}px)`, top: `translateY(${n}px)`, left: `translateX(${n}px)`, right: `translateX(-${n}px)` })[dockEdge()];
  if (effect === "macos" && options?.magnified) return { active };
  if (effect === "highlight" && options?.plate) return { active };
  switch (effect) {
    case "macos":
    case "zoom":
      return { transition, hover: { transform: `${inward(px(2))} scale(${(1 + 0.14 * k).toFixed(3)})` }, active };
    case "lift":
      return {
        transition,
        hover: {
          transform: inward(px(4)),
          background: `rgba(255,255,255,${(0.05 * k).toFixed(3)})`,
          boxShadow: { y: px(6), blur: px(12), color: `#000000${alpha(0.5 * k)}` },
        },
        active,
      };
    case "glow":
      return {
        transition,
        hover: {
          background: `rgba(255,255,255,${(0.08 * Math.min(k, 1.5)).toFixed(3)})`,
          boxShadow: { blur: px(16), spread: -2, color: `${glowColor()}${alpha(0.53 * Math.min(k, 1.8))}` },
        },
        active,
      };
    case "highlight":
      // Buttons without a plate of their own: the Windows 11 plate's tint over the whole button.
      return { transition, radius: devicePx(8), hover: { background: `rgba(255,255,255,${Math.min(0.2, 0.06 * k).toFixed(3)})` }, active };
    default:
      return { active };
  }
}
