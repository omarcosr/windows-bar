import { Path, Svg, Circle, Text, View } from "@tarve/core";
import { systemSound } from "../../../native/productivity-sound";
import { numeric, ui } from "../../../theme";

export const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** m:ss, or h:mm:ss from an hour on. */
export function clock(ms: number) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Stopwatch format with tenths: m:ss.d (h:mm:ss.d from an hour on). */
export function clockTenths(ms: number) {
  const t = Math.max(0, Math.floor(ms / 100));
  const tenth = t % 10;
  const sec = Math.floor(t / 10);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}.${tenth}` : `${m}:${s}.${tenth}`;
}

/** A progress ring (track + arc from 12 o'clock), drawn with straight segments. */
export function Ring(props: { value: number; size: number; color: string; width?: number; label?: string }) {
  const { size, color } = props;
  const w = props.width ?? 3;
  const r = (size - w) / 2;
  const c = size / 2;
  const v = clamp01(props.value);
  const steps = Math.max(2, Math.ceil(v * 64));
  const pts: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = -Math.PI / 2 + (i / steps) * v * Math.PI * 2;
    pts.push(`${(c + r * Math.cos(a)).toFixed(2)} ${(c + r * Math.sin(a)).toFixed(2)}`);
  }
  return (
    <View style={{ width: size, height: size, shrink: 0, align: "center", justify: "center" }}>
      <View style={{ position: "absolute", left: 0, top: 0 }}>
        <Svg width={size} height={size} viewBox={[0, 0, size, size]}>
          <Circle cx={c} cy={c} r={r} fill="none" stroke={ui.track} stroke-width={w} />
          {v > 0.001 ? <Path d={`M ${pts.join(" L ")}`} fill="none" stroke={color} stroke-width={w} stroke-linecap="round" stroke-linejoin="round" /> : null}
        </Svg>
      </View>
      {props.label ? (
        <Text size={Math.max(8, Math.round(size * 0.3))} weight={700} color={ui.text} style={numeric}>
          {props.label}
        </Text>
      ) : null}
    </View>
  );
}

export const FLASH_MS = 10_000;

/** Ends a countdown: the Windows sound-scheme beep (if enabled) and a flashing tile. */
export function ring(state: { flashUntil: number }, sound: boolean) {
  state.flashUntil = Date.now() + FLASH_MS;
  if (sound) systemSound("asterisk");
}

/** The tile background while it flashes (alternating every half second), else undefined. */
export function flashBackground(state: { flashUntil: number; now: number }, color = "#5a3a12") {
  if (state.now >= state.flashUntil) return undefined;
  return Math.floor(state.now / 500) % 2 ? color : "#3a2a12";
}

export const minuteOptions = (values: number[]) => values.map((v) => ({ value: String(v), label: `${v} min` }));
