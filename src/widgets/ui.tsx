import { Circle, Path, Polyline, Pressable, Row, Svg, SvgRect, View, type Child, type Style } from "@tarve/core";
import { ui } from "../theme";

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
  const style: Style = {
    width: props.width,
    height: ui.tile.height,
    radius: ui.tile.radius,
    background: props.background ?? ui.tile.background,
    borderWidth: 1,
    borderColor: ui.tile.border,
    padding: props.padding ?? 8,
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
      onClick={props.onClick}
      onContextMenu={props.onContextMenu}
      style={{
        ...style,
        cursor: "pointer",
        hover: { background: props.background ?? ui.tile.hover },
        active: { transform: "scale(0.97)" },
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
  const size = props.size ?? 30;
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
export function WindowsLogo(props: { size: number }) {
  const s = props.size;
  const q = s * 0.44;
  const g = s - q * 2;
  const square = (x: number, y: number) => <SvgRect x={x} y={y} width={q} height={q} rx={s * 0.05} fill="#e9e9ee" stroke="none" />;
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
