/**
 * Read-only fetchers for the finance widgets. Revenue providers return the last `days` local
 * calendar days of revenue (last entry = today) in major units, net and, where the API has it,
 * gross; markets return a price, its change and a short close series. Results are cached
 * briefly so several widgets (e.g. Total Revenue and a provider tile) share one request.
 */

import { expireRemote, remoteGet } from "./remote";

const DAY_MS = 86_400_000;
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" };

export interface Revenue {
  /** Net revenue per local day, oldest first; the last entry is today. */
  daily: number[];
  /** Gross revenue per day (same buckets), when the provider exposes it. */
  gross?: number[];
  currency: string;
}

export interface Quote {
  price: number;
  /** Percent change against the previous close (or the start of the window). */
  change: number;
  series: number[];
  currency: string;
  name?: string;
  /** The exchange is outside its regular session: the price stays put until it opens. */
  closed?: boolean;
}

// ---------- periods ----------

export type Period = "7d" | "30d" | "month" | "90d";

export const periodLabels: Record<Period, string> = { "7d": "7 dias", "30d": "30 dias", month: "no mês", "90d": "90 dias" };

export function asPeriod(value: unknown): Period {
  return value === "7d" || value === "month" || value === "90d" ? value : "30d";
}

/** Days in the period, today included ("month" = from the 1st). */
export function periodLength(period: Period, now = new Date()) {
  return period === "7d" ? 7 : period === "90d" ? 90 : period === "month" ? now.getDate() : 30;
}

const previousMonthDays = (now: Date) => new Date(now.getFullYear(), now.getMonth(), 0).getDate();

/** History sizes fetched; several period choices share one request. */
const HISTORY_TIERS = [31, 62, 93, 186];

/** Days of history to fetch for the period (and the one before it, when comparing). Never below 31. */
export function historyDays(period: Period, compare: boolean) {
  const now = new Date();
  const n = periodLength(period, now);
  const need = compare ? (period === "month" ? n + previousMonthDays(now) : 2 * n) : n;
  return HISTORY_TIERS.find((t) => t >= need) ?? HISTORY_TIERS[HISTORY_TIERS.length - 1]!;
}

const sum = (values: readonly number[]) => values.reduce((a, b) => a + b, 0);

/** The days of the period, oldest first. */
export const periodDays = (daily: readonly number[], period: Period) => daily.slice(-periodLength(period));

/** Total of the period. */
export const periodSum = (daily: readonly number[], period: Period) => sum(periodDays(daily, period));

/**
 * Percent change of the period against the equal period before it (the same days of last
 * month for "month"); null when the history is too short or the previous period is zero.
 */
export function periodChange(daily: readonly number[], period: Period): number | null {
  const now = new Date();
  const n = periodLength(period, now);
  let previous: readonly number[];
  if (period === "month") {
    const days = previousMonthDays(now);
    const start = daily.length - n - days;
    if (start < 0) return null;
    previous = daily.slice(start, start + Math.min(n, days));
  } else {
    if (daily.length < 2 * n) return null;
    previous = daily.slice(-2 * n, -n);
  }
  const before = sum(previous);
  return before ? ((periodSum(daily, period) - before) / Math.abs(before)) * 100 : null;
}

/** The month so far, from the 1st (local). */
export function monthToDate(daily: readonly number[]) {
  return periodSum(daily, "month");
}

// ---------- shared helpers ----------

const cache = new Map<string, { at: number; value: Promise<unknown> }>();

/** Memoises fn for ttl ms under key; a failed promise is dropped so the next call retries. */
export function cached<T>(key: string, ttl: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value as Promise<T>;
  const value = fn();
  cache.set(key, { at: Date.now(), value });
  value.catch(() => cache.delete(key));
  return value;
}

/** Drops cached results whose key starts with prefix ("" = all), for "Atualizar agora". */
export function invalidate(prefix = "") {
  for (const key of [...cache.keys()]) if (key.startsWith(prefix)) cache.delete(key);
  expireRemote();
}

function midnight(ms: number) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** The local midnight days-1 days ago: the first bucket. */
export function windowStart(days: number) {
  return midnight(Date.now()) - (days - 1) * DAY_MS;
}

interface Entry {
  at: number;
  /** Net amount. */
  amount: number;
  gross?: number;
}

/** Sums amounts into `days` local-day buckets; entries outside the window are ignored. */
export function bucket(entries: Iterable<Entry>, days: number, pick: (e: Entry) => number | undefined = (e) => e.amount): number[] {
  const out = new Array<number>(days).fill(0);
  const today = midnight(Date.now());
  for (const entry of entries) {
    const amount = pick(entry);
    if (amount === undefined || !Number.isFinite(amount)) continue;
    const index = days - 1 - Math.round((today - midnight(entry.at)) / DAY_MS);
    if (index >= 0 && index < days) out[index]! += amount;
  }
  return out;
}

/** Net and gross buckets of the entries. */
function revenue(entries: Entry[], days: number, currency: string, gross: boolean): Revenue {
  return { daily: bucket(entries, days), gross: gross ? bucket(entries, days, (e) => e.gross) : undefined, currency };
}

const iso = (ms: number) => new Date(ms).toISOString();
const ymd = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/**
 * GETs go through services/remote.ts (max-age, ETag/Last-Modified revalidation, Retry-After,
 * one request in flight per URL); other methods are sent as they are.
 */
async function json<T>(name: string, url: string, init?: RequestInit): Promise<T> {
  if (!init?.method || init.method === "GET") {
    const res = await remoteGet(url, (init?.headers ?? {}) as Record<string, string>, name);
    if (!res.ok) throw new Error(`${name} ${res.status}`);
    return JSON.parse(res.text) as T;
  }
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${name} ${res.status}`);
  return (await res.json()) as T;
}

const numberFormats = new Map<string, Intl.NumberFormat>();

/** A pt-BR Intl.NumberFormat, built once per set of options (each costs ~15 µs, the widgets format on every render). */
function numberFormat(options: Intl.NumberFormatOptions) {
  const key = JSON.stringify(options);
  let format = numberFormats.get(key);
  if (!format) numberFormats.set(key, (format = new Intl.NumberFormat("pt-BR", options)));
  return format;
}

export type MoneyFormat = "compact" | "full";

/** pt-BR currency text: "compact" abbreviates from 10 mil (R$ 12,3 mil), "full" keeps the cents. */
export function money(amount: number, currency: string, format: MoneyFormat = "compact") {
  const big = format === "compact" && Math.abs(amount) >= 10_000;
  try {
    return numberFormat(
      format === "full"
        ? { style: "currency", currency: currency.toUpperCase() }
        : {
            style: "currency",
            currency: currency.toUpperCase(),
            notation: big ? "compact" : "standard",
            maximumFractionDigits: big ? 1 : Math.abs(amount) < 100 ? 2 : 0,
          },
    ).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency.toUpperCase()}`;
  }
}

function priceDigits(value: number) {
  const v = Math.abs(value);
  return v >= 1000 ? 0 : v >= 1 ? 2 : 4;
}

export function price(value: number, digits = priceDigits(value)) {
  return numberFormat({ minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
}

/** A price with its currency symbol (R$ 1.234,56); plain number when the code is not a currency. */
export function priceIn(value: number, currency: string, digits = priceDigits(value)) {
  try {
    return numberFormat({
      style: "currency",
      currency: currency.toUpperCase(),
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(value);
  } catch {
    return price(value, digits);
  }
}

/** One short, user-facing line for a failed fetch. */
export function errorText(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  if (/\b(401|403)\b/.test(text)) return "chave inválida";
  if (/\b429\b/.test(text)) return "limite de uso";
  if (/\b404\b/.test(text)) return "não encontrado";
  if (/\b451\b/.test(text)) return "bloqueado na região";
  return "sem conexão";
}

// ---------- revenue providers ----------

/**
 * Stripe: GET /v1/balance_transactions. Net = `net` (after fees and refunds) of every
 * non-payout transaction; gross = `amount` of charges/payments and their refunds. Cents.
 */
export function stripeRevenue(key: string, days = 31): Promise<Revenue> {
  return cached(`stripe:${days}:${key}`, 5 * 60_000, async () => {
    const since = Math.floor(windowStart(days) / 1000);
    const entries: Entry[] = [];
    let currency = "usd";
    let after = "";
    for (let page = 0; page < 60; page++) {
      const url = `https://api.stripe.com/v1/balance_transactions?limit=100&created[gte]=${since}${after ? `&starting_after=${after}` : ""}`;
      const body = await json<{
        data: { id: string; type: string; amount: number; net: number; created: number; currency: string }[];
        has_more: boolean;
      }>("Stripe", url, { headers: { Authorization: `Bearer ${key}` } });
      for (const tx of body.data) {
        if (tx.type.startsWith("payout")) continue;
        const sale = tx.type === "charge" || tx.type === "payment" || tx.type === "refund" || tx.type === "payment_refund";
        entries.push({ at: tx.created * 1000, amount: tx.net / 100, gross: sale ? tx.amount / 100 : 0 });
      }
      currency = body.data[0]?.currency ?? currency;
      if (!body.has_more || body.data.length === 0) break;
      after = body.data[body.data.length - 1]!.id;
    }
    return revenue(entries, days, currency, true);
  });
}

/** Polar: GET /v1/metrics/ with interval=day; net_revenue and revenue per period, in cents (USD). */
export function polarRevenue(token: string, days = 31): Promise<Revenue> {
  return cached(`polar:${days}:${token}`, 5 * 60_000, async () => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const url =
      `https://api.polar.sh/v1/metrics/?start_date=${ymd(windowStart(days))}&end_date=${ymd(Date.now())}` +
      `&interval=day&timezone=${encodeURIComponent(tz)}`;
    const body = await json<{ periods: { timestamp: string; net_revenue?: number; revenue?: number }[] }>("Polar", url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    // Period timestamps are midnights in `tz`; parse the date part as a local day.
    const entries = body.periods.map((p) => {
      const [y, m, d] = p.timestamp.slice(0, 10).split("-").map(Number);
      const gross = (p.revenue ?? 0) / 100;
      return { at: new Date(y!, m! - 1, d!).getTime(), amount: p.net_revenue != null ? p.net_revenue / 100 : gross, gross };
    });
    return revenue(entries, days, "usd", true);
  });
}

/**
 * Lemon Squeezy: GET /v1/orders (JSON:API), newest first, in USD cents. Net = total minus tax
 * and refunds; gross = total_usd.
 */
export function lemonRevenue(key: string, days = 31): Promise<Revenue> {
  return cached(`lemon:${days}:${key}`, 5 * 60_000, async () => {
    const start = windowStart(days);
    const entries: Entry[] = [];
    let url: string | null = "https://api.lemonsqueezy.com/v1/orders?page[size]=100&sort=-created_at";
    for (let page = 0; url && page < 60; page++) {
      const body: {
        data: { attributes: { created_at: string; status: string; total_usd: number; tax_usd: number; refunded_amount_usd?: number } }[];
        links?: { next?: string | null };
      } = await json("Lemon Squeezy", url, {
        headers: { Authorization: `Bearer ${key}`, Accept: "application/vnd.api+json" },
      });
      let older = false;
      for (const { attributes: a } of body.data) {
        const at = Date.parse(a.created_at);
        if (at < start) {
          older = true;
          continue;
        }
        if (a.status !== "paid" && a.status !== "partial_refund" && a.status !== "refunded") continue;
        entries.push({ at, amount: (a.total_usd - a.tax_usd - (a.refunded_amount_usd ?? 0)) / 100, gross: a.total_usd / 100 });
      }
      url = older ? null : (body.links?.next ?? null);
    }
    return revenue(entries, days, "usd", true);
  });
}

/**
 * Paddle Billing: GET /transactions?status=completed, in the payout currency. Net = earnings
 * (after tax and fee); gross = grand_total.
 */
export function paddleRevenue(key: string, sandbox = false, days = 31): Promise<Revenue> {
  return cached(`paddle:${sandbox}:${days}:${key}`, 5 * 60_000, async () => {
    const base = sandbox ? "https://sandbox-api.paddle.com" : "https://api.paddle.com";
    const entries: Entry[] = [];
    let currency = "usd";
    let url: string | null =
      `${base}/transactions?status=completed&per_page=200&order_by=created_at[DESC]` +
      `&created_at[GTE]=${encodeURIComponent(iso(windowStart(days)))}`;
    for (let page = 0; url && page < 40; page++) {
      type Totals = { earnings?: string | null; grand_total?: string | null; total?: string | null; currency_code?: string };
      const body: {
        data: { created_at: string; billed_at?: string | null; details: { totals: Totals; payout_totals?: Totals | null } }[];
        meta?: { pagination?: { next?: string; has_more?: boolean } };
      } = await json("Paddle", url, { headers: { Authorization: `Bearer ${key}` } });
      for (const tx of body.data) {
        const totals = tx.details.payout_totals ?? tx.details.totals;
        if (totals.earnings == null) continue;
        currency = (totals.currency_code ?? currency).toLowerCase();
        const gross = totals.grand_total ?? totals.total;
        entries.push({
          at: Date.parse(tx.billed_at ?? tx.created_at),
          amount: Number(totals.earnings) / 100,
          gross: gross == null ? undefined : Number(gross) / 100,
        });
      }
      url = body.meta?.pagination?.has_more ? (body.meta.pagination.next ?? null) : null;
    }
    return revenue(entries, days, currency, true);
  });
}

/** Gumroad: GET /v2/sales (view_sales scope), in cents (USD). Net = price minus gumroad_fee; gross = price. */
export function gumroadRevenue(token: string, days = 31): Promise<Revenue> {
  return cached(`gumroad:${days}:${token}`, 5 * 60_000, async () => {
    const entries: Entry[] = [];
    let pageKey = "";
    for (let page = 0; page < 60; page++) {
      const url =
        `https://api.gumroad.com/v2/sales?access_token=${encodeURIComponent(token)}&after=${ymd(windowStart(days) - DAY_MS)}` +
        (pageKey ? `&page_key=${encodeURIComponent(pageKey)}` : "");
      const body = await json<{
        success: boolean;
        sales: { created_at: string; price: number; gumroad_fee?: number; refunded?: boolean; chargedback?: boolean }[];
        next_page_key?: string;
      }>("Gumroad", url);
      if (!body.success) throw new Error("Gumroad 401");
      for (const s of body.sales) {
        if (s.refunded || s.chargedback) continue;
        entries.push({ at: Date.parse(s.created_at), amount: (s.price - (s.gumroad_fee ?? 0)) / 100, gross: s.price / 100 });
      }
      if (!body.next_page_key) break;
      pageKey = body.next_page_key;
    }
    return revenue(entries, days, "usd", true);
  });
}

/**
 * Shopify Admin GraphQL (read_orders), in the shop currency. Net = current total minus current
 * tax (after refunds and edits); gross = the original total price, tax included.
 */
export function shopifyRevenue(domain: string, token: string, days = 31): Promise<Revenue> {
  const shop = domain
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  return cached(`shopify:${shop}:${days}:${token}`, 5 * 60_000, async () => {
    const query = `query($cursor: String, $q: String) {
      orders(first: 250, after: $cursor, query: $q, sortKey: CREATED_AT) {
        pageInfo { hasNextPage endCursor }
        nodes { createdAt cancelledAt
          totalPriceSet { shopMoney { amount } }
          currentTotalPriceSet { shopMoney { amount currencyCode } }
          currentTotalTaxSet { shopMoney { amount } } }
      }
    }`;
    const entries: Entry[] = [];
    let currency = "usd";
    let cursor: string | null = null;
    for (let page = 0; page < 40; page++) {
      type Node = {
        createdAt: string;
        cancelledAt: string | null;
        totalPriceSet: { shopMoney: { amount: string } } | null;
        currentTotalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
        currentTotalTaxSet: { shopMoney: { amount: string } } | null;
      };
      const body: {
        data?: { orders: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Node[] } };
        errors?: unknown;
      } = await json("Shopify", `https://${shop}/admin/api/2025-10/graphql.json`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
        body: JSON.stringify({ query, variables: { cursor, q: `created_at:>='${iso(windowStart(days))}'` } }),
      });
      if (!body.data) throw new Error("Shopify 403");
      for (const o of body.data.orders.nodes) {
        if (o.cancelledAt) continue;
        currency = o.currentTotalPriceSet.shopMoney.currencyCode.toLowerCase();
        const current = Number(o.currentTotalPriceSet.shopMoney.amount);
        const tax = Number(o.currentTotalTaxSet?.shopMoney.amount ?? 0);
        entries.push({ at: Date.parse(o.createdAt), amount: current - tax, gross: Number(o.totalPriceSet?.shopMoney.amount ?? current) });
      }
      if (!body.data.orders.pageInfo.hasNextPage) break;
      cursor = body.data.orders.pageInfo.endCursor;
    }
    return revenue(entries, days, currency, true);
  });
}

/** Dodo Payments: GET /payments?status=succeeded; total_amount in cents, in the payment currency (no net/gross split in the list). */
export function dodoRevenue(key: string, test = false, days = 31): Promise<Revenue> {
  return cached(`dodo:${test}:${days}:${key}`, 5 * 60_000, async () => {
    const base = test ? "https://test.dodopayments.com" : "https://live.dodopayments.com";
    const entries: Entry[] = [];
    let currency = "usd";
    for (let page = 0; page < 60; page++) {
      const url =
        `${base}/payments?status=succeeded&page_size=100&page_number=${page}` +
        `&created_at_gte=${encodeURIComponent(iso(windowStart(days)))}`;
      const body = await json<{ items: { created_at: string; total_amount: number; currency: string }[] }>("Dodo", url, {
        headers: { Authorization: `Bearer ${key}` },
      });
      for (const p of body.items) {
        currency = p.currency.toLowerCase();
        entries.push({ at: Date.parse(p.created_at), amount: p.total_amount / 100 });
      }
      if (body.items.length < 100) break;
    }
    return revenue(entries, days, currency, false);
  });
}

// ---------- currency ----------

/** How many `to` one `from` buys today: open.er-api.com (keyless, daily; cached 1 h). */
export function fxRate(from: string, to: string): Promise<number> {
  const f = from.toUpperCase();
  const t = to.toUpperCase();
  if (f === t) return Promise.resolve(1);
  return cached(`fx:${f}`, 60 * 60_000, () =>
    json<{ result: string; rates: Record<string, number> }>("Câmbio", `https://open.er-api.com/v6/latest/${f}`),
  ).then((body) => {
    const rate = body.rates?.[t];
    if (body.result !== "success" || !rate) throw new Error("Câmbio 404");
    return rate;
  });
}

/** Quote currencies in minor units (Yahoo: London in pence, Johannesburg in cents, Tel Aviv in agorot). */
const MINOR_UNITS: Record<string, string> = { GBp: "GBP", GBX: "GBP", ZAc: "ZAR", ILA: "ILS" };

/**
 * The quote converted to `target` (price and series) at today's rate. "" or "original" keeps
 * it; on a failed rate the quote comes back unchanged, in its own currency.
 */
export async function convertQuote(quote: Quote, target: string): Promise<Quote> {
  if (!target || target === "original") return quote;
  const major = MINOR_UNITS[quote.currency];
  const from = major ?? quote.currency.toUpperCase();
  const to = target.toUpperCase();
  if (from === to && !major) return quote;
  try {
    const rate = (await fxRate(from, to)) / (major ? 100 : 1);
    return { ...quote, price: quote.price * rate, series: quote.series.map((v) => v * rate), currency: to };
  } catch {
    return quote;
  }
}

/** The pair over the last ~3 weeks of business days from Frankfurter (ECB), latest last. */
export function fxSeries(from: string, to: string): Promise<Quote> {
  const f = from.toUpperCase();
  const t = to.toUpperCase();
  return cached(`fxs:${f}:${t}`, 15 * 60_000, async () => {
    const url = `https://api.frankfurter.dev/v1/${ymd(Date.now() - 21 * DAY_MS)}..?from=${f}&to=${t}`;
    const body = await json<{ rates: Record<string, Record<string, number>> }>("Câmbio", url);
    const series = Object.keys(body.rates)
      .sort()
      .map((day) => body.rates[day]![t]!)
      .filter((v) => Number.isFinite(v));
    if (series.length === 0) throw new Error("Câmbio 404");
    // The ECB fixes once a day; the open.er-api rate is fresher when it answers.
    const latest = await fxRate(f, t).catch(() => series[series.length - 1]!);
    const prev = series.length > 1 ? series[series.length - 2]! : series[0]!;
    return { price: latest, change: prev ? ((latest - prev) / prev) * 100 : 0, series: [...series.slice(0, -1), latest], currency: t };
  });
}

// ---------- markets ----------

export type CryptoWindow = "24h" | "7d" | "30d";

const KLINES: Record<CryptoWindow, { interval: string; limit: number }> = {
  "24h": { interval: "1h", limit: 24 },
  "7d": { interval: "4h", limit: 42 },
  "30d": { interval: "12h", limit: 60 },
};

/**
 * Binance public market data for a pair (BTCUSDT): klines over the window; the change is the
 * 24 h ticker's for "24h" and from the first open of the window otherwise.
 */
export function cryptoQuote(symbol: string, window: CryptoWindow = "24h"): Promise<Quote> {
  const s = symbol.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const k = KLINES[window] ?? KLINES["24h"];
  return cached(`binance:${s}:${window}`, 60_000, async () => {
    const [ticker, klines] = await Promise.all([
      json<{ lastPrice: string; priceChangePercent: string }>("Binance", `https://api.binance.com/api/v3/ticker/24hr?symbol=${s}`),
      json<[number, string, string, string, string][]>("Binance", `https://api.binance.com/api/v3/klines?symbol=${s}&interval=${k.interval}&limit=${k.limit}`),
    ]);
    const quoteAsset = /(USDT|USDC|FDUSD|BUSD|BRL|EUR|TRY|BTC|ETH|BNB)$/.exec(s)?.[1] ?? "USDT";
    const last = Number(ticker.lastPrice);
    const open = Number(klines[0]?.[1]);
    return {
      price: last,
      change: window === "24h" || !open ? Number(ticker.priceChangePercent) : ((last - open) / open) * 100,
      series: klines.map((c) => Number(c[4])),
      currency: quoteAsset,
    };
  });
}

export type StockRange = "1d" | "5d" | "1mo" | "6mo";
export type StockChange = "day" | "window";

const YAHOO_INTERVAL: Record<StockRange, string> = { "1d": "5m", "5d": "30m", "1mo": "60m", "6mo": "1d" };

interface YahooChart {
  meta: {
    regularMarketPrice: number;
    chartPreviousClose?: number;
    previousClose?: number;
    currency?: string;
    shortName?: string;
    currentTradingPeriod?: { regular?: { start: number; end: number } };
  };
  series: number[];
}

function yahooChart(ticker: string, range: StockRange): Promise<YahooChart> {
  return cached(`yahoo:${ticker}:${range}`, 60_000, async () => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=${range}&interval=${YAHOO_INTERVAL[range]}`;
    const body = await json<{
      chart: {
        result: { meta: YahooChart["meta"]; indicators: { quote: { close: (number | null)[] }[] } }[] | null;
        error: unknown;
      };
    }>("Yahoo", url, { headers: UA });
    const r = body.chart.result?.[0];
    if (!r) throw new Error("Yahoo 404");
    return { meta: r.meta, series: (r.indicators.quote[0]?.close ?? []).filter((v): v is number => v != null) };
  });
}

/**
 * Yahoo Finance chart API (keyless): closes over the range; change against the previous close
 * ("day") or the close before the range ("window").
 */
export async function stockQuote(ticker: string, range: StockRange = "1d", change: StockChange = "day"): Promise<Quote> {
  const t = ticker.trim().toUpperCase();
  const r: StockRange = YAHOO_INTERVAL[range] ? range : "1d";
  const chart = await yahooChart(t, r);
  const last = chart.meta.regularMarketPrice ?? chart.series[chart.series.length - 1] ?? 0;
  let prev: number | undefined;
  if (change === "window" && r !== "1d") prev = chart.meta.chartPreviousClose ?? chart.series[0];
  else {
    const day = r === "1d" ? chart : await yahooChart(t, "1d");
    prev = day.meta.previousClose ?? day.meta.chartPreviousClose;
  }
  return {
    price: last,
    change: prev ? ((last - prev) / prev) * 100 : 0,
    series: chart.series,
    currency: chart.meta.currency ?? "USD",
    name: chart.meta.shortName,
    closed: marketClosed(chart.meta.currentTradingPeriod?.regular),
  };
}

/** Outside the regular session Yahoo reports (epoch seconds); unknown counts as open. */
function marketClosed(regular: { start: number; end: number } | undefined, now = Date.now()) {
  if (!regular?.start || !regular.end) return false;
  return now < regular.start * 1000 || now >= regular.end * 1000;
}
