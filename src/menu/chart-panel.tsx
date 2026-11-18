import { Circle, Input, Line, Path, Polyline, Pressable, Row, Svg, SvgRect, Text, View, Window, darkTheme, store, type AppHandle, type ScreenInfo } from "@tarve/core";
import { DockWindow } from "../native/dock-window";
import { numeric, ui } from "../theme";
import type { History } from "../services/finance-providers";
import { launch } from "../services/windows";
import { FluentGlyph } from "./dock-menu";
import { hideTip } from "./hover-tip";

/**
 * The chart panel of the finance tiles: a flyout above the tile, like the taskbar's calendar
 * flyout, with the tile's series over a chosen range, the value under the pointer, a span picked by
 * dragging (or by two clicks) and a second, dimmer line to compare with. The tile hands it a
 * ChartSource: how to load each range and comparison, how to format values and what "Usar no tile"
 * saves. Data is read when the panel opens or the range changes (through the providers' caches);
 * nothing polls while it is closed.
 */

export interface PanelOption {
  value: string;
  label: string;
}

export interface ChartSource {
  /** Identity: a second click on the same tile closes the panel. */
  key: string;
  /** The dock node the panel sits above (the tile's id). */
  anchor: string;
  title: string;
  brand: { color: string; letter: string };
  /** "price": a level over time. "sum": daily amounts, drawn accumulated over the range (revenue). */
  mode: "price" | "sum";
  ranges: readonly PanelOption[];
  range: string;
  /** Always starts with { value: "none" }. */
  compares: readonly PanelOption[];
  compare: string;
  /** Lets the user type another symbol to compare with (compare value "sym:<text>"); the text is the placeholder. */
  symbolInput?: string;
  /** Ranges whose points are minutes or hours apart (dates show the time). */
  intraday?: (range: string) => boolean;
  load(range: string): Promise<History & { demo?: boolean }>;
  loadCompare?(range: string, compare: string): Promise<History | null>;
  format(value: number, currency: string): string;
  source: string;
  url?: string;
  /** Saves the range and comparison into the tile's config ("Usar no tile"). */
  apply?(range: string, compare: string): void;
  /** What the tile shows now, to mark the button as done; no `compare` when the tile cannot keep one. */
  applied?(): { range: string; compare?: string };
}

const TITLE = "WindowsBar Chart";
const WIDTH = 380;
const PAD = 16;
const PLOT_W = 296;
const PLOT_H = 150;
const AXIS_W = WIDTH - PAD * 2 - PLOT_W - 8;
const GAP = 8;
const SURFACE = "#202020";
const CHIP_ON = "rgba(255,255,255,0.09)";

const panel = store({
  key: "",
  range: "",
  compare: "none",
  /** Bumped when the series below change (kept out of the store: hundreds of points). */
  rev: 0,
  loading: false,
  error: "",
  compareError: "",
  hover: -1,
  a: -1,
  b: -1,
  typed: "",
});

let src: ChartSource | null = null;
let main: (History & { demo?: boolean }) | null = null;
let other: History | null = null;
let seq = 0;

let handle: AppHandle | undefined;
/** The app whose window draws the panel (the flyout, or a test harness): for layout queries. */
let host: AppHandle | undefined;
let shown = false;
let size = { width: 0, height: 0 };
let scale = 1;
let area = { x: 0, y: 0, width: 1920, height: 1080 };
let cursorX = 0;
let lastBounds = "";
let dragged = false;

// ---------- formatting ----------

const dateFormat = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit" });
const dayFormat = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit" });
const timeFormat = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" });
const longFormat = new Intl.DateTimeFormat("pt-BR", { weekday: "short", day: "2-digit", month: "short", year: "numeric" });

function when(ms: number, intraday: boolean, long = false) {
  const d = new Date(ms);
  if (intraday) return `${dayFormat.format(d)} ${timeFormat.format(d)}`;
  return long ? longFormat.format(d).replace(/\.,/g, ",") : dateFormat.format(d);
}

const compactFormat = new Intl.NumberFormat("pt-BR", { notation: "compact", maximumFractionDigits: 1 });

/** An axis label: short, without the currency (the header and the readout carry it). */
function axisText(value: number) {
  const v = Math.abs(value);
  if (v === 0) return "0";
  if (v >= 10_000) return compactFormat.format(value);
  const digits = v >= 100 ? 0 : v >= 1 ? 2 : 4;
  return value.toLocaleString("pt-BR", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

const pct = (value: number) => `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(2).replace(".", ",")}%`;

// ---------- data ----------

function cumulative(values: readonly number[]) {
  let total = 0;
  return values.map((v) => (total += v));
}

/** What the chart draws: the main values, the comparison's (rebased onto the main line for another symbol) and the dates. */
function series() {
  if (!src || !main || main.points.length === 0) return null;
  const sum = src.mode === "sum";
  const raw = main.points.map((p) => p.v);
  const values = sum ? cumulative(raw) : raw;
  let compare: number[] | null = null;
  if (other && other.points.length > 1) {
    const o = other.points.map((p) => p.v);
    compare = sum ? cumulative(o) : o;
    // Another symbol is in another unit: lay it over the main line from the same start (a % comparison).
    if (panel.compare.startsWith("sym:") && compare[0]) {
      const k = values[0]! / compare[0];
      compare = compare.map((v) => v * k);
    }
  }
  return { raw, values, compare, at: main.points.map((p) => p.at), currency: main.currency, intraday: src.intraday?.(panel.range) ?? false };
}

async function load(withMain: boolean) {
  const s = src;
  if (!s) return;
  const id = ++seq;
  const range = panel.range;
  const compare = panel.compare;
  panel.loading = true;
  panel.compareError = "";
  if (withMain) panel.error = "";
  try {
    const [m, o] = await Promise.all([
      withMain ? s.load(range) : Promise.resolve(main),
      compare !== "none" && s.loadCompare ? s.loadCompare(range, compare).catch((error: unknown) => {
        panel.compareError = error instanceof Error && /404/.test(error.message) ? "não encontrado" : "sem dados";
        return null;
      }) : Promise.resolve(null),
    ]);
    if (id !== seq || src !== s) return;
    main = m;
    other = o;
  } catch (error) {
    if (id !== seq || src !== s) return;
    panel.error = error instanceof Error && /\b404\b/.test(error.message) ? "Símbolo não encontrado" : "Sem conexão com a fonte";
    main = null;
    other = null;
  }
  panel.loading = false;
  panel.rev++;
}

/** Shows `source` in the panel (and loads it); the flyout opens with openChartPanel. */
export function setChartSource(source: ChartSource) {
  const same = src?.key === source.key;
  src = source;
  if (!same) {
    main = null;
    other = null;
    panel.typed = "";
  }
  panel.key = source.key;
  panel.range = source.range;
  panel.compare = source.compare || "none";
  panel.a = panel.b = panel.hover = -1;
  void load(true);
}

function pickRange(range: string) {
  if (range === panel.range) return;
  panel.range = range;
  panel.a = panel.b = -1;
  void load(true);
}

function pickCompare(compare: string) {
  if (compare === panel.compare) return;
  panel.compare = compare;
  if (compare === "none") {
    other = null;
    panel.compareError = "";
    panel.rev++;
    return;
  }
  void load(false);
}

// ---------- pointer ----------

function indexAt(x: number, n: number) {
  if (n < 2) return 0;
  return Math.max(0, Math.min(n - 1, Math.round((x / PLOT_W) * (n - 1))));
}

function count() {
  return main?.points.length ?? 0;
}

/** x inside the plot of a window position (drag events report window coordinates). */
function plotX(windowX: number) {
  const box = host?.layout(["cp-plot"])?.["cp-plot"];
  return box ? windowX - box.x : null;
}

function onHover(x: number) {
  const i = indexAt(x, count());
  if (i !== panel.hover) panel.hover = i;
}

function onClickPlot() {
  if (dragged) {
    dragged = false;
    return;
  }
  const i = panel.hover;
  if (i < 0) return;
  if (panel.a >= 0 && panel.b < 0) {
    if (i !== panel.a) panel.b = i;
  } else {
    panel.a = i;
    panel.b = -1;
  }
}

// ---------- view ----------

function Chip(props: { label: string; on: boolean; onClick: () => void; id?: string }) {
  return (
    <Pressable
      id={props.id}
      focusable={false}
      onClick={props.onClick}
      style={{
        height: 26,
        padding: { left: 9, right: 9 },
        radius: 4,
        align: "center",
        justify: "center",
        cursor: "pointer",
        background: props.on ? CHIP_ON : "rgba(255,255,255,0)",
        hover: { background: props.on ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.06)" },
      }}
    >
      <Text size={12} weight={props.on ? 600 : 400} color={props.on ? ui.text : ui.muted} style={{ whiteSpace: "nowrap" }}>
        {props.label}
      </Text>
    </Pressable>
  );
}

function Button(props: { label: string; accent?: boolean; disabled?: boolean; glyph?: number; onClick: () => void; id?: string }) {
  return (
    <Pressable
      id={props.id}
      focusable={false}
      onClick={props.disabled ? undefined : props.onClick}
      style={{
        direction: "row",
        gap: 6,
        height: 30,
        padding: { left: 12, right: 12 },
        radius: 4,
        align: "center",
        justify: "center",
        cursor: props.disabled ? "default" : "pointer",
        opacity: props.disabled ? 0.55 : 1,
        background: props.accent && !props.disabled ? ui.blue : "rgba(255,255,255,0.06)",
        borderWidth: 1,
        borderColor: props.accent && !props.disabled ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.07)",
        hover: props.disabled ? undefined : { background: props.accent ? "#3b9cff" : "rgba(255,255,255,0.1)" },
      }}
    >
      {props.glyph ? <FluentGlyph code={props.glyph} size={12} color={props.accent && !props.disabled ? "#fff" : ui.text} /> : null}
      <Text size={12} weight={props.accent ? 600 : 400} color={props.accent && !props.disabled ? "#fff" : ui.text} style={{ whiteSpace: "nowrap" }}>
        {props.label}
      </Text>
    </Pressable>
  );
}

function Header(props: { data: NonNullable<ReturnType<typeof series>> | null }) {
  const s = src!;
  const d = props.data;
  let value = "";
  let change: { abs: number; rel: number | null; text: string } | null = null;
  const rangeLabel = s.ranges.find((r) => r.value === panel.range)?.label ?? "";
  if (d) {
    const last = d.values[d.values.length - 1]!;
    value = s.format(last, d.currency);
    if (s.mode === "price") {
      const first = d.values[0]!;
      change = { abs: last - first, rel: first ? ((last - first) / first) * 100 : null, text: `em ${rangeLabel}` };
    } else if (d.compare) {
      const before = d.compare[d.compare.length - 1]!;
      change = { abs: last - before, rel: before ? ((last - before) / Math.abs(before)) * 100 : null, text: `vs ${compareLabel()}` };
    }
  }
  const up = (change?.abs ?? 0) >= 0;
  return (
    <View style={{ gap: 2 }}>
      <Row style={{ align: "center", gap: 8, height: 20 }}>
        <View style={{ width: 18, height: 18, radius: 9, background: s.brand.color, align: "center", justify: "center", shrink: 0 }}>
          <Text size={11} weight={800} color="#fff" style={{ lineHeight: 1 }}>
            {s.brand.letter}
          </Text>
        </View>
        <Text size={13} weight={600} color={ui.text} style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {s.title}
        </Text>
        {main?.demo ? (
          <Text size={11} color={ui.faint}>
            {"dados de exemplo"}
          </Text>
        ) : null}
        {panel.loading ? (
          <Text size={11} color={ui.muted}>
            {"carregando…"}
          </Text>
        ) : null}
      </Row>
      <Row style={{ align: "end", gap: 10, height: 30 }}>
        <Text size={22} weight={600} color={ui.text} style={{ ...numeric, lineHeight: 1.2 }}>
          {value || "—"}
        </Text>
        {change ? (
          <Text size={12} weight={600} color={up ? ui.green : ui.danger} style={{ ...numeric, margin: { bottom: 4 } }}>
            {`${up ? "▲" : "▼"} ${s.format(Math.abs(change.abs), d!.currency)}${change.rel !== null ? ` (${pct(change.rel)})` : ""}`}
          </Text>
        ) : null}
        {change ? (
          <Text size={12} color={ui.muted} style={{ margin: { bottom: 4 }, whiteSpace: "nowrap" }}>
            {change.text}
          </Text>
        ) : null}
      </Row>
    </View>
  );
}

function compareLabel() {
  const c = panel.compare;
  if (c.startsWith("sym:")) return c.slice(4);
  return src?.compares.find((o) => o.value === c)?.label.toLowerCase() ?? "";
}

/** The line under the header: the point under the pointer, the picked span, or how to pick one. */
function Readout(props: { data: NonNullable<ReturnType<typeof series>> }) {
  const s = src!;
  const d = props.data;
  const f = (v: number) => s.format(v, d.currency);
  const sum = s.mode === "sum";
  type Line = { text: string; color?: string; bold?: boolean };
  const text = ((): { first: Line[]; second: Line[]; clear: boolean } => {
    if (panel.a >= 0 && panel.b >= 0) {
      const a = Math.min(panel.a, panel.b);
      const b = Math.max(panel.a, panel.b);
      const from = sum ? d.values[a]! - d.raw[a]! : d.values[a]!;
      const to = d.values[b]!;
      const delta = to - from;
      const rel = from ? ` (${pct((delta / Math.abs(from)) * 100)})` : "";
      return {
        first: [{ text: `de ${when(d.at[a]!, d.intraday)} a ${when(d.at[b]!, d.intraday)}${sum ? " (acumulado)" : ""}` }],
        second: [
          { text: `${f(from)} → ${f(to)}`, bold: true },
          { text: `Δ ${delta >= 0 ? "+" : "−"}${f(Math.abs(delta))}${rel}`, color: delta >= 0 ? ui.green : ui.danger, bold: true },
        ],
        clear: true,
      };
    }
    if (panel.a >= 0) return { first: [{ text: `de ${when(d.at[panel.a]!, d.intraday)} a …` }], second: [{ text: "Clique em outro ponto do gráfico", color: ui.muted }], clear: true };
    if (panel.hover >= 0) {
      const i = panel.hover;
      const second: Line[] = [];
      if (sum) second.push({ text: `no dia ${f(d.raw[i]!)}`, color: ui.muted });
      if (d.compare) {
        const j = Math.round((i / Math.max(1, d.values.length - 1)) * (d.compare.length - 1));
        if (panel.compare.startsWith("sym:")) {
          const mine = d.values[0] ? (d.values[i]! / d.values[0] - 1) * 100 : 0;
          const theirs = d.compare[0] ? (d.compare[j]! / d.compare[0] - 1) * 100 : 0;
          second.push({ text: `${s.title.split("/")[0]} ${pct(mine)} · ${compareLabel()} ${pct(theirs)} desde o início`, color: ui.muted });
        } else second.push({ text: `${compareLabel()}: ${f(d.compare[j]!)}`, color: ui.muted });
      }
      return { first: [{ text: when(d.at[i]!, d.intraday, true) }, { text: f(d.values[i]!), bold: true }], second, clear: false };
    }
    return {
      first: [{ text: "Passe o mouse para ver cada valor", color: ui.muted }],
      second: [{ text: "Arraste (ou clique em dois pontos) para comparar datas", color: ui.muted }],
      clear: false,
    };
  })();
  const line = (parts: Line[]) => (
    <Row style={{ height: 15, align: "center", gap: 8, minWidth: 0, overflow: "hidden" }}>
      {parts.map((p) => (
        <Text size={11} weight={p.bold ? 600 : 400} color={p.color ?? ui.text} style={{ ...numeric, whiteSpace: "nowrap", shrink: p.bold ? 0 : 1, overflow: "hidden", textOverflow: "ellipsis" }}>
          {p.text}
        </Text>
      ))}
    </Row>
  );
  return (
    <Row style={{ align: "center", gap: 6, height: 32 }}>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        {line(text.first)}
        {line(text.second)}
      </View>
      {text.clear ? (
        <Pressable
          focusable={false}
          onClick={() => {
            panel.a = panel.b = -1;
          }}
          style={{ width: 22, height: 22, radius: 4, align: "center", justify: "center", cursor: "pointer", hover: { background: "rgba(255,255,255,0.08)" } }}
        >
          <FluentGlyph code={0xe711 /* Cancel */} size={10} color={ui.muted} />
        </Pressable>
      ) : null}
    </Row>
  );
}

function Plot(props: { data: NonNullable<ReturnType<typeof series>> }) {
  const d = props.data;
  const n = d.values.length;
  const all = d.compare ? [...d.values, ...d.compare] : d.values;
  let min = Math.min(...all);
  let max = Math.max(...all);
  if (src!.mode === "sum") min = Math.min(0, min);
  const pad = (max - min || Math.abs(max) || 1) * 0.08;
  const lo = src!.mode === "sum" && min === 0 ? 0 : min - pad;
  const hi = max + pad;
  const top = 4;
  const bottom = PLOT_H - 4;
  const y = (v: number) => top + (1 - (v - lo) / (hi - lo || 1)) * (bottom - top);
  const x = (i: number, len = n) => (len < 2 ? PLOT_W / 2 : (i / (len - 1)) * PLOT_W);
  const up = d.values[n - 1]! >= (src!.mode === "sum" ? (d.compare?.[d.compare.length - 1] ?? 0) : d.values[0]!);
  const color = up ? ui.green : ui.danger;
  const line = d.values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const area = `M 0 ${bottom} L ${d.values.map((v, i) => `${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" L ")} L ${PLOT_W} ${bottom} Z`;
  const cmp = d.compare ? d.compare.map((v, i) => `${x(i, d.compare!.length).toFixed(1)},${y(v).toFixed(1)}`).join(" ") : "";
  const a = panel.a >= 0 ? Math.min(panel.a, panel.b >= 0 ? panel.b : panel.a) : -1;
  const b = panel.a >= 0 ? Math.max(panel.a, panel.b >= 0 ? panel.b : panel.a) : -1;
  const h = panel.hover;
  const hj = d.compare && h >= 0 ? Math.round((h / Math.max(1, n - 1)) * (d.compare.length - 1)) : -1;
  const grid = [0.25, 0.5, 0.75].map((t) => top + t * (bottom - top));
  return (
    <Svg width={PLOT_W} height={PLOT_H} viewBox={[0, 0, PLOT_W, PLOT_H]}>
      {grid.map((gy) => (
        <Line x1={0} y1={gy} x2={PLOT_W} y2={gy} stroke="rgba(255,255,255,0.06)" stroke-width={1} />
      ))}
      <Line x1={0} y1={bottom + 0.5} x2={PLOT_W} y2={bottom + 0.5} stroke="rgba(255,255,255,0.14)" stroke-width={1} />
      {a >= 0 ? <SvgRect x={x(a)} y={0} width={Math.max(1, x(b) - x(a))} height={PLOT_H} fill={ui.blue} fill-opacity={0.16} stroke="none" /> : null}
      <Path d={area} fill={color} fill-opacity={0.1} stroke="none" />
      {cmp ? <Polyline points={cmp} fill="none" stroke="rgba(255,255,255,0.45)" stroke-width={1.4} stroke-dasharray="4 3" stroke-linejoin="round" /> : null}
      <Polyline points={line} fill="none" stroke={color} stroke-width={1.8} stroke-linejoin="round" stroke-linecap="round" />
      {a >= 0 ? <Line x1={x(a)} y1={0} x2={x(a)} y2={PLOT_H} stroke={ui.blue} stroke-width={1} /> : null}
      {b >= 0 && b !== a ? <Line x1={x(b)} y1={0} x2={x(b)} y2={PLOT_H} stroke={ui.blue} stroke-width={1} /> : null}
      {a >= 0 ? <Circle cx={x(a)} cy={y(src!.mode === "sum" ? d.values[a]! - d.raw[a]! : d.values[a]!)} r={3} fill={ui.blue} stroke="none" /> : null}
      {b >= 0 && b !== a ? <Circle cx={x(b)} cy={y(d.values[b]!)} r={3} fill={ui.blue} stroke="none" /> : null}
      {h >= 0 ? <Line x1={x(h)} y1={0} x2={x(h)} y2={PLOT_H} stroke="rgba(255,255,255,0.35)" stroke-width={1} /> : null}
      {hj >= 0 ? <Circle cx={x(h)} cy={y(d.compare![hj]!)} r={2.5} fill="rgba(255,255,255,0.7)" stroke="none" /> : null}
      {h >= 0 ? <Circle cx={x(h)} cy={y(d.values[h]!)} r={3.5} fill={color} stroke={SURFACE} stroke-width={1.5} /> : null}
      {h < 0 ? <Circle cx={x(n - 1)} cy={y(d.values[n - 1]!)} r={3} fill={color} stroke="none" /> : null}
    </Svg>
  );
}

function Chart() {
  const d = series();
  void panel.rev;
  if (!d) {
    return (
      <View style={{ height: PLOT_H + 18 + 20, align: "center", justify: "center", gap: 6 }}>
        <Text size={12} color={panel.error ? ui.danger : ui.muted}>
          {panel.error || (panel.loading ? "Carregando…" : "Sem dados para este período")}
        </Text>
      </View>
    );
  }
  const all = d.compare ? [...d.values, ...d.compare] : d.values;
  const max = Math.max(...all);
  const min = src!.mode === "sum" ? Math.min(0, ...all) : Math.min(...all);
  return (
    <View style={{ gap: 4 }}>
      <Readout data={d} />
      <Row style={{ gap: 8, align: "start" }}>
        <Pressable
          id="cp-plot"
          focusable={false}
          draggable
          onPointerMove={(p) => onHover(p.x)}
          onPointerLeave={() => {
            panel.hover = -1;
          }}
          onClick={onClickPlot}
          onDragStart={(p) => {
            const local = plotX(p.x);
            panel.a = local === null ? panel.hover : indexAt(local, count());
            panel.b = panel.a;
          }}
          onDragMove={(p) => {
            const local = plotX(p.x);
            if (local === null) return;
            panel.b = indexAt(local, count());
            panel.hover = panel.b;
          }}
          onDragEnd={() => {
            dragged = true;
            setTimeout(() => (dragged = false), 0);
            if (panel.b === panel.a) panel.b = -1;
          }}
          style={{ width: PLOT_W, height: PLOT_H, cursor: "crosshair", shrink: 0 }}
        >
          <Plot data={d} />
        </Pressable>
        <View style={{ width: AXIS_W, height: PLOT_H, justify: "between", shrink: 0 }}>
          <Text size={10} color={ui.muted} style={{ ...numeric, whiteSpace: "nowrap" }}>
            {axisText(max)}
          </Text>
          <Text size={10} color={ui.muted} style={{ ...numeric, whiteSpace: "nowrap" }}>
            {axisText(min)}
          </Text>
        </View>
      </Row>
      <Row style={{ width: PLOT_W, justify: "between" }}>
        <Text size={10} color={ui.muted} style={numeric}>
          {when(d.at[0]!, d.intraday)}
        </Text>
        <Text size={10} color={ui.muted} style={numeric}>
          {when(d.at[d.at.length - 1]!, d.intraday)}
        </Text>
      </Row>
    </View>
  );
}

function Compare() {
  const s = src!;
  if (s.compares.length < 2 && !s.symbolInput) return null;
  const typedOn = panel.compare.startsWith("sym:") && !s.compares.some((o) => o.value === panel.compare);
  return (
    <View style={{ gap: 4 }}>
      <Text size={11} color={ui.muted}>
        {"Comparar com"}
      </Text>
      <Row style={{ align: "center", gap: 2, wrap: true, rowGap: 4 }}>
      {s.compares.map((o) => (
        <Chip id={`cp-cmp-${o.value}`} label={o.label} on={panel.compare === o.value} onClick={() => pickCompare(o.value)} />
      ))}
      {s.symbolInput ? (
        <Input
          id="cp-symbol"
          value={panel.typed}
          placeholder={s.symbolInput}
          maxLength={16}
          onChange={(v) => {
            panel.typed = v;
          }}
          onSubmit={(v) => {
            const t = v.trim().toUpperCase();
            if (t) pickCompare(`sym:${t}`);
          }}
          style={{
            width: 96,
            margin: { left: 4 },
            height: 26,
            fontSize: 12,
            radius: 4,
            padding: { left: 8, right: 8 },
            background: typedOn ? CHIP_ON : "rgba(255,255,255,0.05)",
            borderWidth: 1,
            borderColor: typedOn ? ui.blue : "rgba(255,255,255,0.08)",
          }}
        />
      ) : null}
      {panel.compareError ? (
        <Text size={11} color={ui.danger} style={{ margin: { left: 6 } }}>
          {panel.compareError}
        </Text>
      ) : null}
      </Row>
    </View>
  );
}

function Footer() {
  const s = src!;
  const applied = s.applied?.();
  const inUse = !!applied && applied.range === panel.range && (applied.compare === undefined || applied.compare === panel.compare);
  const stamp = main?.demo ? "dados de exemplo" : main ? `dados de ${when(main.asOf, true)}` : "";
  return (
    <View style={{ gap: 8 }}>
      <View style={{ height: 1, background: "rgba(255,255,255,0.07)" }} />
      <Row style={{ align: "center", gap: 8 }}>
        <Text size={11} color={ui.muted} style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {`${s.source}${stamp ? ` · ${stamp}` : ""}`}
        </Text>
      </Row>
      <Row style={{ align: "center", gap: 8, justify: "end" }}>
        {s.url ? <Button id="cp-site" label="Abrir no site" glyph={0xe8a7 /* OpenInNewWindow */} onClick={() => launch(s.url!)} /> : null}
        {s.apply ? (
          <Button
            id="cp-apply"
            label={inUse ? "Em uso no tile" : "Usar no tile"}
            glyph={inUse ? 0xe73e /* CheckMark */ : undefined}
            accent
            disabled={inUse}
            onClick={() => {
              s.apply!(panel.range, panel.compare);
              panel.rev++;
            }}
          />
        ) : null}
      </Row>
    </View>
  );
}

/** The panel's content (the flyout's, and the test harness's). */
export function ChartPanel() {
  void panel.key;
  void panel.rev;
  if (!src) return <View style={{ width: WIDTH }} />;
  const s = src;
  return (
    <View
      onSize={({ borderBox }) => {
        size = { width: borderBox.width, height: borderBox.height };
        if (shown) place();
      }}
      style={{
        alignSelf: "start",
        shrink: 0,
        width: WIDTH,
        gap: 12,
        padding: PAD,
        radius: 8,
        background: SURFACE,
        borderWidth: 1,
        borderColor: "rgba(255,255,255,0.08)",
      }}
    >
      <Header data={series()} />
      <Row style={{ gap: 2, wrap: true }}>
        {s.ranges.map((r) => (
          <Chip id={`cp-range-${r.value}`} label={r.label} on={panel.range === r.value} onClick={() => pickRange(r.value)} />
        ))}
      </Row>
      <Chart />
      <Compare />
      <Footer />
    </View>
  );
}

// ---------- the flyout window ----------

function FlyoutView() {
  return (
    <Window
      title={TITLE}
      width={WIDTH + 40}
      height={520}
      frameless
      resizable={false}
      skipTaskbar
      level="alwaysOnTop"
      backdrop="transparent"
      visible={false}
      chrome="none"
      theme={darkTheme}
      style={{ background: "rgba(0,0,0,0)" }}
    >
      <ChartPanel />
    </Window>
  );
}

/** Above the dock, centred on the tile, kept on screen. */
function place() {
  if (!handle || !size.width) return;
  const width = Math.ceil(size.width * scale);
  const height = Math.ceil(size.height * scale);
  const gap = Math.round(GAP * scale);
  const { x, y } = DockWindow.placePopup(width, height, gap, area, (src && DockWindow.nodeCenter(src.anchor)) ?? cursorX);
  const key = `${x},${y},${width},${height}`;
  if (key === lastBounds) return;
  lastBounds = key;
  handle.setBounds({ x, y, width, height, physical: true });
}

function screenAt(screens: ScreenInfo[], p: { x: number; y: number } | null) {
  const hit = p && screens.find((s) => p.x >= s.x && p.x < s.x + s.width && p.y >= s.y && p.y < s.y + s.height);
  return hit || screens.find((s) => s.primary) || screens[0];
}

let opening = 0;

export async function openChartPanel(source: ChartSource) {
  const h = handle;
  if (!h) return;
  const ticket = ++opening;
  hideTip();
  setChartSource(source);
  const { screens, cursor } = await h.screens();
  if (ticket !== opening) return;
  const screen = screenAt(screens, cursor);
  if (screen) {
    scale = screen.scale || 1;
    area = { x: screen.x, y: screen.y, width: screen.width, height: screen.height };
  }
  cursorX = DockWindow.along(cursor, area);
  // Let the content lay out (onSize) before placing, so it never flashes at the old size.
  setTimeout(() => {
    if (ticket !== opening) return;
    shown = true;
    lastBounds = "";
    place();
    h.show();
    h.activate();
  }, 40);
}

export function closeChartPanel() {
  opening++;
  if (!shown) return;
  shown = false;
  lastBounds = "";
  panel.key = "";
  handle?.hide();
}

export function chartPanelOpen() {
  return shown;
}

/** Opens the panel for `source`, or closes it when it already shows that tile (a second click on the tile). */
export function toggleChartPanel(source: ChartSource) {
  if (shown && panel.key === source.key) return closeChartPanel();
  void openChartPanel(source);
}

/** For a harness that draws ChartPanel in a window of its own: layout queries go to that app. */
export function setChartPanelHost(app: AppHandle) {
  host = app;
}

export async function initChartPanel(app: AppHandle) {
  handle = app.openWindow(FlyoutView, { id: "chart-panel", closeBehavior: "hide", keyboardEvents: true });
  host = handle;
  await handle.ready;
  handle.onEvent((event) => {
    if (event.type === "keyboard" && (event as { key?: string }).key === "Escape") closeChartPanel();
  });
  // Light dismiss, as the dock menu: the panel is activated when it opens, so a click anywhere else
  // takes the focus from it. A press on the tile that opened it leaves it to that click's toggle.
  handle.onFocusChange((focused, change) => {
    if (focused || !shown) return;
    if (change.to === "main" && src && DockWindow.pressedOn(src.anchor, change.pointerTarget)) return;
    // No target reported: the pointer on the opening tile is the same press.
    if (!change.to && src && DockWindow.pointerOn(src.anchor)) return;
    closeChartPanel();
  });
}
