import { Column, Row, Text, store, toRaw } from "@tarve/core";
import { launch } from "../../../services/windows";
import {
  convertQuote,
  cryptoQuote,
  errorText,
  fxSeries,
  invalidate,
  price,
  priceIn,
  stockQuote,
  type CryptoWindow,
  type Quote,
  type StockChange,
  type StockRange,
} from "../../../services/finance-providers";
import { numeric, ui } from "../../../theme";
import { Tile } from "../../ui";
import { defineWidget } from "../../types";
import {
  QuoteTile,
  currencyOptions,
  demoSeries,
  displayCurrencyOptions,
  poll,
  quoteSetup,
  refreshItem,
  refreshSetting,
  refreshers,
  type QuoteState,
} from "./shared";

/** The price's currency when it was converted to the chosen display currency, else undefined (plain number). */
function shownCurrency(display: string, state: { currency: string }) {
  return display && display !== "original" && state.currency.toUpperCase() === display.toUpperCase() ? display : undefined;
}

// ---------- crypto ----------

const QUOTE_ASSETS = ["USDT", "USDC", "FDUSD", "BRL", "EUR", "TRY", "BTC", "ETH", "BNB"];
const QUOTE_SUFFIX = new RegExp(`^([A-Z0-9]{2,}?)(${QUOTE_ASSETS.join("|")})$`);

const baseOf = (symbol: string) => String(symbol || "BTC").toUpperCase().replace(/[^A-Z0-9]/g, "") || "BTC";
const pairOf = (c: { symbol: string; quote: string }) => `${baseOf(c.symbol)}${String(c.quote || "USDT").toUpperCase()}`;

export const crypto = defineWidget<{ symbol: string; quote: string; window: string; refresh: string }, QuoteState>({
  type: "finance-crypto",
  name: "Cripto",
  description: "Preço de uma cripto na Binance, na moeda de cotação escolhida, com variação e gráfico. Sem chave.",
  category: "finance",
  defaultConfig: { symbol: "BTC", quote: "USDT", window: "24h", refresh: "5" },
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
      key: "window",
      label: "Janela do gráfico",
      description: "A variação acompanha a janela.",
      options: [
        { value: "24h", label: "24 h" },
        { value: "7d", label: "7 dias" },
        { value: "30d", label: "30 dias" },
      ],
    },
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
      { price: 64_850, change: 1.84, series: demoSeries(64_850, 24), currency: "USDT" },
      (c) => cryptoQuote(pairOf(c), (c.window as CryptoWindow) || "24h"),
      (c) => `binance:${pairOf(c)}:`,
    );
  },
  menu: ({ state, ctx }) => [
    [refreshItem(state), { label: "Abrir na Binance", icon: "star", onSelect: () => launch(`https://www.binance.com/pt-BR/trade/${baseOf(ctx.config.symbol)}_${String(ctx.config.quote || "USDT").toUpperCase()}`) }],
  ],
  View({ state, ctx }) {
    const base = baseOf(ctx.config.symbol);
    return <QuoteTile title={base} state={state} color="#f0b90b" letter={base.slice(0, 1)} />;
  },
});

// ---------- stocks ----------

const rangeSetting = {
  kind: "choice" as const,
  key: "range" as const,
  label: "Janela",
  options: [
    { value: "1d", label: "1 dia" },
    { value: "5d", label: "5 dias" },
    { value: "1mo", label: "1 mês" },
    { value: "6mo", label: "6 meses" },
  ],
};

const changeSetting = {
  kind: "choice" as const,
  key: "change" as const,
  label: "Variação",
  options: [
    { value: "day", label: "Diária" },
    { value: "window", label: "Da janela" },
  ],
};

const displaySetting = {
  kind: "choice" as const,
  key: "display" as const,
  label: "Moeda de exibição",
  description: "Converte pelo câmbio do dia; sem câmbio mostra a moeda da bolsa.",
  options: displayCurrencyOptions("Original da bolsa"),
};

export const stockChart = defineWidget<{ ticker: string; range: string; display: string; change: string; refresh: string }, QuoteState>({
  type: "finance-stock",
  name: "Ação (gráfico)",
  description: "Cotação de uma ação ou ETF (Yahoo Finance) com variação e gráfico. Sem chave.",
  category: "finance",
  defaultConfig: { ticker: "AAPL", range: "1d", display: "original", change: "day", refresh: "5" },
  settings: [
    { kind: "text", key: "ticker", label: "Ticker", description: "Formato do Yahoo: AAPL, PETR4.SA, ^BVSP.", placeholder: "AAPL" },
    displaySetting,
    rangeSetting,
    changeSetting,
    refreshSetting,
  ],
  setup: (ctx) =>
    quoteSetup(
      ctx,
      { price: 351.13, change: -0.47, series: demoSeries(351.13, 48, 2), currency: "USD" },
      async (c) => convertQuote(await stockQuote(c.ticker || "AAPL", (c.range as StockRange) || "1d", (c.change as StockChange) || "day"), c.display),
      (c) => `yahoo:${String(c.ticker || "AAPL").trim().toUpperCase()}:`,
    ),
  menu: ({ state, ctx }) => [
    [refreshItem(state), { label: "Abrir no Yahoo Finance", icon: "star", onSelect: () => launch(`https://finance.yahoo.com/quote/${encodeURIComponent(String(ctx.config.ticker || "AAPL"))}`) }],
  ],
  View({ state, ctx }) {
    const ticker = String(ctx.config.ticker || "AAPL").toUpperCase();
    return (
      <QuoteTile
        title={ticker.replace(/\.SA$/, "")}
        state={state}
        color="#7b5cff"
        letter={ticker.replace(/^\^/, "").slice(0, 1)}
        currency={shownCurrency(ctx.config.display, state)}
      />
    );
  },
});

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
  AAPL: { price: 351.13, change: -0.47, series: [], currency: "USD" },
  MSFT: { price: 512.4, change: 0.82, series: [], currency: "USD" },
  NVDA: { price: 188.27, change: 2.15, series: [], currency: "USD" },
};

export const watchlist = defineWidget<{ tickers: string; display: string; change: string; range: string; refresh: string }, WatchState>({
  type: "finance-watchlist",
  name: "Lista de ações",
  description: "Até 4 tickers lado a lado com preço e variação (Yahoo Finance). Sem chave.",
  category: "finance",
  defaultConfig: { tickers: "AAPL, MSFT, NVDA", display: "original", change: "day", range: "5d", refresh: "5" },
  settings: [
    { kind: "text", key: "tickers", label: "Tickers", description: "Separados por vírgula, até 4 (ex.: PETR4.SA, VALE3.SA).", placeholder: "AAPL, MSFT, NVDA" },
    displaySetting,
    changeSetting,
    { ...rangeSetting, label: "Janela da variação", when: (c) => c.change === "window" },
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
      const change = (c.change as StockChange) || "day";
      const range: StockRange = change === "window" ? (c.range as StockRange) || "5d" : "1d";
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
    poll(ctx, load, 5);
    return state;
  },
  menu: ({ state }) => [[refreshItem(state)]],
  View({ state, ctx }) {
    const configured = tickersOf(String(ctx.config.tickers || ""));
    const tickers = state.demo ? Object.keys(DEMO_WATCH) : configured.filter((t) => state.quotes[t]);
    return (
      <Tile padding={{ left: 10, right: 10 }} gap={12}>
        {tickers.map((t) => {
          const q = state.quotes[t]!;
          const up = q.change >= 0;
          const currency = shownCurrency(ctx.config.display, q);
          return (
            <Column style={{ gap: 0, width: currency ? 70 : 58 }}>
              <Row style={{ align: "center", gap: 4 }}>
                <Text size={10} weight={700} color={ui.muted} style={{ flex: 1 }}>
                  {t.replace(/\.SA$/, "")}
                </Text>
                <Text size={9} weight={700} color={up ? ui.green : ui.danger} style={numeric}>
                  {`${up ? "+" : ""}${q.change.toFixed(1).replace(".", ",")}%`}
                </Text>
              </Row>
              <Text size={12} weight={700} color={ui.text} style={numeric}>
                {currency ? priceIn(q.price, currency) : price(q.price)}
              </Text>
            </Column>
          );
        })}
        {state.error && tickers.length === 0 ? (
          <Text size={10} color={ui.danger}>
            {state.error}
          </Text>
        ) : null}
      </Tile>
    );
  },
});

// ---------- currency ----------

/** Currencies Frankfurter (ECB) publishes, which the history line needs. */
const FX_CODES = ["BRL", "USD", "EUR", "GBP", "JPY", "CAD", "AUD", "CHF", "MXN", "CNY", "INR", "KRW", "TRY", "ZAR", "SEK", "NOK", "DKK", "PLN", "NZD", "SGD", "HKD"];

const amountOf = (text: string) => {
  const n = Number(String(text || "1").replace(/\s/g, "").replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : 1;
};

export const currency = defineWidget<{ from: string; to: string; amount: string; decimals: string; refresh: string }, QuoteState>({
  type: "finance-currency",
  name: "Câmbio",
  description: "Converte um valor entre duas moedas, com variação diária e gráfico de 3 semanas. Sem chave.",
  category: "finance",
  defaultConfig: { from: "USD", to: "BRL", amount: "1", decimals: "auto", refresh: "15" },
  settings: [
    { kind: "choice", key: "from", label: "De", options: currencyOptions(FX_CODES) },
    { kind: "choice", key: "to", label: "Para", options: currencyOptions(FX_CODES) },
    { kind: "text", key: "amount", label: "Valor", description: "Quanto converter (1 mostra a cotação).", placeholder: "1" },
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
    refreshSetting,
  ],
  setup: (ctx) =>
    quoteSetup(
      ctx,
      { price: 5.78, change: 1.35, series: [5.43, 5.44, 5.49, 5.47, 5.47, 5.5, 5.52, 5.55, 5.56, 5.62, 5.66, 5.71, 5.78], currency: "BRL" },
      (c) => fxSeries(c.from || "USD", c.to || "BRL"),
      () => "fx",
      15,
    ),
  menu: ({ state }) => [[refreshItem(state)]],
  View({ state, ctx }) {
    const from = String(ctx.config.from || "USD").toUpperCase();
    const to = String(ctx.config.to || "BRL").toUpperCase();
    const amount = amountOf(ctx.config.amount);
    const digits = ctx.config.decimals === "auto" || !ctx.config.decimals ? undefined : Number(ctx.config.decimals);
    const title = amount === 1 ? `${from}/${to}` : `${price(amount, Number.isInteger(amount) ? 0 : 2)} ${from}`;
    return (
      <QuoteTile
        title={title}
        state={{ ...state, price: state.price * amount }}
        color="#0a84ff"
        letter={from === "USD" ? "$" : from === "EUR" ? "€" : from.slice(0, 1)}
        currency={amount === 1 ? undefined : to}
        digits={digits}
      />
    );
  },
});
