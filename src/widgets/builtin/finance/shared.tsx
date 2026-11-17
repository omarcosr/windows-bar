import { Column, Row, Svg, SvgRect, Text, View, store, toRaw } from "@tarve/core";
import type { DockMenuItem } from "../../../menu/dock-menu";
import { launch } from "../../../services/windows";
import { onConfigSaved } from "../../../config";
import { refreshWidget } from "../../../services/remote";
import {
  asPeriod,
  errorText,
  fxRate,
  historyDays,
  invalidate,
  money,
  periodChange,
  periodDays,
  periodLabels,
  periodSum,
  price,
  priceIn,
  type Period,
  type Quote,
  type Revenue,
} from "../../../services/finance-providers";
import { numeric, ui } from "../../../theme";
import { Sparkline, Tile } from "../../ui";
import { defineWidget, type WidgetContext, type WidgetSetting } from "../../types";

// ---------- shared options ----------

const CURRENCY_NAMES: Record<string, string> = {
  BRL: "Real",
  USD: "Dólar americano",
  EUR: "Euro",
  GBP: "Libra esterlina",
  JPY: "Iene",
  CAD: "Dólar canadense",
  AUD: "Dólar australiano",
  CHF: "Franco suíço",
  MXN: "Peso mexicano",
  ARS: "Peso argentino",
  CNY: "Yuan",
  INR: "Rúpia indiana",
  KRW: "Won",
  TRY: "Lira turca",
  ZAR: "Rand",
  SEK: "Coroa sueca",
  NOK: "Coroa norueguesa",
  DKK: "Coroa dinamarquesa",
  PLN: "Złoty",
  NZD: "Dólar neozelandês",
  SGD: "Dólar de Singapura",
  HKD: "Dólar de Hong Kong",
};

/** Display currencies for revenue and quotes (all on open.er-api). */
export const DISPLAY_CURRENCIES = ["BRL", "USD", "EUR", "GBP", "JPY", "CAD", "AUD", "CHF", "MXN", "ARS"];

export const currencyOptions = (codes: readonly string[]) => codes.map((code) => ({ value: code, label: `${code} · ${CURRENCY_NAMES[code] ?? code}` }));

/** "Original" plus the display currencies. */
export const displayCurrencyOptions = (original = "Original da conta") => [{ value: "original", label: original }, ...currencyOptions(DISPLAY_CURRENCIES)];

/** "Atualizar a cada" (minutes as strings). */
export const refreshSetting = {
  kind: "choice" as const,
  key: "refresh" as const,
  label: "Atualizar a cada",
  options: [
    { value: "5", label: "5 min" },
    { value: "15", label: "15 min" },
    { value: "30", label: "30 min" },
    { value: "60", label: "1 hora" },
  ],
};

/** Display options shared by every revenue tile (provider tiles and Total Revenue). */
export interface RevenueOptions {
  label: string;
  /** "original" or an ISO code. */
  currency: string;
  period: string;
  chart: string;
  compare: boolean;
  format: string;
  /** "net" | "gross", only offered where the provider has both. */
  value: string;
  refresh: string;
}

export const revenueDefaults = {
  currency: "original",
  period: "30d",
  chart: "bars",
  compare: true,
  format: "compact",
  value: "net",
  refresh: "15",
};

const periodSetting = {
  kind: "choice" as const,
  key: "period" as const,
  label: "Período",
  options: [
    { value: "7d", label: "7 dias" },
    { value: "30d", label: "30 dias" },
    { value: "month", label: "Mês atual" },
    { value: "90d", label: "90 dias" },
  ],
};

/** The revenue display settings; `original` offers "Original da conta", `gross` the Líquido/Bruto choice. */
export function revenueSettings(options: { original: boolean; gross: boolean }): WidgetSetting<RevenueOptions>[] {
  const out: WidgetSetting<RevenueOptions>[] = [
    {
      kind: "choice",
      key: "currency",
      label: "Moeda de exibição",
      description: options.original ? "Converte pelo câmbio do dia; sem câmbio mostra a moeda da conta." : "Os provedores são convertidos pelo câmbio do dia; a meta usa esta moeda.",
      options: options.original ? displayCurrencyOptions() : currencyOptions(DISPLAY_CURRENCIES),
    },
    periodSetting,
    {
      kind: "choice",
      key: "chart",
      label: "Gráfico",
      options: [
        { value: "bars", label: "Barras" },
        { value: "line", label: "Linha" },
        { value: "none", label: "Nenhum" },
      ],
    },
    { kind: "toggle", key: "compare", label: "Variação", description: "Compara com o período anterior de mesmo tamanho." },
    {
      kind: "choice",
      key: "format",
      label: "Formato",
      options: [
        { value: "compact", label: "Compacto (R$ 12,3 mil)" },
        { value: "full", label: "Completo (com centavos)" },
      ],
    },
  ];
  if (options.gross)
    out.push({
      kind: "choice",
      key: "value",
      label: "Valor",
      options: [
        { value: "net", label: "Líquido" },
        { value: "gross", label: "Bruto" },
      ],
    });
  out.push(refreshSetting);
  return out;
}

/**
 * Loads now, again every config.refresh minutes (default `minutes`), and about a second after
 * any setting changes (debounced so typing a key does not fire a request per keystroke). The period
 * is services/remote.ts's refreshLoop: it rests while the dock is covered, backs off after a failed
 * load (`failed`) and, while every quote shown is of a closed market (`closed`), waits an hour.
 */
export function poll<C extends object>(
  ctx: WidgetContext<C>,
  load: () => Promise<void>,
  minutes: number,
  options: { failed?: () => boolean; closed?: () => boolean } = {},
) {
  const signature = () => JSON.stringify(toRaw(ctx.config));
  let applied = signature();
  let settle: ReturnType<typeof setTimeout> | undefined;
  const period = () => {
    const ms = (Number((toRaw(ctx.config) as Record<string, unknown>).refresh) || minutes) * 60_000;
    return options.closed?.() ? Math.max(ms, 60 * 60_000) : ms;
  };
  const loop = refreshWidget(ctx, period, load, options.failed);
  // Settings are saved as they are typed: reload once they rest for a second.
  const off = onConfigSaved(() => {
    clearTimeout(settle);
    settle = setTimeout(() => {
      const sig = signature();
      if (sig === applied) return;
      applied = sig;
      void loop.now();
    }, 1000);
  });
  ctx.onDispose(() => {
    off();
    clearTimeout(settle);
  });
}

/** Deterministic, gently rising demo days for the gallery and keyless tiles (186 days, today last). */
export function demoDaily(base = 90, seed = 1, days = 186): number[] {
  return Array.from({ length: days }, (_, i) => Math.round(base * (0.75 + i / days / 2 + 0.25 * Math.sin(i * 1.7 + seed) ** 2)));
}

/** "Atualizar agora" handlers per widget state. */
export const refreshers = new WeakMap<object, () => Promise<void>>();

export function refreshItem(state: object, label = "Atualizar agora"): DockMenuItem {
  return { label, icon: "download", onSelect: () => void refreshers.get(toRaw(state))?.() };
}

/** The period's days for the chart; long periods are summed into at most 31 columns. */
export function chartValues(daily: readonly number[], period: Period) {
  const days = periodDays(daily, period);
  const k = Math.ceil(days.length / 31);
  if (k <= 1) return days;
  const out: number[] = [];
  for (let end = days.length; end > 0; end -= k) out.unshift(days.slice(Math.max(0, end - k), end).reduce((a, b) => a + b, 0));
  return out;
}

/** Daily columns scaled into width x height; today is drawn brighter. */
export function Bars(props: { values: readonly number[]; width: number; height: number; color: string }) {
  const { values, width, height, color } = props;
  const n = values.length;
  if (n === 0) return <View style={{ width, height }} />;
  const max = Math.max(...values, 0) || 1;
  const gap = n > 20 ? 1 : 2;
  const w = Math.max(1, (width - gap * (n - 1)) / n);
  return (
    <Svg width={width} height={height} viewBox={[0, 0, width, height]}>
      {values.map((v, i) => {
        const h = Math.max(1.5, (Math.max(0, v) / max) * height);
        return (
          <SvgRect
            x={i * (w + gap)}
            y={height - h}
            width={w}
            height={h}
            rx={Math.min(1.5, w / 2)}
            fill={color}
            fill-opacity={i === n - 1 ? 1 : 0.55}
            stroke="none"
          />
        );
      })}
    </Svg>
  );
}

/** Round brand mark with a letter. */
export function Badge(props: { color: string; letter: string }) {
  return (
    <View style={{ width: 14, height: 14, radius: 7, background: props.color, align: "center", justify: "center", shrink: 0 }}>
      <Text size={9} weight={800} color="#fff">
        {props.letter}
      </Text>
    </View>
  );
}

/** "demo" or the short error after a title. */
export function Status(props: { demo: boolean; error: string }) {
  if (props.error)
    return (
      <Text size={9} color={ui.danger}>
        {` ${props.error}`}
      </Text>
    );
  if (props.demo)
    return (
      <Text size={9} color={ui.faint}>
        {" demo"}
      </Text>
    );
  return null;
}

export function Delta(props: { value: number; digits?: number }) {
  const up = props.value >= 0;
  const v = Math.abs(props.value);
  return (
    <Text size={10} weight={700} color={up ? ui.green : ui.danger} style={{ ...numeric, flex: 1, textAlign: "right" }}>
      {`${up ? "▲" : "▼"} ${props.digits ? v.toFixed(props.digits).replace(".", ",") : Math.round(v)}%`}
    </Text>
  );
}

/** The chart of the period (bars, line or none) with the change vs the previous period, or the period name. */
export function Trend(props: { daily: readonly number[]; config: Pick<RevenueOptions, "period" | "chart" | "compare">; width?: number }) {
  const period = asPeriod(props.config.period);
  const chart = props.config.chart;
  const values = chartValues(props.daily, period);
  const delta = props.config.compare !== false ? periodChange(props.daily, period) : null;
  const width = props.width ?? 128;
  const label = (
    <Text size={10} color={ui.muted} style={{ flex: 1, textAlign: chart === "none" ? "left" : "right" }}>
      {periodLabels[period]}
    </Text>
  );
  return (
    <Row style={{ align: "end", gap: 6 }}>
      {chart === "none" ? (
        label
      ) : chart === "line" ? (
        <Sparkline values={values} width={width} height={20} color={ui.green} />
      ) : (
        <Bars values={values} width={width} height={18} color={ui.green} />
      )}
      {delta !== null ? <Delta value={delta} /> : chart === "none" ? null : label}
    </Row>
  );
}

/** Revenue in the display currency; on a failed rate it stays in the account currency. */
async function displayed(r: Revenue, target: string, gross: boolean): Promise<{ daily: number[]; currency: string }> {
  const values = gross && r.gross ? r.gross : r.daily;
  if (!target || target === "original" || target.toUpperCase() === r.currency.toUpperCase()) return { daily: values, currency: r.currency };
  try {
    const rate = await fxRate(r.currency, target);
    return { daily: values.map((v) => v * rate), currency: target };
  } catch {
    return { daily: values, currency: r.currency };
  }
}

// ---------- revenue providers ----------

export interface RevenueState {
  daily: number[];
  currency: string;
  demo: boolean;
  error: string;
}

interface RevenueSpec<C extends { label: string }> {
  type: string;
  name: string;
  description: string;
  brand: { color: string; letter: string };
  dashboard: string;
  defaultConfig: C;
  /** The provider's own settings (title, keys…); the display settings are appended. */
  settings: WidgetSetting<C>[];
  /** Cache prefix dropped by "Atualizar agora". */
  cacheKey: string;
  /** `days` of history ending today; null when the widget has no credentials yet (demo data). */
  load(config: C, days: number): Promise<Revenue> | null;
  /** Default chart. */
  chart?: "bars" | "line";
  /** The provider returns gross as well as net: offers "Valor". */
  gross?: boolean;
}

/** A provider tile: revenue of the chosen period, its chart and the change vs the period before. */
export function revenueWidget<C extends { label: string }>(spec: RevenueSpec<C>) {
  type Config = C & RevenueOptions;
  return defineWidget<Config, RevenueState>({
    type: spec.type,
    name: spec.name,
    description: spec.description,
    category: "finance",
    defaultConfig: { ...revenueDefaults, chart: spec.chart ?? "bars", ...spec.defaultConfig } as Config,
    settings: [...spec.settings, ...revenueSettings({ original: true, gross: !!spec.gross })] as unknown as WidgetSetting<Config>[],
    setup(ctx) {
      const state = store<RevenueState>({ daily: demoDaily(), currency: "usd", demo: true, error: "" });
      let seq = 0;
      const load = async () => {
        const id = ++seq;
        const c = ctx.config;
        const pending = spec.load(c, historyDays(asPeriod(c.period), c.compare !== false));
        try {
          const r: Revenue = pending ? await pending : { daily: demoDaily(), currency: "usd" };
          const shown = await displayed(r, c.currency, c.value === "gross");
          if (id === seq) Object.assign(state, shown, { demo: !pending, error: "" });
        } catch (error) {
          if (id === seq) state.error = errorText(error);
        }
      };
      refreshers.set(toRaw(state), () => {
        invalidate(spec.cacheKey);
        return load();
      });
      poll(ctx, load, 15, { failed: () => !!state.error });
      return state;
    },
    menu({ state }) {
      return [[refreshItem(state), { label: "Abrir painel", icon: "star", onSelect: () => launch(spec.dashboard) }]];
    },
    View({ state, ctx }) {
      const c = ctx.config;
      return (
        <Tile width={196} padding={{ left: 10, right: 10, top: 6, bottom: 4 }}>
          <Column style={{ flex: 1, gap: 2 }}>
            <Row style={{ align: "center", gap: 6 }}>
              <Badge {...spec.brand} />
              <Text size={11} weight={600} color={ui.text} style={{ flex: 1 }}>
                {String(c.label || spec.name)}
                <Status demo={state.demo} error={state.error} />
              </Text>
              <Text size={12} weight={700} color={ui.text} style={numeric}>
                {money(periodSum(state.daily, asPeriod(c.period)), state.currency, c.format === "full" ? "full" : "compact")}
              </Text>
            </Row>
            <Trend daily={state.daily} config={{ ...c, chart: c.chart || spec.chart || "bars" }} />
          </Column>
        </Tile>
      );
    },
  });
}

// ---------- markets ----------

export interface QuoteState extends Quote {
  demo: boolean;
  error: string;
}

/**
 * A price tile: symbol, price, change and a line. `currency` shows the price with its symbol
 * (used when it was converted to a display currency).
 */
export function QuoteTile(props: { title: string; state: QuoteState; color: string; letter: string; prefix?: string; currency?: string; digits?: number }) {
  const { state } = props;
  const up = state.change >= 0;
  return (
    <Tile width={176} padding={{ left: 10, right: 10, top: 6, bottom: 4 }}>
      <Column style={{ flex: 1, gap: 2 }}>
        <Row style={{ align: "center", gap: 6 }}>
          <Badge color={props.color} letter={props.letter} />
          <Text size={11} weight={600} color={ui.text} style={{ flex: 1 }}>
            {props.title}
            <Status demo={state.demo} error={state.error} />
          </Text>
          <Text size={12} weight={700} color={ui.text} style={numeric}>
            {props.currency ? priceIn(state.price, props.currency, props.digits) : `${props.prefix ?? ""}${price(state.price, props.digits)}`}
          </Text>
        </Row>
        <Row style={{ align: "end", gap: 6 }}>
          <Sparkline values={state.series} width={104} height={20} color={up ? ui.green : ui.danger} />
          <Delta value={state.change} digits={2} />
        </Row>
      </Column>
    </Tile>
  );
}

/** Polls `fetch` (every config.refresh minutes, and on setting changes) into a QuoteState that starts as demo. */
export function quoteSetup<C extends object>(
  ctx: WidgetContext<C>,
  demo: Quote,
  fetch: (config: C) => Promise<Quote>,
  cacheKey: (config: C) => string,
  minutes = 5,
) {
  const state = store<QuoteState>({ ...demo, demo: true, error: "" });
  let seq = 0;
  const load = async () => {
    const id = ++seq;
    try {
      const q = await fetch(ctx.config);
      if (id === seq) Object.assign(state, q, { demo: false, error: "" });
    } catch (error) {
      if (id === seq) state.error = errorText(error);
    }
  };
  refreshers.set(toRaw(state), () => {
    invalidate(cacheKey(ctx.config));
    return load();
  });
  poll(ctx, load, minutes, { failed: () => !!state.error, closed: () => !state.demo && !!state.closed });
  return state;
}

/** A smooth demo intraday line ending at `last`. */
export function demoSeries(last: number, n = 48, seed = 1) {
  return Array.from({ length: n }, (_, i) => last * (1 - 0.012 + 0.012 * (i / (n - 1)) + 0.004 * Math.sin(i * 0.6 + seed)));
}
