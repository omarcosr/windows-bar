import { Circle, Path, Polyline, Pressable, Row, Svg, SvgRect, View, type Child, type Style } from "@tarve/core";
import { ui } from "../theme";
import { config, type GlowColor, type HoverEffect } from "../config";
import { taskbarPrefs } from "../services/taskbar-prefs";
import { hideTip } from "../menu/hover-tip";

/** The graphite card every dock widget sits on. */
export function Tile(props: {
  width?: number;
  padding?: Style["padding"];
  background?: string;
  gap?: number;
  onClick?: () => void;
  onContextMenu?: () => void;
  style?: Style;
  children?: Child;
}) {
  // Joined widgets sit on one shared card (the dock draws it); a tile with its own colour keeps it.
  const joined = config.joinWidgets === true;
  const style: Style = {
    width: props.width,
    height: ui.tile.height,
    radius: ui.tile.radius,
    background: props.background ?? (joined ? "rgba(0,0,0,0)" : ui.tile.background),
    borderWidth: joined ? 0 : 1,
    borderColor: ui.tile.border,
    // Content is centred vertically by the row; the tile only pads the sides.
    padding: props.padding ?? { left: 8, right: 8 },
    gap: props.gap ?? 8,
    direction: "row",
    align: "center",
    overflow: "hidden",
    shrink: 0,
    ...props.style,
  };
  if (!props.onClick && !props.onContextMenu) return <View style={style}>{props.children}</View>;
  return (
    <Pressable
      onClick={
        props.onClick
          ? () => {
              hideTip();
              props.onClick!();
            }
          : undefined
      }
      onContextMenu={props.onContextMenu}
      style={{
        ...style,
        // The hand and the press feedback only where a left click does something.
        cursor: props.onClick ? "pointer" : "default",
        hover: props.onClick ? { background: props.background ?? ui.tile.hover } : undefined,
        active: props.onClick ? { transform: "scale(0.97)" } : undefined,
        transition: { background: { duration: 140, easing: "easeOut" } },
      }}
    >
      {props.children}
    </Pressable>
  );
}

/** A line chart scaled into width x height with a dot on the latest value. */
export function Sparkline(props: { values: readonly number[]; width: number; height: number; color: string }) {
  const { values, width, height, color } = props;
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
export function Meter(props: { value: number; width: number; color?: string; height?: number }) {
  const h = props.height ?? 5;
  const fill = Math.max(0, Math.min(1, props.value)) * props.width;
  return (
    <View style={{ width: props.width, height: h, radius: h / 2, background: ui.track, overflow: "hidden", shrink: 0 }}>
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

/** Four rounded squares, silver on graphite, like the lumabar start tile. */
export function WindowsLogo(props: { size: number; color?: string }) {
  const s = props.size;
  const fill = props.color ?? "#e9e9ee";
  const q = s * 0.44;
  const g = s - q * 2;
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
  { value: "highlight", label: "Realce" },
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
export function HitReach(props: { height: number; onClick?: () => void; onContextMenu?: () => void; onHover?: (hovered: boolean) => void }) {
  const reach = Math.max(0, (ui.dock.height - props.height) / 2);
  if (!reach) return null;
  return (
    <Pressable
      aria-hidden
      onClick={props.onClick}
      onContextMenu={props.onContextMenu}
      onHover={props.onHover}
      style={{ position: "absolute", top: -reach, bottom: -reach, left: 0, right: 0, cursor: "pointer" }}
    />
  );
}

/**
 * `magnified`: the icon sits in a magnifying row (Start and the apps), which draws the "macos"
 * effect itself; elsewhere (tray) "macos" falls back to a plain zoom.
 */
export function iconHover(options?: { magnified?: boolean }): Style {
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
  if (effect === "macos" && options?.magnified) return { active };
  switch (effect) {
    case "macos":
    case "zoom":
      return { transition, hover: { transform: `translateY(-${px(2)}px) scale(${(1 + 0.14 * k).toFixed(3)})` }, active };
    case "lift":
      return {
        transition,
        hover: {
          transform: `translateY(-${px(4)}px)`,
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
      return { transition, hover: { background: `rgba(255,255,255,${Math.min(0.2, 0.07 * k).toFixed(3)})` }, active };
    default:
      return { active };
  }
}
