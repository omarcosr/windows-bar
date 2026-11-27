import { Column, Row, Svg, SvgRect, Text, View, store, toRaw, type Child } from "@tarve/core";
import type { DockMenuItem } from "../../../menu/dock-menu";
import { toggleChartPanel, type ChartSource, type PanelOption } from "../../../menu/chart-panel";
import { launch } from "../../../services/windows";
import { onConfigSaved } from "../../../config";
import { refreshWidget } from "../../../services/remote";
import {
  asCompareTo,
  asPeriod,
  compareSpan,
  compareSum,
  errorText,
  fxRate,
  historyDays,
  invalidate,
  money,
  periodChange,
  periodDays,
  periodLabels,
  periodSpan,
  periodSum,
  spanDays,
  type CompareTo,
  type MoneyFormat,
  type Point,
  price,
  priceIn,
  type Period,
  type Quote,
  type Revenue,
} from "../../../services/finance-providers";
import { numeric, ui } from "../../../theme";
import { Sparkline, Tile, compactView } from "../../ui";
import { BrandIcon, type BrandName } from "../../brand-icons";
import { defineWidget, type WidgetContext, type WidgetSetting } from "../../types";

import { t, language, formatDecimal } from "../../../i18n";
/**
 * Below 34 px (a 40–44 px bar) two rows do not fit the tile: the tiles put the change beside the
 * value on one row and leave the chart out (the tip still explains every number).
 */
export const oneRow = () => ui.tile.height < 34;

/** Title row of a two-row tile: the badge's height, so both rows fit inside the tile's border. */
export const TITLE_ROW = 14;
/**
 * Height left for the chart row: the tile minus its 1 px border on each side, the title row, the
 * 2 px gap and 1 px of air above and below (18 px fixed overflowed the 36 px tile by ~2 px and
 * the border clipped the badge and the line's last dot).
 */
export const chartRow = () => Math.max(10, Math.min(22, Math.floor(ui.tile.height - 2 - TITLE_ROW - 2 - 2)));

/**
 * A two-row tile's brand mark: on the left, centred on both rows (like an app icon beside its two
 * lines), not on the title row, where it sat at the top of the tile. One-row tiles keep it inline.
 */
export const BIG_BADGE = 22;

/** Two rows: the badge centred on the left and the rows beside it. One row: just the rows. */
export function BadgeRows(props: { color: string; letter: string; children: Child }) {
  if (oneRow())
    return <Column style={{ flex: 1, gap: 2, justify: "center", minWidth: 0 }}>{props.children}</Column>;
  return (
    <Row style={{ flex: 1, gap: 8, align: "center", minWidth: 0 }}>
      <Badge color={props.color} letter={props.letter} size={BIG_BADGE} />
      <Column style={{ flex: 1, gap: 2, justify: "center", minWidth: 0 }}>{props.children}</Column>
    </Row>
  );
}

/** The tile's title with its "demo" / error tag after it, on one baseline; it gives way (clips) before the value on its right. */
export function TileTitle(props: { text: string; demo: boolean; error: string }) {
  return (
    <Row style={{ flex: 1, align: "center", gap: 4, overflow: "hidden" }}>
      <Text size={11} weight={600} color={ui.text} style={{ shrink: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
        {props.text}
      </Text>
      <Status demo={props.demo} error={props.error} />
    </Row>
  );
}


// ---------- shared options ----------

const CURRENCY_NAMES: Record<string, string> = {
  BRL: t("widgets.finance.shared.brazilianReal"),
  USD: t("widgets.finance.shared.usDollar"),
  EUR: "Euro",
  GBP: "Libra esterlina",
  JPY: t("widgets.finance.shared.japaneseYen"),
  CAD: t("widgets.finance.shared.canadianDollar"),
  AUD: t("widgets.finance.shared.australianDollar"),
  CHF: t("widgets.finance.shared.swissFranc"),
  MXN: t("widgets.finance.shared.mexicanPeso"),
  ARS: t("widgets.finance.shared.argentinePeso"),
  CNY: "Yuan",
  INR: t("widgets.finance.shared.indianRupee"),
  KRW: t("widgets.finance.shared.southKoreanWon"),
  TRY: t("widgets.finance.shared.turkishLira"),
  ZAR: t("widgets.finance.shared.southAfricanRand"),
  SEK: t("widgets.finance.shared.swedishKrona"),
  NOK: t("widgets.finance.shared.norwegianKrone"),
  DKK: t("widgets.finance.shared.danishKrone"),
  PLN: "Złoty",
  NZD: t("widgets.finance.shared.newZealandDollar"),
  SGD: t("widgets.finance.shared.singaporeDollar"),
  HKD: t("widgets.finance.shared.hongKongDollar"),
};

/** Display currencies for revenue and quotes (all on open.er-api). */
export const DISPLAY_CURRENCIES = ["BRL", "USD", "EUR", "GBP", "JPY", "CAD", "AUD", "CHF", "MXN", "ARS"];

export const currencyOptions = (codes: readonly string[]) => codes.map((code) => ({ value: code, label: `${code} · ${CURRENCY_NAMES[code] ?? code}` }));

/** "Original" plus the display currencies. */
export const displayCurrencyOptions = (original = t("widgets.finance.shared.accountsOriginal")) => [{ value: "original", label: original }, ...currencyOptions(DISPLAY_CURRENCIES)];

/** "Atualizar a cada" (minutes as strings). */
export const refreshSetting = {
  kind: "choice" as const,
  key: "refresh" as const,
  label: t("widgets.finance.shared.refreshEvery"),
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
  /** "previous" | "year": what "Variação" compares with. */
  compareTo: string;
  /** "panel" | "site": what a left click opens. */
  click: string;
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
  compareTo: "previous",
  click: "panel",
  format: "compact",
  value: "net",
  refresh: "15",
};

const periodSetting = {
  kind: "choice" as const,
  key: "period" as const,
  label: t("widgets.finance.shared.period"),
  options: [
    { value: "7d", label: "7 dias" },
    { value: "30d", label: "30 dias" },
    { value: "month", label: t("widgets.finance.shared.currentMonth") },
    { value: "prevmonth", label: t("widgets.finance.shared.previousMonth") },
      { value: "90d", label: "90 dias" },
      { value: "365d", label: "12 meses" },
  ],
};

/** "Ao clicar": the chart panel (default) or the source's site, as the tiles did before the panel. */
export const clickSetting = {
kind: "choice" as const,
key: "click" as const,
label: t("widgets.finance.shared.onClick"),
options: [
  { value: "panel", label: t("widgets.finance.shared.openPanel") },
  { value: "site", label: t("widgets.finance.shared.openSourceWebsite") },
],
};

/** The tile's node id (its hover tip's id): the panel sits above it. */
export const tileAnchor = (ctx: { instanceId: string }) => `tip:${ctx.instanceId}`;

/** A chart tile's left click: the chart panel, or the source's site when "Ao clicar" says so. */
export function chartClick(click: unknown, url: string | undefined, source: () => ChartSource) {
return () => (click === "site" && url ? launch(url) : toggleChartPanel(source()));
}

/** "Abrir gráfico" and "Abrir site da fonte", for the right-click menu. */
export function chartMenu(source: () => ChartSource, url?: string): DockMenuItem[] {
const items: DockMenuItem[] = [{ label: t("widgets.finance.shared.openChart"), icon: { fluent: 0xe9d2 /* AreaChart */ }, onSelect: () => toggleChartPanel(source()) }];
if (url) items.push({ label: t("widgets.finance.shared.openSourceWebsite"), icon: "star", onSelect: () => launch(url) });
return items;
}

/** The revenue display settings; `original` offers "Original da conta", `gross` the Líquido/Bruto choice. */
export function revenueSettings(options: { original: boolean; gross: boolean; site?: boolean }): WidgetSetting<RevenueOptions>[] {
  const out: WidgetSetting<RevenueOptions>[] = [
    {
      kind: "choice",
      key: "currency",
      label: t("widgets.finance.shared.displayCurrency"),
      description: options.original ? t("widgets.finance.shared.convertsAtTodaysExchange") : t("widgets.finance.shared.providersAreConvertedAt"),
      options: options.original ? displayCurrencyOptions() : currencyOptions(DISPLAY_CURRENCIES),
    },
    periodSetting,
    {
      kind: "choice",
      key: "chart",
      label: t("widgets.finance.shared.chart"),
      options: [
        { value: "bars", label: t("widgets.finance.shared.bars") },
        { value: "line", label: t("widgets.finance.shared.line") },
        { value: "none", label: t("widgets.finance.shared.none") },
      ],
    },
    { kind: "toggle", key: "compare", label: t("widgets.finance.shared.change"), description: t("widgets.finance.shared.comparesTotalWithAnother") },
    {
      kind: "choice",
      key: "compareTo",
      label: t("widgets.finance.shared.compareWith"),
      options: [
        { value: "previous", label: t("widgets.finance.shared.previousPeriod") },
        { value: "year", label: t("widgets.finance.shared.samePeriodLastYear") },
      ],
      when: (c) => c.compare !== false,
    },
    {
      kind: "choice",
      key: "format",
      label: t("widgets.finance.shared.format"),
      options: [
        { value: "compact", label: "Compacto (R$ 12,3 mil)" },
        { value: "full", label: t("widgets.finance.shared.fullWithCents") },
      ],
    },
  ];
  if (options.site) out.push(clickSetting);
  if (options.gross)
    out.push({
      kind: "choice",
      key: "value",
      label: t("widgets.finance.shared.amount"),
      options: [
        { value: "net", label: t("widgets.finance.shared.net") },
        { value: "gross", label: t("widgets.finance.shared.gross") },
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

export function refreshItem(state: object, label = t("widgets.finance.shared.refreshNow")): DockMenuItem {
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

/**
 * Daily columns scaled into width x height; today is drawn brighter. `relative` scales from the
 * lowest value instead of zero (prices: a 2 % move would otherwise be invisible).
 */
export function Bars(props: { values: readonly number[]; width: number; height: number; color: string; relative?: boolean }) {
  const { width, height, color } = props;
  // At most one 1 px column + 1 px gap per 2 px: longer series keep each bucket's last value (prices) or its sum.
  const cap = Math.max(1, Math.floor((width + 1) / 2));
  let values = props.values;
  if (values.length > cap) {
    const k = Math.ceil(values.length / cap);
    const out: number[] = [];
    for (let end = values.length; end > 0; end -= k) {
      const chunk = values.slice(Math.max(0, end - k), end);
      out.unshift(props.relative ? chunk[chunk.length - 1]! : chunk.reduce((a, b) => a + b, 0));
    }
    values = out;
  }
  const n = values.length;
  if (n === 0) return <View style={{ width, height }} />;
  const max = Math.max(...values, 0) || 1;
  const floor = props.relative ? Math.min(...values) - (max - Math.min(...values)) * 0.15 : 0;
  const span = max - floor || 1;
  const gap = n > 20 ? 1 : 2;
  const w = Math.max(1, (width - gap * (n - 1)) / n);
  return (
    <Svg width={width} height={height} viewBox={[0, 0, width, height]}>
      {values.map((v, i) => {
        const h = Math.max(1.5, (Math.max(0, v - floor) / span) * height);
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

export type ChartKind = "line" | "bars" | "none";

/** "Gráfico": Linha | Barras | Nenhum. */
export const chartSetting = {
  kind: "choice" as const,
  key: "chart" as const,
  label: t("widgets.finance.shared.chart"),
  options: [
    { value: "line", label: t("widgets.finance.shared.line") },
    { value: "bars", label: t("widgets.finance.shared.bars") },
    { value: "none", label: t("widgets.finance.shared.none") },
  ],
};

export const asChart = (value: unknown, fallback: ChartKind = "line"): ChartKind =>
  value === "line" || value === "bars" || value === "none" ? value : fallback;

const dayFormat = new Intl.DateTimeFormat(language, { weekday: "short", day: "2-digit", month: "2-digit" });
const timeFormat = new Intl.DateTimeFormat(language, { hour: "2-digit", minute: "2-digit" });

/** "hoje", "ontem" or "seg., 12/05". */
export function dayLabel(ms: number) {
  const d = new Date(ms);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const day = new Date(d);
  day.setHours(0, 0, 0, 0);
  const diff = Math.round((today.getTime() - day.getTime()) / 86_400_000);
  return diff === 0 ? t("widgets.finance.shared.today") : diff === 1 ? t("widgets.finance.shared.yesterday") : dayFormat.format(d);
}

/** "hoje às 14:05", "ontem às 21:00", "seg., 12/05 às 09:30". */
export function momentLabel(ms: number) {
  return t("widgets.finance.shared.at", { p0: dayLabel(ms), p1: timeFormat.format(new Date(ms)) });
}

/** "▲ 1,34%" / "▼ 0,25%", as the tile shows it. */
export function changeText(value: number, digits = 2) {
  return `${value >= 0 ? "▲" : "▼"} ${formatDecimal(Math.abs(value), digits)}%`;
}

/** Round brand mark with a letter. */
export function Badge(props: { color: string; letter: string; size?: number }) {
  const size = props.size ?? 14;
  return (
    <View style={{ width: size, height: size, radius: size / 2, background: props.color, align: "center", justify: "center", shrink: 0 }}>
      <Text size={Math.round(size * 0.62)} weight={800} color="#fff" style={{ lineHeight: 1 }}>
        {props.letter}
      </Text>
    </View>
  );
}

/** "demo" or the short error after a title. */
export function Status(props: { demo: boolean; error: string }) {
  if (props.error)
    return (
      <Text size={10} color={ui.danger} style={{ shrink: 0 }}>
        {props.error}
      </Text>
    );
  if (props.demo)
    return (
      <Text size={10} color={ui.faint} style={{ shrink: 0 }}>
        {"demo"}
      </Text>
    );
  return null;
}

/** "▲ 1,34%" flush right in the room left (`inline`: just its own width, beside the value on one row). */
export function Delta(props: { value: number; digits?: number; inline?: boolean }) {
  const up = props.value >= 0;
  const v = Math.abs(props.value);
  return (
    // Flush right in whatever room is left (a flexed Text only grows to its own width).
    <View style={{ flex: props.inline ? undefined : 1, align: "end", shrink: 0 }}>
      <Text size={10} weight={700} color={up ? ui.green : ui.danger} style={numeric}>
        {`${up ? "▲" : "▼"} ${props.digits ? formatDecimal(v, props.digits) : Math.round(v)}%`}
      </Text>
    </View>
  );
}

/** The chart of the period (bars, line or none) with the change vs the previous period, or the period name. */
export function Trend(props: { daily: readonly number[]; config: Pick<RevenueOptions, "period" | "chart" | "compare" | "compareTo">; width?: number }) {
  const period = asPeriod(props.config.period);
  const chart = props.config.chart;
  const values = chartValues(props.daily, period);
  const delta = props.config.compare !== false ? periodChange(props.daily, period, asCompareTo(props.config.compareTo)) : null;
  const width = props.width ?? 128;
  const label = (
    <View style={{ flex: 1, align: chart === "none" ? "start" : "end" }}>
      <Text size={10} color={ui.muted}>
        {periodLabels[period]}
      </Text>
    </View>
  );
  return (
    <Row style={{ align: "center", gap: 6, height: chartRow() }}>
      {chart === "none" ? (
        label
      ) : chart === "line" ? (
        <Sparkline values={values} width={width} height={chartRow()} color={ui.green} />
      ) : (
        <Bars values={values} width={width} height={chartRow() - 2} color={ui.green} />
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
  /** The provider's own mark for the minimal tile of a side-edge dock (brand-icons.tsx). */
  logo?: BrandName;
  dashboard: string;
  /** Where the numbers come from, for the tip ("API do Stripe, transações do saldo"). */
  source?: string;
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
    settings: [...spec.settings, ...revenueSettings({ original: true, gross: !!spec.gross, site: true })] as unknown as WidgetSetting<Config>[],
    setup(ctx) {
      const state = store<RevenueState>({ daily: demoDaily(), currency: "usd", demo: true, error: "" });
      let seq = 0;
      const load = async () => {
        const id = ++seq;
        const c = ctx.config;
        const pending = spec.load(c, historyDays(asPeriod(c.period), c.compare !== false && asCompareTo(c.compareTo)));
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
    menu({ state, ctx }) {
      return [[refreshItem(state), ...chartMenu(() => providerSource(spec, ctx), spec.dashboard)]];
    },
    View({ state, ctx, preview }) {
      const c = ctx.config;
      const label = String(c.label || spec.name);
      const tip = () =>
        revenueTip({
          label,
          daily: state.daily,
          currency: state.currency,
          config: c,
          source: spec.source ?? t("widgets.finance.shared.api", { p0: spec.name.replace(/ \(.*\)$/, "") }),
          gross: spec.gross,
          demo: state.demo,
          error: state.error,
          click: c.click === "site" ? t("widgets.finance.shared.clickToOpenProviders") : t("widgets.finance.shared.clickToOpenChart"),
        });
      // Compact (side-edge column): the brand's badge over the period's total.
      if (compactView(preview))
        return (
          <Tile
            icon={spec.logo ? <BrandIcon brand={spec.logo} /> : <Badge {...spec.brand} size={ui.app.icon} />}
            value={money(periodSum(state.daily, asPeriod(c.period)), state.currency, "compact")}
            onClick={preview ? undefined : chartClick(c.click, spec.dashboard, () => providerSource(spec, ctx))}
            tip={{ id: `tip:${ctx.instanceId}`, lines: tip }}
            preview={preview}
          >
            <Badge {...spec.brand} size={BIG_BADGE} />
            <Text size={11} weight={700} color={ui.text} style={numeric}>
              {money(periodSum(state.daily, asPeriod(c.period)), state.currency, "compact")}
            </Text>
          </Tile>
        );
      return (
        <Tile width={oneRow() ? 196 : 210} lead={oneRow() ? undefined : "round"} onClick={preview ? undefined : chartClick(c.click, spec.dashboard, () => providerSource(spec, ctx))} tip={{ id: `tip:${ctx.instanceId}`, lines: tip }} preview={preview}>
          <BadgeRows {...spec.brand}>
            <Row style={{ align: "center", gap: 6, height: TITLE_ROW }}>
              {oneRow() ? <Badge {...spec.brand} /> : null}
              <TileTitle text={label} demo={state.demo} error={state.error} />
              {oneRow() && c.compare !== false && periodChange(state.daily, asPeriod(c.period), asCompareTo(c.compareTo)) !== null ? <Delta value={periodChange(state.daily, asPeriod(c.period), asCompareTo(c.compareTo))!} inline /> : null}
              <Text size={12} weight={700} color={ui.text} style={numeric}>
                {money(periodSum(state.daily, asPeriod(c.period)), state.currency, c.format === "full" ? "full" : "compact")}
              </Text>
            </Row>
            {oneRow() ? null : <Trend daily={state.daily} config={{ ...c, chart: c.chart || spec.chart || "bars" }} width={112} />}
          </BadgeRows>
        </Tile>
      );
    },
  });
}

// ---------- the chart panel of revenue tiles ----------

export const REVENUE_RANGES: readonly PanelOption[] = [
  { value: "7d", label: "7D" },
  { value: "30d", label: "30D" },
  { value: "month", label: t("widgets.finance.shared.currentMonth") },
  { value: "prevmonth", label: t("widgets.finance.shared.previousMonth") },
  { value: "90d", label: "90D" },
  { value: "365d", label: t("widgets.finance.shared.year") },
];

export const REVENUE_COMPARES: readonly PanelOption[] = [
  { value: "none", label: t("widgets.finance.shared.none") },
  { value: "previous", label: t("widgets.finance.shared.previousPeriod") },
  { value: "year", label: t("widgets.finance.shared.lastYear") },
];

const DAY = 86_400_000;

/** The local midnight `daysAgo` days before today. */
function dayAt(daysAgo: number) {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - daysAgo).getTime();
}

/** The days of a span as dated points (the span's own dates). */
function spanPoints(daily: readonly number[], span: readonly [number, number]): Point[] {
  const days = spanDays(daily, span);
  const first = span[1] + days.length - 1;
  return days.map((v, i) => ({ at: dayAt(first - i), v }));
}

/** A revenue tile's chart panel: daily amounts over the range, accumulated, and the span it is compared with. */
export function revenueSource(o: {
  key: string;
  anchor: string;
  title: string;
  brand: { color: string; letter: string };
  source: string;
  url?: string;
  config: Pick<RevenueOptions, "period" | "compare" | "compareTo" | "format">;
  save(): void;
  loadDaily(days: number): Promise<{ daily: number[]; currency: string; demo: boolean }>;
}): ChartSource {
  const c = o.config;
  const format: MoneyFormat = c.format === "full" ? "full" : "compact";
  const current = () => (c.compare === false ? "none" : asCompareTo(c.compareTo));
  return {
    key: o.key,
    anchor: o.anchor,
    title: o.title,
    brand: o.brand,
    mode: "sum",
    ranges: REVENUE_RANGES,
    range: asPeriod(c.period),
    compares: REVENUE_COMPARES,
    compare: current(),
    load: async (range) => {
      const period = asPeriod(range);
      const r = await o.loadDaily(historyDays(period, false));
      return { points: spanPoints(r.daily, periodSpan(period)), currency: r.currency, asOf: Date.now(), demo: r.demo };
    },
    loadCompare: async (range, compare) => {
      const period = asPeriod(range);
      const to: CompareTo = compare === "year" ? "year" : "previous";
      const r = await o.loadDaily(historyDays(period, to));
      const span = compareSpan(period, to);
      if (span[0] >= r.daily.length) return null;
      return { points: spanPoints(r.daily, span), currency: r.currency, asOf: dayAt(span[1]) + DAY - 1 };
    },
    format: (v, currency) => money(v, currency, format),
    source: o.source,
    url: o.url,
    apply: (range, compare) => {
      c.period = range;
      c.compare = compare !== "none";
      if (compare !== "none") c.compareTo = compare;
      o.save();
    },
    applied: () => ({ range: asPeriod(c.period), compare: current() }),
  };
}

/** A provider's days in the display currency, or demo days without credentials. */
async function revenueDaily<C extends { label: string }>(spec: RevenueSpec<C>, c: C & RevenueOptions, days: number) {
  const pending = spec.load(c, days);
  const r: Revenue = pending ? await pending : { daily: demoDaily(90, 1, days), currency: "usd" };
  return { ...(await displayed(r, c.currency, c.value === "gross")), demo: !pending };
}

function providerSource<C extends { label: string }>(spec: RevenueSpec<C>, ctx: WidgetContext<C & RevenueOptions>) {
  return revenueSource({
    key: ctx.instanceId,
    anchor: tileAnchor(ctx),
    title: String(ctx.config.label || spec.name),
    brand: spec.brand,
    source: spec.source ?? t("widgets.finance.shared.api", { p0: spec.name.replace(/ \(.*\)$/, "") }),
    url: spec.dashboard,
    config: ctx.config,
    save: () => ctx.save(),
    loadDaily: (days) => revenueDaily(spec, ctx.config, days),
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
export function QuoteTile(props: {
  title: string;
  state: QuoteState;
  color: string;
  letter: string;
  prefix?: string;
  currency?: string;
  digits?: number;
  chart?: ChartKind;
  /** False hides the change ("Variação: Nenhuma"). */
  delta?: boolean;
  /** What the change compares, shown where the chart would be when there is no chart ("desde ontem"). */
  caption?: string;
  /** What the hover tip says: source, period and what the change compares. */
  tip?: () => string[];
  tipId?: string;
  preview?: boolean;
  onClick?: () => void;
}) {
  const { state } = props;
  const up = state.change >= 0;
  const chart = props.chart ?? "line";
  const delta = props.delta !== false;
  const color = !delta ? ui.blue : up ? ui.green : ui.danger;
  const second = !oneRow() && (chart !== "none" || delta);
  // Compact (side-edge column): the badge, the price and the change under it.
  if (compactView(props.preview ?? false))
    return (
      <Tile
        icon={<Badge color={props.color} letter={props.letter} size={ui.app.icon} />}
        value={props.currency ? priceIn(state.price, props.currency, props.digits) : `${props.prefix ?? ""}${price(state.price, props.digits)}`}
        valueColor={delta ? color : undefined}
        onClick={props.onClick}
        tip={props.tip && props.tipId ? { id: props.tipId, lines: props.tip } : undefined}
        preview={props.preview}
      >
        <Badge color={props.color} letter={props.letter} size={BIG_BADGE} />
        <Text size={11} weight={700} color={ui.text} style={numeric}>
          {props.currency ? priceIn(state.price, props.currency, props.digits) : `${props.prefix ?? ""}${price(state.price, props.digits)}`}
        </Text>
        {delta ? (
          <Text size={9} weight={700} color={color} style={numeric}>
            {`${up ? "▲" : "▼"} ${formatDecimal(Math.abs(state.change), 1)}%`}
          </Text>
        ) : null}
      </Tile>
    );
  const tile = (
    <Tile width={oneRow() ? 176 : 190} lead={oneRow() ? undefined : "round"} onClick={props.onClick} tip={props.tip && props.tipId ? { id: props.tipId, lines: props.tip } : undefined} preview={props.preview}>
      <BadgeRows color={props.color} letter={props.letter}>
        <Row style={{ align: "center", gap: 6, height: TITLE_ROW }}>
          {oneRow() ? <Badge color={props.color} letter={props.letter} /> : null}
          <TileTitle text={props.title} demo={state.demo} error={state.error} />
          {oneRow() && delta ? <Delta value={state.change} digits={1} inline /> : null}
          <Text size={12} weight={700} color={ui.text} style={numeric}>
            {props.currency ? priceIn(state.price, props.currency, props.digits) : `${props.prefix ?? ""}${price(state.price, props.digits)}`}
          </Text>
        </Row>
        {second ? (
          <Row style={{ align: "center", gap: 6, height: chartRow() }}>
            {chart === "line" ? (
              <Sparkline values={state.series} width={delta ? 86 : 140} height={chartRow()} color={color} />
            ) : chart === "bars" ? (
              <Bars values={state.series} width={delta ? 86 : 140} height={chartRow() - 2} color={color} relative />
            ) : (
              <Text size={10} color={ui.muted}>
                {props.caption ?? ""}
              </Text>
            )}
            {delta ? <Delta value={state.change} digits={2} /> : null}
          </Row>
        ) : null}
      </BadgeRows>
    </Tile>
  );
  return tile;
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
const PERIOD_TEXT: Record<Period, { now: string; before: string }> = {
  "7d": { now: t("widgets.finance.shared.inLast7Days"), before: t("widgets.finance.shared.previous7Days") },
  "30d": { now: t("widgets.finance.shared.inLast30Days"), before: t("widgets.finance.shared.previous30Days") },
  month: { now: t("widgets.finance.shared.thisMonthSince1st"), before: t("widgets.finance.shared.sameDaysLastMonth") },
  prevmonth: { now: t("widgets.finance.shared.lastMonth"), before: t("widgets.finance.shared.monthBeforeIt") },
  "90d": { now: t("widgets.finance.shared.inLast90Days"), before: t("widgets.finance.shared.previous90Days") },
  "365d": { now: t("widgets.finance.shared.inLast12Months"), before: t("widgets.finance.shared.previous12Months") },
};

/**
 * The revenue tile's tip: what the total is, what the change compares, where it comes from.
 * "Stripe: US$ 3.605 líquidos nos últimos 30 dias" / "▲ 6% contra os 30 dias anteriores (US$ 3.401)".
 */
export function revenueTip(options: {
  label: string;
  daily: readonly number[];
  currency: string;
  config: Pick<RevenueOptions, "period" | "compare" | "compareTo" | "format" | "value">;
  source: string;
  gross?: boolean;
  demo: boolean;
  error: string;
  click?: string;
}): string[] {
  const period = asPeriod(options.config.period);
  const format = options.config.format === "full" ? "full" : "compact";
  const total = periodSum(options.daily, period);
  const kind = options.gross ? (options.config.value === "gross" ? " brutos" : t("widgets.finance.shared.net2")) : "";
  const lines = [`${options.label}: ${money(total, options.currency, format)}${kind} ${PERIOD_TEXT[period].now}`];
  const to = asCompareTo(options.config.compareTo);
  const change = options.config.compare !== false ? periodChange(options.daily, period, to) : null;
  if (change !== null) {
    const before = compareSum(options.daily, period, to);
    lines.push(t("widgets.finance.shared.vs", { p0: changeText(change, 1), p1: to === "year" ? t("widgets.finance.shared.samePeriodLastYear2") : PERIOD_TEXT[period].before, p2: money(before, options.currency, format) }));
  }
  if (options.error) lines.push(t("widgets.finance.shared.couldntRead", { error: options.error }));
  lines.push(options.demo ? t("widgets.finance.shared.sampleDataEnterKey", { source: options.source }) : t("widgets.finance.shared.source", { source: options.source }));
  if (options.click) lines.push(options.click);
  return lines;
}
