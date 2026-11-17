import { Circle, Line, Polygon, Svg, Text, View, store } from "@tarve/core";
import { formatDatePicture, formatTime } from "../../../native/locale-format";
import { openNotificationCenter } from "../../../native/desktop";
import { zoneOptions } from "../../../native/clocks-zones";
import { launch } from "../../../services/windows";
import { numeric, ui } from "../../../theme";
import type { DockMenuItem } from "../../../menu/dock-menu";
import type { WidgetContext } from "../../types";
import { every, onClock, type ClockUnit } from "../../../services/clock";
import { onConfigSaved } from "../../../config";

/**
 * A store with `now`, moved on the shared clock at each `unit` boundary (the coarsest the face
 * shows: seconds, minutes, or the day for date-only faces) while the dock is visible.
 */
export function clockState<C extends object>(ctx: WidgetContext<C>, unit: () => ClockUnit) {
  const state = store({ now: new Date() });
  const sub = onClock(every(unit), (now) => (state.now = new Date(now)));
  // "Show seconds" toggled in the settings: re-plan at once instead of at the next minute.
  ctx.onDispose(onConfigSaved(sub.update));
  ctx.onDispose(sub.cancel);
  return state;
}

/** A fixed demo moment for the gallery previews: 10:09:30, the watchmaker's pose. */
export const demoNow = () => {
  const d = new Date();
  d.setHours(10, 9, 30, 0);
  return d;
};

export type HourFormat = "system" | "24" | "12";

export const hourFormatSetting = {
  kind: "choice" as const,
  key: "hourFormat" as const,
  label: "Formato da hora",
  options: [
    { value: "system", label: "Do Windows (formato regional)" },
    { value: "24", label: "24 horas" },
    { value: "12", label: "12 horas" },
  ],
};

const pad = (n: number) => String(n).padStart(2, "0");

/** The 24-hour Windows format? Read from the user's short time picture via a probe at 13:00. */
function systemIs24h() {
  const probe = new Date(2000, 0, 1, 13, 0, 0);
  return /13/.test(formatTime(probe));
}

/**
 * Hours, minutes, seconds and an AM/PM suffix for the clock faces that draw digits themselves.
 * "system" follows Windows' regional format (24 h or 12 h); `utc` reads the UTC fields (zones).
 */
export function clockParts(d: Date, format: HourFormat, utc = false) {
  const h24 = utc ? d.getUTCHours() : d.getHours();
  const m = utc ? d.getUTCMinutes() : d.getMinutes();
  const s = utc ? d.getUTCSeconds() : d.getSeconds();
  const twelve = format === "12" || (format === "system" && !systemIs24h());
  const h = twelve ? h24 % 12 || 12 : h24;
  return { hh: twelve ? String(h) : pad(h), mm: pad(m), ss: pad(s), suffix: twelve ? (h24 < 12 ? "AM" : "PM") : "" };
}

/** Text time: Windows' own formatting for "system", else HH:MM(:SS) [AM/PM]. */
export function timeText(d: Date, format: HourFormat, options: { seconds?: boolean; utc?: boolean } = {}) {
  if (format === "system") return formatTime(d, options);
  const p = clockParts(d, format, options.utc);
  return `${p.hh}:${p.mm}${options.seconds ? `:${p.ss}` : ""}${p.suffix ? ` ${p.suffix}` : ""}`;
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Windows' weekday name in the user's language: "ddd" → "Seg", "dddd" → "Segunda-feira". */
export const weekdayName = (d: Date, long = false) => capital(formatDatePicture(d, long ? "dddd" : "ddd").replace(/\.$/, ""));
/** Windows' month name: "MMM" → "Nov", "MMMM" → "Novembro". */
export const monthName = (d: Date, long = false) => capital(formatDatePicture(d, long ? "MMMM" : "MMM").replace(/\.$/, ""));

/** Menu entries every clock widget shares, the same targets as the Windows clock. */
export function clockMenu(): DockMenuItem[][] {
  return [
    [
      { label: "Notificações e calendário", icon: "bell", onSelect: openNotificationCenter },
      { label: "Abrir Relógio do Windows", icon: "bell", onSelect: () => launch("ms-clock:") },
      { label: "Ajustar data e hora", icon: "settings", onSelect: () => launch("ms-settings:dateandtime") },
    ],
  ];
}

export const zoneChoices = zoneOptions.map((z) => ({ value: z.value, label: z.label }));

/** "10:09" pieces of the analog face as angles (degrees, 0 at 12 o'clock). */
function handAngles(d: Date, utc: boolean) {
  const h = utc ? d.getUTCHours() : d.getHours();
  const m = utc ? d.getUTCMinutes() : d.getMinutes();
  const s = utc ? d.getUTCSeconds() : d.getSeconds();
  return { hour: ((h % 12) + m / 60) * 30, minute: (m + s / 60) * 6, second: s * 6 };
}

/** A dark analog face: hour ticks, hour and minute hands, an optional orange second hand. */
export function AnalogFace(props: { size: number; now: Date; utc?: boolean; seconds?: boolean; ticks?: "all" | "quarters" }) {
  const s = props.size;
  const c = s / 2;
  const r = c - 1;
  const a = handAngles(props.now, props.utc ?? false);
  const at = (deg: number, len: number) => {
    const rad = (deg * Math.PI) / 180;
    return { x: c + Math.sin(rad) * len, y: c - Math.cos(rad) * len };
  };
  const ticks = [];
  for (let i = 0; i < 12; i++) {
    const major = i % 3 === 0;
    if (props.ticks === "quarters" && !major) continue;
    const p1 = at(i * 30, r - 2);
    const p2 = at(i * 30, r - (major ? s * 0.16 : s * 0.09));
    ticks.push(<Line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke={major ? ui.text : ui.faint} stroke-width={major ? Math.max(1.2, s * 0.045) : 1} stroke-linecap="round" />);
  }
  const hour = at(a.hour, r * 0.5);
  const minute = at(a.minute, r * 0.78);
  const second = at(a.second, r * 0.84);
  const tail = at(a.second + 180, r * 0.18);
  return (
    <Svg width={s} height={s} viewBox={[0, 0, s, s]}>
      <Circle cx={c} cy={c} r={r} fill="#0a0a0c" stroke="rgba(255,255,255,0.12)" stroke-width={1} />
      {ticks}
      <Line x1={c} y1={c} x2={hour.x} y2={hour.y} stroke={ui.text} stroke-width={Math.max(1.6, s * 0.07)} stroke-linecap="round" />
      <Line x1={c} y1={c} x2={minute.x} y2={minute.y} stroke={ui.text} stroke-width={Math.max(1.2, s * 0.045)} stroke-linecap="round" />
      {props.seconds ? <Line x1={tail.x} y1={tail.y} x2={second.x} y2={second.y} stroke={ui.orange} stroke-width={1} stroke-linecap="round" /> : null}
      <Circle cx={c} cy={c} r={Math.max(1.4, s * 0.05)} fill={props.seconds ? ui.orange : ui.text} stroke="none" />
    </Svg>
  );
}

/** Segments a..g lit for each digit (a top, b top-right, c bottom-right, d bottom, e bottom-left, f top-left, g middle). */
const SEGMENTS: Record<string, string> = {
  "0": "abcdef",
  "1": "bc",
  "2": "abged",
  "3": "abgcd",
  "4": "fgbc",
  "5": "afgcd",
  "6": "afgedc",
  "7": "abc",
  "8": "abcdefg",
  "9": "abcdfg",
};

const segmentShapes = new Map<number, [string, string][]>();

/** The seven segment polygons of a digit `h` tall (the same every tick: built once per size). */
function shapesFor(h: number) {
  let cached = segmentShapes.get(h);
  if (cached) return cached;
  const w = h * 0.55;
  const t = Math.max(2, h * 0.12);
  const g = t * 0.18;
  const mid = h / 2;
  const hz = (y: number) => `${t / 2 + g},${y} ${t + g},${y - t / 2} ${w - t - g},${y - t / 2} ${w - t / 2 - g},${y} ${w - t - g},${y + t / 2} ${t + g},${y + t / 2}`;
  const vt = (x: number, y1: number, y2: number) => `${x},${y1 + g} ${x + t / 2},${y1 + t / 2 + g} ${x + t / 2},${y2 - t / 2 - g} ${x},${y2 - g} ${x - t / 2},${y2 - t / 2 - g} ${x - t / 2},${y1 + t / 2 + g}`;
  const shapes: Record<string, string> = {
    a: hz(t / 2),
    g: hz(mid),
    d: hz(h - t / 2),
    f: vt(t / 2, t / 2, mid),
    b: vt(w - t / 2, t / 2, mid),
    e: vt(t / 2, mid, h - t / 2),
    c: vt(w - t / 2, mid, h - t / 2),
  };
  cached = Object.entries(shapes);
  segmentShapes.set(h, cached);
  return cached;
}

/** One seven-segment digit, `h` tall, lit segments in `color` over faint unlit ones. */
export function SegmentDigit(props: { digit: string; h: number; color: string }) {
  const h = props.h;
  const w = h * 0.55;
  const lit = SEGMENTS[props.digit] ?? "";
  return (
    <Svg width={w} height={h} viewBox={[0, 0, w, h]}>
      {shapesFor(h).map(([k, pts]) => (
        <Polygon points={pts} fill={lit.includes(k) ? props.color : "rgba(255,255,255,0.06)"} stroke="none" />
      ))}
    </Svg>
  );
}

/** Two stacked colon dots for the digit clocks. */
export function Colon(props: { h: number; color: string; on?: boolean }) {
  const d = Math.max(2, Math.round(props.h * 0.12));
  return (
    <View style={{ height: props.h, justify: "center", gap: Math.round(props.h * 0.22), opacity: props.on === false ? 0.25 : 1 }}>
      <View style={{ width: d, height: d, radius: d / 2, background: props.color }} />
      <View style={{ width: d, height: d, radius: d / 2, background: props.color }} />
    </View>
  );
}

/** A small muted caption line. */
export function Caption(props: { children: string; color?: string; size?: number }) {
  return (
    <Text size={props.size ?? ui.tile.lines.secondary - 1} weight={600} color={props.color ?? ui.muted} style={{ ...numeric, lineHeight: 1.1 }}>
      {props.children}
    </Text>
  );
}
