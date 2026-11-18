import { Pressable, Row, Text, store, toRaw } from "@tarve/core";
import { launch } from "../../../services/windows";
import { config } from "../../../config";
import { toggleChartPanel, type ChartSource, type PanelOption } from "../../../menu/chart-panel";
import {
  asCryptoWindow,
  asStockRange,
  convertQuote,
  cryptoHistory,
  cryptoQuote,
  errorText,
  fxHistory,
  fxHistoryBefore,
  fxSeries,
  invalidate,
  price,
  priceIn,
  stockHistory,
  stockQuote,
  type CryptoChange,
  type CryptoWindow,
  type FxChange,
  type FxWindow,
  type Quote,
  type StockChange,
  type StockRange,
} from "../../../services/finance-providers";
import { numeric, ui } from "../../../theme";
import { Tile } from "../../ui";
import { defineWidget } from "../../types";
import {
  QuoteTile,
  Status,
  asChart,
  changeText,
  chartClick,
  chartMenu,
  chartSetting,
  clickSetting,
  currencyOptions,
  dayLabel,
  demoSeries,
  displayCurrencyOptions,
  momentLabel,
  poll,
  quoteSetup,
  refreshItem,
  refreshSetting,
  refreshers,
  tileAnchor,
  type QuoteState,
} from "./shared";

/** The symbols other tiles of these types show, for "Comparar com" (up to 3, without `self`). */
function otherSymbols(types: readonly string[], self: string, of: (config: Record<string, unknown>) => string[]) {
  const out: string[] = [];
  for (const w of config.widgets) {
    if (!types.includes(w.type)) continue;
    for (const s of of((w.config ?? {}) as Record<string, unknown>)) if (s && s !== self && !out.includes(s)) out.push(s);
  }
  return out.slice(0, 3);
}

/** Where the tile's change follows the range ("window" or none), the range the tile shows; else none. */
const appliedRange = (change: unknown, range: unknown) => ({ range: change === "window" || change === "none" ? String(range) : "" });

/** The price's currency when it was converted to the chosen display currency, else undefined (plain number). */
function shownCurrency(display: string, state: { currency: string }) {
  return display && display !== "original" && state.currency.toUpperCase() === display.toUpperCase() ? display : undefined;
}

/** "351,91" or "R$ 5,78", for the tips. */
const amountText = (value: number, currency?: string, digits?: number) => (currency ? priceIn(value, currency, digits) : price(value, digits));

/** The source line of a market tip: where the numbers come from, or why they are samples. */
const sourceLine = (state: QuoteState, source: string) =>
  state.demo ? `Dados de exemplo (${source.split(",")[0]} ainda não respondeu)` : state.error ? `${source.split(",")[0]}: ${state.error}` : `Fonte: ${source}`;

// ---------- crypto ----------

const QUOTE_ASSETS = ["USDT", "USDC", "FDUSD", "BRL", "EUR", "TRY", "BTC", "ETH", "BNB"];
const QUOTE_SUFFIX = new RegExp(`^([A-Z0-9]{2,}?)(${QUOTE_ASSETS.join("|")})$`);

const baseOf = (symbol: string) => String(symbol || "BTC").toUpperCase().replace(/[^A-Z0-9]/g, "") || "BTC";
const pairOf = (c: { symbol: string; quote: string }) => `${baseOf(c.symbol)}${String(c.quote || "USDT").toUpperCase()}`;

const CRYPTO_WINDOWS: Record<string, string> = {
  "24h": "últimas 24 h (velas de 1 h)",
  "7d": "últimos 7 dias (velas de 4 h)",
  "30d": "últimos 30 dias (velas de 12 h)",
  "90d": "últimos 3 meses (velas de 1 dia)",
  "180d": "últimos 6 meses (velas de 1 dia)",
  "1y": "último ano (velas de 3 dias)",
  "5y": "últimos 5 anos (velas semanais)",
};

/** The chart panel's ranges for crypto (Binance trades every day: 7 days rather than 5 business days). */
const CRYPTO_RANGES: readonly PanelOption[] = [
  { value: "24h", label: "1D" },
  { value: "7d", label: "7D" },
  { value: "30d", label: "1M" },
  { value: "90d", label: "3M" },
  { value: "180d", label: "6M" },
  { value: "1y", label: "1A" },
  { value: "5y", label: "5A" },
];

const CRYPTO_SPAN: Record<string, string> = { "24h": "24 h", "7d": "7 dias", "30d": "30 dias", "90d": "3 meses", "180d": "6 meses", "1y": "1 ano", "5y": "5 anos" };

/** A typed symbol as a Binance pair: ETH with the tile's quote asset, or a whole pair as typed. */
function pairFrom(text: string, quote: string) {
  const t = text.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return QUOTE_SUFFIX.test(t) ? t : `${t}${quote}`;
}

type CryptoConfig = { symbol: string; quote: string; window: string; change: string; chart: string; click: string; refresh: string };

export function cryptoSource(ctx: { instanceId: string; config: CryptoConfig; save(): void }): ChartSource {
  const c = ctx.config;
  const base = baseOf(c.symbol);
  const quote = String(c.quote || "USDT").toUpperCase();
  const pair = pairOf(c);
  let others = otherSymbols(["finance-crypto"], pair, (w) => [pairOf(w as { symbol: string; quote: string })]);
  if (others.length === 0) others = [`BTC${quote}`, `ETH${quote}`].filter((p) => p !== pair);
  return {
    key: ctx.instanceId,
    anchor: tileAnchor(ctx),
    title: `${base}/${quote}`,
    brand: { color: "#f0b90b", letter: base.slice(0, 1) },
    mode: "price",
    ranges: CRYPTO_RANGES,
    range: asCryptoWindow(c.window),
    compares: [{ value: "none", label: "Nenhum" }, ...others.map((p) => ({ value: `sym:${p}`, label: p.endsWith(quote) ? p.slice(0, -quote.length) : p }))],
    compare: "none",
    symbolInput: "Outra: SOL",
    intraday: (r) => r === "24h" || r === "7d" || r === "30d",
    load: (r) => cryptoHistory(pair, asCryptoWindow(r)),
    loadCompare: async (r, compare) => (compare.startsWith("sym:") ? cryptoHistory(pairFrom(compare.slice(4), quote), asCryptoWindow(r)) : null),
    format: (v) => `${price(v)} ${quote}`,
    source: "Binance, fechamento de cada vela",
    url: binanceUrl(c),
    apply: (r) => {
      c.window = r;
      if (c.change !== "none") c.change = "window";
      ctx.save();
    },
    applied: () => appliedRange(c.change, asCryptoWindow(c.window)),
  };
}

function binanceUrl(c: { symbol: string; quote: string }) {
  return `https://www.binance.com/pt-BR/trade/${baseOf(c.symbol)}_${String(c.quote || "USDT").toUpperCase()}`;
}

export const crypto = defineWidget<CryptoConfig, QuoteState>({
  type: "finance-crypto",
  name: "Cripto",
  description: "Preço de uma cripto na Binance, na moeda de cotação escolhida, com variação e gráfico. Sem chave.",
  category: "finance",
  defaultConfig: { symbol: "BTC", quote: "USDT", window: "24h", change: "24h", chart: "line", click: "panel", refresh: "5" },
  settings: [
    { kind: "text", key: "symbol", label: "Cripto", description: "Código da moeda: BTC, ETH, SOL…", placeholder: "BTC" },
    {
      kind: "choice",
      key: "quote",
      label: "Moeda de cotação",
      description: "Forma o par da Binance (BTC + USDT = BTCUSDT).",
      options: QUOTE_ASSETS.map((q) => ({ value: q, label: q })),
    },
    {
      kind: "choice",
      key: "change",
      label: "Variação",
      options: [
        { value: "24h", label: "Últimas 24 h" },
        { value: "window", label: "Desde o início do gráfico" },
        { value: "none", label: "Nenhuma" },
      ],
    },
    chartSetting,
    {
      kind: "choice",
      key: "window",
      label: "Janela do gráfico",
      options: CRYPTO_RANGES.map((r) => ({ value: r.value, label: CRYPTO_SPAN[r.value]! })),
        when: (c) => c.chart !== "none" || c.change === "window",
      },
      clickSetting,
      refreshSetting,
  ],
  setup(ctx) {
    // Older instances saved the whole pair (BTCUSDT) in `symbol`: split it once.
    const old = QUOTE_SUFFIX.exec(String(ctx.config.symbol || "").toUpperCase());
    if (old) {
      ctx.config.symbol = old[1]!;
      ctx.config.quote = old[2]!;
      ctx.save();
    }
    return quoteSetup(
      ctx,
      { price: 64_850, change: 1.84, series: demoSeries(64_850, 24), currency: "USDT", reference: 63_678, referenceAt: Date.now() - 86_400_000 },
      (c) => cryptoQuote(pairOf(c), asCryptoWindow(c.window), (c.change as CryptoChange) || "24h"),
      (c) => `binance:${pairOf(c)}:`,
    );
  },
  menu: ({ state, ctx }) => [[refreshItem(state), ...chartMenu(() => cryptoSource(ctx), binanceUrl(ctx.config))]],
  View({ state, ctx, preview }) {
    const c = ctx.config;
    const base = baseOf(c.symbol);
    const quote = String(c.quote || "USDT").toUpperCase();
    const change = (c.change as CryptoChange) || "24h";
    const window = CRYPTO_WINDOWS[c.window] ?? CRYPTO_WINDOWS["24h"]!;
    const tip = () => {
      const lines = [`${base}/${quote}: ${price(state.price)} ${quote}`];
      if (change !== "none" && state.reference)
        lines.push(
          `${changeText(state.change)} ${change === "24h" ? "nas últimas 24 h" : `desde o início do gráfico (${window.split(" (")[0]})`}, de ${price(state.reference)}${state.referenceAt ? ` (${momentLabel(state.referenceAt)})` : ""}`,
        );
      if (c.chart !== "none") lines.push(`Gráfico: ${window}`);
      lines.push(sourceLine(state, "Binance, preço da última negociação"), c.click === "site" ? "Clique para abrir na Binance" : "Clique para abrir o gráfico");
      return lines;
    };
    return (
      <QuoteTile
        title={base}
        state={state}
        color="#f0b90b"
        letter={base.slice(0, 1)}
        chart={asChart(c.chart)}
        delta={change !== "none"}
        caption={change === "24h" ? "em 24 h" : `em ${CRYPTO_SPAN[asCryptoWindow(c.window)]}`}
        tip={tip}
        tipId={`tip:${ctx.instanceId}`}
        preview={preview}
        onClick={preview ? undefined : chartClick(c.click, binanceUrl(c), () => cryptoSource(ctx))}
      />
    );
  },
});

// ---------- stocks ----------

const RANGE_LABELS: Record<string, string> = { "1d": "o pregão de hoje", "5d": "5 dias", "1mo": "1 mês", "3mo": "3 meses", "6mo": "6 meses", "1y": "1 ano", "5y": "5 anos" };

/** The chart panel's ranges for stocks (Yahoo's own ranges). */
const STOCK_RANGES: readonly PanelOption[] = [
  { value: "1d", label: "1D" },
  { value: "5d", label: "5D" },
  { value: "1mo", label: "1M" },
  { value: "3mo", label: "3M" },
  { value: "6mo", label: "6M" },
  { value: "1y", label: "1A" },
  { value: "5y", label: "5A" },
];

/** The chart panel of one ticker; `apply` saves the range into the tile. */
function stockSource(o: { key: string; anchor: string; ticker: string; range: string; apply(range: string): void; applied(): { range: string } }): ChartSource {
  const t = o.ticker.toUpperCase();
  const others = otherSymbols(["finance-stock", "finance-watchlist"], t, (w) => (typeof w.tickers === "string" ? tickersOf(w.tickers) : [String(w.ticker || "AAPL").trim().toUpperCase()]));
  return {
    key: o.key,
    anchor: o.anchor,
    title: t,
    brand: { color: "#7b5cff", letter: t.replace(/^\^/, "").slice(0, 1) },
    mode: "price",
    ranges: STOCK_RANGES,
    range: asStockRange(o.range),
    compares: [{ value: "none", label: "Nenhum" }, ...others.map((s) => ({ value: `sym:${s}`, label: s.replace(/\.SA$/, "") }))],
    compare: "none",
    symbolInput: "Outro: MSFT",
    intraday: (r) => r === "1d" || r === "5d" || r === "1mo",
    load: (r) => stockHistory(t, asStockRange(r)),
    loadCompare: async (r, compare) => (compare.startsWith("sym:") ? stockHistory(compare.slice(4), asStockRange(r)) : null),
    format: (v, currency) => amountText(v, currency),
    source: "Yahoo Finance, pode atrasar até 15 min",
    url: yahooUrl(t),
    apply: o.apply,
    applied: o.applied,
  };
}

const rangeSetting = {
  kind: "choice" as const,
  key: "range" as const,
  label: "Janela",
  options: [
    { value: "1d", label: "1 dia" },
    { value: "5d", label: "5 dias" },
    { value: "1mo", label: "1 mês" },
    { value: "3mo", label: "3 meses" },
      { value: "6mo", label: "6 meses" },
      { value: "1y", label: "1 ano" },
    { value: "5y", label: "5 anos" },
  ],
};

const changeSetting = {
  kind: "choice" as const,
  key: "change" as const,
  label: "Variação",
  options: [
    { value: "day", label: "Desde o fechamento anterior" },
    { value: "window", label: "Desde o início da janela" },
    { value: "none", label: "Nenhuma" },
  ],
};

const displaySetting = {
  kind: "choice" as const,
  key: "display" as const,
  label: "Moeda de exibição",
  description: "Converte pelo câmbio do dia; sem câmbio mostra a moeda da bolsa.",
  options: displayCurrencyOptions("Original da bolsa"),
};

/** The Yahoo change mode; "none" still reads the day (the tile hides it). */
const stockChange = (value: string): StockChange => (value === "window" ? "window" : "day");

/** "▼ 0,47% desde o fechamento anterior (US$ 352,79)". */
function stockChangeLine(q: Quote, change: string, range: string, currency?: string) {
  if (change === "none" || !q.reference) return "";
  const since = change === "window" && range !== "1d" ? `desde o início da janela de ${RANGE_LABELS[range] ?? range}` : "desde o fechamento anterior";
  return `${changeText(q.change)} ${since} (${amountText(q.reference, currency)})`;
}

const yahooUrl = (ticker: string) => `https://finance.yahoo.com/quote/${encodeURIComponent(ticker)}`;

export const stockChart = defineWidget<{ ticker: string; range: string; display: string; change: string; chart: string; click: string; refresh: string }, QuoteState>({
  type: "finance-stock",
  name: "Ação (gráfico)",
  description: "Cotação de uma ação ou ETF (Yahoo Finance) com variação e gráfico. Sem chave.",
  category: "finance",
  defaultConfig: { ticker: "AAPL", range: "1d", display: "original", change: "day", chart: "line", click: "panel", refresh: "5" },
  settings: [
    { kind: "text", key: "ticker", label: "Ticker", description: "Formato do Yahoo: AAPL, PETR4.SA, ^BVSP.", placeholder: "AAPL" },
    displaySetting,
    changeSetting,
    chartSetting,
    { ...rangeSetting, when: (c) => c.chart !== "none" || c.change === "window" },
    clickSetting,
    refreshSetting,
  ],
  setup: (ctx) =>
    quoteSetup(
      ctx,
      { price: 351.13, change: -0.47, series: demoSeries(351.13, 48, 2), currency: "USD", reference: 352.79 },
      async (c) => convertQuote(await stockQuote(c.ticker || "AAPL", asStockRange(c.range), stockChange(c.change)), c.display),
      (c) => `yahoo:${String(c.ticker || "AAPL").trim().toUpperCase()}:`,
    ),
  menu: ({ state, ctx }) => [[refreshItem(state), ...chartMenu(() => singleStockSource(ctx), yahooUrl(String(ctx.config.ticker || "AAPL")))]],
  View({ state, ctx, preview }) {
    const c = ctx.config;
    const ticker = String(c.ticker || "AAPL").toUpperCase();
    const currency = shownCurrency(c.display, state);
    const tip = () => {
      const lines = [`${ticker}${state.name ? ` (${state.name})` : ""}: ${amountText(state.price, currency ?? state.currency)}`];
      const change = stockChangeLine(state, c.change, c.range, currency ?? state.currency);
      if (change) lines.push(change);
      if (state.closed) lines.push("Mercado fechado: preço do último pregão");
      if (c.chart !== "none") lines.push(`Gráfico: ${RANGE_LABELS[c.range] ?? "o pregão de hoje"}`);
      if (currency) lines.push(`Convertido para ${currency} pelo câmbio do dia (open.er-api.com)`);
      lines.push(sourceLine(state, "Yahoo Finance, pode atrasar até 15 min"), c.click === "site" ? "Clique para abrir no Yahoo Finance" : "Clique para abrir o gráfico");
      return lines;
    };
    return (
      <QuoteTile
        title={ticker.replace(/\.SA$/, "")}
        state={state}
        color="#7b5cff"
        letter={ticker.replace(/^\^/, "").slice(0, 1)}
        currency={currency}
        chart={asChart(c.chart)}
        delta={c.change !== "none"}
        caption={c.change === "window" && c.range !== "1d" ? `em ${RANGE_LABELS[c.range] ?? c.range}` : "desde o fechamento"}
        tip={tip}
        tipId={`tip:${ctx.instanceId}`}
        preview={preview}
        onClick={preview ? undefined : chartClick(c.click, yahooUrl(ticker), () => singleStockSource(ctx))}
      />
    );
  },
});

export function singleStockSource(ctx: { instanceId: string; config: { ticker: string; range: string; change: string }; save(): void }) {
  const c = ctx.config;
  return stockSource({
    key: ctx.instanceId,
    anchor: tileAnchor(ctx),
    ticker: String(c.ticker || "AAPL").trim(),
    range: c.range,
    apply: (r) => {
      c.range = r;
      if (c.change !== "none") c.change = "window";
      ctx.save();
    },
    applied: () => appliedRange(c.change, asStockRange(c.range)),
  });
}

interface WatchState {
  quotes: Record<string, Quote>;
  demo: boolean;
  error: string;
}

const tickersOf = (text: string) =>
  text
    .split(/[,;\s]+/)
    .map((t) => t.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 4);

const DEMO_WATCH: Record<string, Quote> = {
  AAPL: { price: 351.13, change: -0.47, series: [], currency: "USD", reference: 352.79 },
  MSFT: { price: 512.4, change: 0.82, series: [], currency: "USD", reference: 508.23 },
  NVDA: { price: 188.27, change: 2.15, series: [], currency: "USD", reference: 184.31 },
};

type WatchConfig = { tickers: string; display: string; change: string; range: string; click: string; refresh: string };

/** One ticker of the watchlist: its own panel, above its own column. */
function watchSource(ctx: { instanceId: string; config: WatchConfig; save(): void }, ticker: string) {
  const c = ctx.config;
  return stockSource({
    key: `${ctx.instanceId}:${ticker}`,
    anchor: `${tileAnchor(ctx)}:${ticker}`,
    ticker,
    range: c.change === "window" ? c.range : "1d",
    apply: (r) => {
      c.range = r;
      if (c.change !== "none") c.change = "window";
      ctx.save();
    },
    applied: () => appliedRange(c.change, c.change === "window" ? asStockRange(c.range) : "1d"),
  });
}

const toggleWatch = (ctx: { instanceId: string; config: WatchConfig; save(): void }, ticker: string) => toggleChartPanel(watchSource(ctx, ticker));

export const watchlist = defineWidget<WatchConfig, WatchState>({
  type: "finance-watchlist",
  name: "Lista de ações",
  description: "Até 4 tickers lado a lado com preço e variação (Yahoo Finance). Sem chave.",
  category: "finance",
  defaultConfig: { tickers: "AAPL, MSFT, NVDA", display: "original", change: "day", range: "5d", click: "panel", refresh: "5" },
  settings: [
    { kind: "text", key: "tickers", label: "Tickers", description: "Separados por vírgula, até 4 (ex.: PETR4.SA, VALE3.SA).", placeholder: "AAPL, MSFT, NVDA" },
    displaySetting,
    changeSetting,
    { ...rangeSetting, label: "Janela da variação", when: (c) => c.change === "window" },
    clickSetting,
    refreshSetting,
  ],
  setup(ctx) {
    const state = store<WatchState>({ quotes: DEMO_WATCH, demo: true, error: "" });
    let seq = 0;
    const load = async () => {
      const id = ++seq;
      const c = ctx.config;
      const tickers = tickersOf(String(c.tickers || ""));
      if (tickers.length === 0) return;
      const change = stockChange(c.change);
      const range: StockRange = change === "window" ? asStockRange(c.range || "5d") : "1d";
      const results = await Promise.allSettled(tickers.map(async (t) => convertQuote(await stockQuote(t, range, change), c.display)));
      if (id !== seq) return;
      const quotes: Record<string, Quote> = {};
      let error: unknown;
      results.forEach((r, i) => {
        if (r.status === "fulfilled") quotes[tickers[i]!] = r.value;
        else error ??= r.reason;
      });
      if (Object.keys(quotes).length === 0) {
        state.error = errorText(error);
        return;
      }
      Object.assign(state, { quotes, demo: false, error: error ? errorText(error) : "" });
    };
    refreshers.set(toRaw(state), () => {
      invalidate("yahoo:");
      return load();
    });
    poll(ctx, load, 5, { failed: () => !!state.error });
    return state;
  },
  menu: ({ state, ctx }) => [
    tickersOf(String(ctx.config.tickers || "")).flatMap((t) => [
        { label: `Abrir gráfico de ${t}`, icon: { fluent: 0xe9d2 }, onSelect: () => toggleWatch(ctx, t) },
        { label: `Abrir site da fonte (${t})`, icon: "star", onSelect: () => launch(yahooUrl(t)) },
    ]),
    [refreshItem(state)],
  ],
  View({ state, ctx, preview }) {
    const c = ctx.config;
    const configured = tickersOf(String(c.tickers || ""));
    const tickers = state.demo ? Object.keys(DEMO_WATCH) : configured.filter((t) => state.quotes[t]);
    const showChange = c.change !== "none";
    const tip = () => [
      ...tickers.map((t) => {
        const q = state.quotes[t]!;
        const currency = shownCurrency(c.display, q) ?? q.currency;
        const change = stockChangeLine(q, c.change, c.range, currency);
        return `${t}: ${amountText(q.price, currency)}${change ? ` · ${change}` : ""}${q.closed ? " · mercado fechado" : ""}`;
      }),
      state.demo ? "Dados de exemplo (Yahoo Finance ainda não respondeu)" : "Fonte: Yahoo Finance, pode atrasar até 15 min",
      c.click === "site" ? "Clique num ticker para abrir no Yahoo Finance" : "Clique num ticker para abrir o gráfico dele",
    ];
    return (
      <Tile gap={4} tip={{ id: tileAnchor(ctx), lines: tip }} preview={preview}>
        {tickers.map((t) => {
          const q = state.quotes[t]!;
          const up = q.change >= 0;
          const currency = shownCurrency(c.display, q);
          return (
            <Pressable
              id={`${tileAnchor(ctx)}:${t}`}
              focusable={false}
              onClick={preview ? undefined : chartClick(c.click, yahooUrl(t), () => watchSource(ctx, t))}
              style={{
                direction: "column",
                gap: 0,
                minWidth: 62,
                padding: { left: 4, right: 4, top: 1, bottom: 1 },
                radius: 4,
                cursor: preview ? "default" : "pointer",
                hover: preview ? undefined : { background: "rgba(255,255,255,0.07)" },
              }}
            >
              <Row style={{ align: "center", gap: 4 }}>
                <Text size={10} weight={700} color={ui.muted} style={{ flex: 1, lineHeight: 1.15 }}>
                  {t.replace(/\.SA$/, "")}
                </Text>
                {showChange ? (
                  <Text size={10} weight={700} color={up ? ui.green : ui.danger} style={{ ...numeric, lineHeight: 1.15 }}>
                    {`${up ? "+" : "−"}${Math.abs(q.change).toFixed(1).replace(".", ",")}%`}
                  </Text>
                ) : null}
              </Row>
              <Text size={12} weight={700} color={ui.text} style={{ ...numeric, lineHeight: 1.15 }}>
                {currency ? priceIn(q.price, currency) : price(q.price)}
              </Text>
            </Pressable>
          );
        })}
        {tickers.length === 0 || state.demo ? <Status demo={state.demo} error={state.error} /> : null}
      </Tile>
    );
  },
});

// ---------- currency ----------

/** Currencies Frankfurter (ECB) publishes: price, change and chart all come from it. */
const FX_CODES = ["BRL", "USD", "EUR", "GBP", "JPY", "CAD", "AUD", "CHF", "MXN", "CNY", "INR", "KRW", "TRY", "ZAR", "SEK", "NOK", "DKK", "PLN", "NZD", "SGD", "HKD"];

const amountOf = (text: string) => {
  const n = Number(String(text || "1").replace(/\s/g, "").replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : 1;
};

const FX_CHANGE_TEXT: Record<FxChange, string> = { close: "desde o fechamento anterior", "7d": "em 7 dias", "30d": "em 30 dias", window: "desde o início do gráfico", none: "" };
const FX_WINDOW_TEXT: Record<FxWindow, string> = { "1w": "1 semana", "1m": "1 mês", "3m": "3 meses", "6m": "6 meses", "1y": "1 ano", "5y": "5 anos" };

const asFxChange = (v: unknown): FxChange => (v === "7d" || v === "30d" || v === "window" || v === "none" ? v : "close");
const asFxWindow = (v: unknown): FxWindow => (typeof v === "string" && v in FX_WINDOW_TEXT ? (v as FxWindow) : "1m");

/** The chart panel's ranges for currencies (Frankfurter's time series, one fix per business day). */
const FX_RANGES: readonly PanelOption[] = [
  { value: "1w", label: "1S" },
  { value: "1m", label: "1M" },
  { value: "3m", label: "3M" },
  { value: "6m", label: "6M" },
  { value: "1y", label: "1A" },
  { value: "5y", label: "5A" },
];

const FX_COMPARES: readonly PanelOption[] = [
  { value: "none", label: "Nenhum" },
  { value: "previous", label: "Período anterior" },
  { value: "year", label: "Ano passado" },
];

export function currencySource(ctx: { instanceId: string; config: CurrencyConfig; save(): void }): ChartSource {
  const c = ctx.config;
  const [from, to] = pairShown(c);
  const digits = c.decimals === "auto" || !c.decimals ? undefined : Number(c.decimals);
  return {
    key: ctx.instanceId,
    anchor: tileAnchor(ctx),
    title: `${from}/${to}`,
    brand: { color: "#0a84ff", letter: from === "USD" ? "$" : from === "EUR" ? "€" : from === "GBP" ? "£" : from.slice(0, 1) },
    mode: "price",
    ranges: FX_RANGES,
    range: asFxWindow(c.window),
    compares: FX_COMPARES,
    compare: "none",
    load: (r) => fxHistory(from, to, asFxWindow(r)),
    loadCompare: async (r, compare) => (compare === "none" ? null : fxHistoryBefore(from, to, asFxWindow(r), compare === "year" ? "year" : "previous")),
    format: (v) => priceIn(v, to, digits ?? (Math.abs(v) < 10 ? 4 : 2)),
    source: "BCE via Frankfurter, 1 ponto por dia útil",
    url: googleFxUrl(c),
    apply: (r) => {
      c.window = r;
      if (c.change !== "none") c.change = "window";
      ctx.save();
    },
    applied: () => appliedRange(c.change, asFxWindow(c.window)),
  };
}

type CurrencyConfig = {
  from: string;
  to: string;
  amount: string;
  show: string;
  invert: boolean;
  change: string;
  chart: string;
  window: string;
  decimals: string;
  click: string;
  refresh: string;
};

/** The pair as shown, [base, quote], after "Inverter par". */
function pairShown(c: CurrencyConfig): [string, string] {
  const from = String(c.from || "USD").toUpperCase();
  const to = String(c.to || "BRL").toUpperCase();
  return c.invert ? [to, from] : [from, to];
}

function googleFxUrl(c: CurrencyConfig) {
  const [a, b] = pairShown(c);
  return `https://www.google.com/finance/quote/${a}-${b}`;
}

const DAY = 86_400_000;

export const currency = defineWidget<CurrencyConfig, QuoteState>({
  type: "finance-currency",
  name: "Câmbio",
  description: "Cotação de referência do Banco Central Europeu entre duas moedas, com variação e gráfico. Sem chave.",
  category: "finance",
  defaultConfig: { from: "USD", to: "BRL", amount: "1", show: "", invert: false, change: "close", chart: "line", window: "1m", decimals: "auto", click: "panel", refresh: "60" },
  settings: [
    { kind: "choice", key: "from", label: "De", options: currencyOptions(FX_CODES) },
    { kind: "choice", key: "to", label: "Para", options: currencyOptions(FX_CODES) },
    { kind: "toggle", key: "invert", label: "Inverter par", description: "Quanto vale 1 da segunda moeda na primeira (BRL/USD em vez de USD/BRL)." },
    {
      kind: "choice",
      key: "show",
      label: "Mostrar",
      options: [
        { value: "rate", label: "Cotação" },
        { value: "amount", label: "Valor convertido" },
      ],
    },
    { kind: "text", key: "amount", label: "Valor", description: "Quanto converter.", placeholder: "100", when: (c) => c.show === "amount" },
    {
      kind: "choice",
      key: "change",
      label: "Variação",
      description: "Tudo vem da cotação de referência do BCE, publicada uma vez por dia útil (por volta das 16h de Frankfurt).",
      options: [
        { value: "close", label: "Desde o fechamento anterior" },
        { value: "7d", label: "7 dias" },
        { value: "30d", label: "30 dias" },
        { value: "window", label: "Desde o início do gráfico" },
          { value: "none", label: "Nenhuma" },
        ],
    },
    chartSetting,
      {
      kind: "choice",
      key: "window",
      label: "Janela do gráfico",
        options: FX_RANGES.map((r) => ({ value: r.value, label: FX_WINDOW_TEXT[r.value as FxWindow] })),
        when: (c) => c.chart !== "none" || c.change === "window",
      },
    {
      kind: "choice",
      key: "decimals",
      label: "Casas decimais",
      options: [
        { value: "auto", label: "Automático" },
        { value: "0", label: "0" },
        { value: "2", label: "2" },
        { value: "4", label: "4" },
      ],
    },
    clickSetting,
    refreshSetting,
  ],
  setup(ctx) {
    // Before "Mostrar" existed, a value other than 1 meant the converted value.
    if (!ctx.config.show) ctx.config.show = amountOf(ctx.config.amount) === 1 ? "rate" : "amount";
    return quoteSetup(
      ctx,
      {
        price: 5.78,
        change: 0.42,
        series: [5.43, 5.44, 5.49, 5.47, 5.47, 5.5, 5.52, 5.55, 5.56, 5.62, 5.66, 5.71, 5.76, 5.78],
        currency: "BRL",
        reference: 5.7558,
        referenceAt: Date.now() - DAY,
        asOf: Date.now(),
      },
      (c) => {
        const [a, b] = pairShown(c);
        return fxSeries(a, b, asFxWindow(c.window), asFxChange(c.change));
      },
      () => "fx",
      60,
    );
  },
  menu: ({ state, ctx }) => [[refreshItem(state), ...chartMenu(() => currencySource(ctx), googleFxUrl(ctx.config))]],
  View({ state, ctx, preview }) {
    const c = ctx.config;
    const [from, to] = pairShown(c);
    const amount = c.show === "amount" ? amountOf(c.amount) : 1;
    const digits = c.decimals === "auto" || !c.decimals ? undefined : Number(c.decimals);
    const change = asFxChange(c.change);
    const amountLabel = price(amount, Number.isInteger(amount) ? 0 : 2);
    const title = amount === 1 ? `${from}/${to}` : `${amountLabel} ${from}`;
    const tip = () => {
      const lines = [`1 ${from} = ${priceIn(state.price, to, 4)}`];
      if (amount !== 1) lines.push(`${amountLabel} ${from} = ${priceIn(state.price * amount, to, 2)}`);
      if (change !== "none" && state.reference)
        lines.push(`${changeText(state.change)} ${FX_CHANGE_TEXT[change]}: era ${priceIn(state.reference, to, 4)}${state.referenceAt ? ` (${dayLabel(state.referenceAt)})` : ""}`);
      if (c.chart !== "none") lines.push(`Gráfico: ${FX_WINDOW_TEXT[asFxWindow(c.window)]}, um ponto por dia útil`);
      lines.push(
        state.demo
          ? "Dados de exemplo (o BCE ainda não respondeu)"
          : state.error
            ? `Banco Central Europeu: ${state.error}`
            : `Fonte: Banco Central Europeu, cotação de referência de ${state.asOf ? dayLabel(state.asOf) : "hoje"} (via Frankfurter)`,
        c.click === "site" ? "Clique para abrir no Google Finance" : "Clique para abrir o gráfico",
      );
      return lines;
    };
    return (
      <QuoteTile
        title={title}
        state={{ ...state, price: state.price * amount }}
        color="#0a84ff"
        letter={from === "USD" ? "$" : from === "EUR" ? "€" : from === "GBP" ? "£" : from.slice(0, 1)}
        currency={amount === 1 ? undefined : to}
        digits={digits}
        chart={asChart(c.chart)}
        delta={change !== "none"}
        caption={change === "close" ? "desde o fechamento" : FX_CHANGE_TEXT[change]}
        tip={tip}
        tipId={`tip:${ctx.instanceId}`}
        preview={preview}
        onClick={preview ? undefined : chartClick(c.click, googleFxUrl(c), () => currencySource(ctx))}
      />
    );
  },
});
