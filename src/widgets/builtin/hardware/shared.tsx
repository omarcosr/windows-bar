import { Circle, Path, Svg, Text, View, type Child } from "@tarve/core";
import { system } from "../../../services/system";
import { launch } from "../../../services/windows";
import { openQuickSettings } from "../../../native/desktop";
import { numeric, ui } from "../../../theme";
import type { DockMenuItem } from "../../../menu/dock-menu";

export const amber = "#ff9f0a";

/** Load colour: green, amber from 65 %, red from 85 % (as the "CPU e RAM" tile). */
export const loadTone = (v: number) => (v >= 85 ? ui.danger : v >= 65 ? amber : ui.green);

/** SVG arc path of `fraction` of a circle, clockwise from 12 o'clock. */
function arcPath(cx: number, cy: number, r: number, fraction: number) {
  const a = fraction * Math.PI * 2;
  const x = cx + r * Math.sin(a);
  const y = cy - r * Math.cos(a);
  return `M ${cx} ${cy - r} A ${r} ${r} 0 ${fraction > 0.5 ? 1 : 0} 1 ${x.toFixed(2)} ${y.toFixed(2)}`;
}

/** A progress ring with optional content centred inside. */
export function Ring(props: { value: number; color: string; size?: number; stroke?: number; children?: Child }) {
  const size = props.size ?? ui.tile.control;
  const stroke = props.stroke ?? 3;
  const r = (size - stroke) / 2;
  const c = size / 2;
  const f = Math.max(0, Math.min(1, props.value));
  return (
    <View style={{ width: size, height: size, shrink: 0 }}>
      <Svg width={size} height={size} viewBox={[0, 0, size, size]}>
        <Circle cx={c} cy={c} r={r} fill="none" stroke={ui.track} stroke-width={stroke} />
        {f >= 0.999 ? (
          <Circle cx={c} cy={c} r={r} fill="none" stroke={props.color} stroke-width={stroke} />
        ) : f > 0.005 ? (
          <Path d={arcPath(c, c, r, f)} fill="none" stroke={props.color} stroke-width={stroke} stroke-linecap="round" />
        ) : null}
      </Svg>
      {props.children ? (
        <View style={{ position: "absolute", left: 0, top: 0, width: size, height: size, align: "center", justify: "center" }}>
          {props.children}
        </View>
      ) : null}
    </View>
  );
}

/** Lightning bolt, the Windows battery "charging" mark. */
export function Bolt(props: { size: number; color?: string }) {
  return (
    <Svg width={props.size} height={props.size} viewBox="0 0 24 24">
      <Path d="M13.5 2 4.5 13.5h6L9.5 22l10-12.5h-6.2L13.5 2Z" fill={props.color ?? "#ffd60a"} stroke="none" />
    </Svg>
  );
}

/** Label above, value below: the two text lines of a metric tile. */
export function Metric(props: { label: string; value: string; color?: string; width?: number }) {
  const l = ui.tile.lines;
  return (
    <View style={{ direction: "column", justify: "center", gap: l.gap, width: props.width, shrink: 0 }}>
      <Text size={l.secondary - 1} weight={600} color={ui.muted} style={{ lineHeight: l.lineHeight }}>
        {props.label}
      </Text>
      <Text size={l.primary} weight={700} color={props.color ?? ui.text} style={{ ...numeric, lineHeight: l.lineHeight }}>
        {props.value}
      </Text>
    </View>
  );
}

// ---------- Battery ----------

export interface BatteryReading {
  percent: number;
  /** On AC power (GetSystemPowerStatus ACLineStatus), as the taskbar battery icon shows the plug. */
  plugged: boolean;
  demo: boolean;
}

/** The live battery, or demo values in the gallery on a machine without one. */
export function battery(preview: boolean): BatteryReading {
  const b = system.battery;
  if (b.hasBattery) return { percent: b.percent, plugged: b.charging, demo: false };
  return { percent: preview ? 72 : 0, plugged: preview, demo: true };
}

export const batteryTone = (b: BatteryReading) => (b.plugged ? ui.green : b.percent <= 10 ? ui.danger : b.percent <= 20 ? amber : ui.green);

export const batteryLabel = (b: BatteryReading) => (b.plugged ? (b.percent >= 100 ? "Carregada" : "Carregando") : "Na bateria");

/** The battery tip, worded as the taskbar battery icon's. */
export const batteryTip = (id: string, preview: boolean) => ({
  id,
  lines: () => {
    const b = battery(preview);
    return [
      b.plugged ? `Bateria: ${b.percent}% (${b.percent >= 100 ? "carregada" : "carregando"}, na tomada)` : `Bateria: ${b.percent}% restante`,
      "Clique: Configurações rápidas",
    ];
  },
});

/** Click on a battery tile: Quick Settings, as clicking the taskbar battery icon. */
export const openBatteryFlyout = () => openQuickSettings();

export function batteryMenu(): DockMenuItem[][] {
  return [
    [
      { label: "Energia e bateria", icon: "settings", onSelect: () => launch("ms-settings:powersleep") },
      { label: "Economia de energia", icon: "settings", onSelect: () => launch("ms-settings:batterysaver") },
    ],
  ];
}

export const noBattery = () => !system.battery.hasBattery;
