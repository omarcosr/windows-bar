/**
 * Read-only fetchers for the finance widgets. Revenue providers return the last `days` local
 * calendar days of revenue (last entry = today) in major units, net and, where the API has it,
 * gross; markets return a price, its change and a short close series. Results are cached
 * briefly so several widgets (e.g. Total Revenue and a provider tile) share one request.
 */

import { expireRemote, remoteGet } from "./remote";

import { t as tr, language } from "../i18n";
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
  /** The value `change` compares against (previous close, start of the window…), in the quote's currency. */
  reference?: number;
  /** When `reference` was taken (epoch ms), when known. */
  referenceAt?: number;
  /** When `price` was taken (epoch ms): the ECB fix date for currencies. */
  asOf?: number;
}

// ---------- periods ----------

/** A revenue period: the last N days, the month so far, the whole previous month or the last 12 months. */
export type Period = "7d" | "30d" | "month" | "prevmonth" | "90d" | "365d";
/** What a revenue change compares against: the equal period before it or the same days a year earlier. */
export type CompareTo = "previous" | "year";

export const periodLabels: Record<Period, string> = { "7d": "7 dias", "30d": "30 dias", month: tr("services.financeProviders.thisMonth"), prevmonth: tr("services.financeProviders.lastMonth"), "90d": "90 dias", "365d": "12 meses" };

export function asPeriod(value: unknown): Period {
  return value === "7d" || value === "month" || value === "prevmonth" || value === "90d" || value === "365d" ? value : "30d";
}

export const asCompareTo = (value: unknown): CompareTo => (value === "year" ? "year" : "previous");

const previousMonthDays = (now: Date) => new Date(now.getFullYear(), now.getMonth(), 0).getDate();

/** Days of a span [from, to], both counted in days before today (0 = today) and included. */
export type Span = readonly [from: number, to: number];

/** Days in the period, today included ("month" = from the 1st). */
export function periodLength(period: Period, now = new Date()) {
  const [from, to] = periodSpan(period, now);
  return from - to + 1;
}

/** The period as days before today. */
export function periodSpan(period: Period, now = new Date()): Span {
  if (period === "month") return [now.getDate() - 1, 0];
  if (period === "prevmonth") return [now.getDate() + previousMonthDays(now) - 1, now.getDate()];
  const n = period === "7d" ? 7 : period === "90d" ? 90 : period === "365d" ? 365 : 30;
  return [n - 1, 0];
}

/** Days before today of the same calendar day one year earlier than `daysAgo` days ago. */
function yearBack(daysAgo: number, now: Date) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - daysAgo);
  const before = new Date(day.getFullYear() - 1, day.getMonth(), day.getDate());
  return Math.round((today.getTime() - before.getTime()) / DAY_MS);
}

/**
 * The span a period is compared with: the equal span right before it (the same days of last month
 * for "month", the month before for "prevmonth") or the same calendar days one year earlier.
 */
export function compareSpan(period: Period, to: CompareTo = "previous", now = new Date()): Span {
  const [from, end] = periodSpan(period, now);
  if (to === "year") return [yearBack(from, now), yearBack(end, now)];
  if (period === "month") {
    const days = previousMonthDays(now);
    const n = from + 1;
    return [from + days, from + days - (Math.min(n, days) - 1)];
  }
  if (period === "prevmonth") {
    const days = new Date(now.getFullYear(), now.getMonth() - 1, 0).getDate();
    return [from + days, from + 1];
  }
  const n = from - end + 1;
  return [from + n, from + 1];
}

/** History sizes fetched; several period choices share one request. */
const HISTORY_TIERS = [31, 62, 93, 186, 366, 731];

/** Days of history to fetch for the period (and the one it is compared with, when comparing). Never below 31. */
export function historyDays(period: Period, compare: boolean | CompareTo) {
  const need = (compare ? compareSpan(period, compare === true ? "previous" : compare)[0] : periodSpan(period)[0]) + 1;
  return HISTORY_TIERS.find((t) => t >= need) ?? HISTORY_TIERS[HISTORY_TIERS.length - 1]!;
}

const sum = (values: readonly number[]) => values.reduce((a, b) => a + b, 0);

/** The days of a span of `daily` (last entry = today), oldest first; what the history holds of it. */
export function spanDays(daily: readonly number[], span: Span) {
  const n = daily.length;
  return daily.slice(Math.max(0, n - 1 - span[0]), Math.max(0, n - span[1]));
}

/** The days of the period, oldest first. */
export const periodDays = (daily: readonly number[], period: Period) => spanDays(daily, periodSpan(period));

/** Total of the period. */
export const periodSum = (daily: readonly number[], period: Period) => sum(periodDays(daily, period));

/**
 * Percent change of the period against the span it is compared with (compareSpan); null when the
 * history is too short or that span's total is zero.
 */
export function periodChange(daily: readonly number[], period: Period, to: CompareTo = "previous"): number | null {
  const span = compareSpan(period, to);
  if (span[0] >= daily.length) return null;
  const before = sum(spanDays(daily, span));
  return before ? ((periodSum(daily, period) - before) / Math.abs(before)) * 100 : null;
}

/** The total of the span the period is compared with. */
export const compareSum = (daily: readonly number[], period: Period, to: CompareTo = "previous") => sum(spanDays(daily, compareSpan(period, to)));

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
  if (!format) numberFormats.set(key, (format = new Intl.NumberFormat(language, options)));
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
  if (/\b(401|403)\b/.test(text)) return tr("services.financeProviders.invalidKey");
  if (/\b429\b/.test(text)) return tr("services.financeProviders.usageLimit");
  if (/\b404\b/.test(text)) return tr("services.financeProviders.notFound");
  if (/\b451\b/.test(text)) return tr("services.financeProviders.blockedInThisRegion");
  return tr("services.financeProviders.noConnection");
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
    json<{ result: string; rates: Record<string, number> }>(tr("services.financeProviders.exchangeRate"), `https://open.er-api.com/v6/latest/${f}`),
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
    return { ...quote, price: quote.price * rate, series: quote.series.map((v) => v * rate), reference: quote.reference && quote.reference * rate, currency: to };
  } catch {
    return quote;
  }
}

/** How the currency tile's change is measured: against the previous ECB fix, 7 or 30 days back, since the chart starts, or not at all. */
export type FxChange = "close" | "7d" | "30d" | "window" | "none";
/** Calendar days of history the currency chart shows. */
export type FxWindow = "1w" | "1m" | "3m" | "6m" | "1y" | "5y";
export const FX_WINDOW_DAYS: Record<FxWindow, number> = { "1w": 7, "1m": 31, "3m": 92, "6m": 183, "1y": 365, "5y": 1826 };

/** A dated value (epoch ms), for the chart panel. */
export interface Point {
  at: number;
  v: number;
}

/** A dated series and what it is in, oldest first. */
export interface History {
  points: Point[];
  currency: string;
  name?: string;
  /** When the last value was taken (epoch ms). */
  asOf: number;
}

/**
 * The ECB fixes of the pair over the last `days` calendar days (Frankfurter), oldest first. Cached
 * per (pair, days) for 15 min: the tile, the chart panel and its comparisons share requests.
 */
export function fxPoints(from: string, to: string, days: number): Promise<Point[]> {
  const f = from.toUpperCase();
  const t = to.toUpperCase();
  return cached(`fxs:${f}:${t}:${days}`, 15 * 60_000, async () => {
    const url = `https://api.frankfurter.dev/v1/${ymd(Date.now() - days * DAY_MS)}..?from=${f}&to=${t}`;
    const body = await json<{ rates: Record<string, Record<string, number>> }>(tr("services.financeProviders.exchangeRate"), url);
    const points = Object.keys(body.rates)
      .sort()
      .map((day) => ({ at: Date.parse(`${day}T12:00:00`), v: body.rates[day]![t]! }))
      .filter((p) => Number.isFinite(p.v));
    if (points.length === 0) throw new Error("Câmbio 404");
    return points;
  });
}

/**
 * The pair from Frankfurter (the ECB's daily reference rates, published around 16:00 CET on
 * business days): price, chart and change all come from this one series, so the change is never
 * the gap between two providers. `change` picks the comparison: the fix before the latest
 * ("close"), the last fix on or before 7/30 days earlier, the first of the chart ("window") or none (0).
 */
export async function fxSeries(from: string, to: string, window: FxWindow = "1m", change: FxChange = "close"): Promise<Quote> {
  const chartDays = FX_WINDOW_DAYS[window] ?? 31;
  const changeDays = change === "30d" ? 30 : change === "7d" ? 7 : 0;
  // A week more than either needs, so a span starting on a weekend or holiday still finds a fix.
  const points = await fxPoints(from, to, Math.max(chartDays, changeDays) + 7);
  return fxQuote(points, to.toUpperCase(), chartDays, change);
}

/** Price, change and chart from one dated series (oldest first). */
export function fxQuote(points: readonly Point[], currency: string, chartDays: number, change: FxChange): Quote {
  const last = points[points.length - 1]!;
  const start = last.at - chartDays * DAY_MS;
  const shown = points.filter((p) => p.at >= start);
  let ref: Point | undefined;
  if (change === "close") ref = points.length > 1 ? points[points.length - 2] : undefined;
  else if (change === "window") ref = shown.length > 1 ? shown[0] : undefined;
  else if (change !== "none") {
    const since = last.at - (change === "30d" ? 30 : 7) * DAY_MS;
    ref = [...points].reverse().find((p) => p.at <= since) ?? points[0];
  }
  return {
    price: last.v,
    change: ref ? ((last.v - ref.v) / ref.v) * 100 : 0,
    series: shown.map((p) => p.v),
    currency,
    reference: ref?.v,
    referenceAt: ref?.at,
    asOf: last.at,
  };
}

/** The pair's fixes over the chart window, for the chart panel. */
export async function fxHistory(from: string, to: string, window: FxWindow): Promise<History> {
  const days = FX_WINDOW_DAYS[window] ?? 31;
  const points = await fxPoints(from, to, days + 7);
  const last = points[points.length - 1]!;
  return { points: points.filter((p) => p.at >= last.at - days * DAY_MS), currency: to.toUpperCase(), asOf: last.at };
}

/**
 * The same window, shifted back: right before it ("previous") or one year earlier ("year"). The
 * dates are kept as they were (the chart lays both over the same axis).
 */
export async function fxHistoryBefore(from: string, to: string, window: FxWindow, shift: CompareTo): Promise<History> {
  const days = FX_WINDOW_DAYS[window] ?? 31;
  const back = shift === "year" ? 365 : days;
  const points = await fxPoints(from, to, days + back + 7);
  const end = points[points.length - 1]!.at - back * DAY_MS;
  return { points: points.filter((p) => p.at <= end && p.at >= end - days * DAY_MS), currency: to.toUpperCase(), asOf: end };
}

// ---------- markets ----------

/** Crypto chart windows (Binance trades every day: 7 days rather than 5 business days). */
export type CryptoWindow = "24h" | "7d" | "30d" | "90d" | "180d" | "1y" | "5y";

/** Candles for the tile's sparkline: a few dozen points are all 86 px can show. */
const KLINES: Record<CryptoWindow, { interval: string; limit: number }> = {
  "24h": { interval: "1h", limit: 24 },
  "7d": { interval: "4h", limit: 42 },
  "30d": { interval: "12h", limit: 60 },
  "90d": { interval: "1d", limit: 90 },
  "180d": { interval: "1d", limit: 180 },
  "1y": { interval: "3d", limit: 122 },
  "5y": { interval: "1w", limit: 261 },
};

/** Candles for the chart panel: one point per 1–2 px of its 300 px plot. */
const KLINES_HISTORY: Record<CryptoWindow, { interval: string; limit: number }> = {
  "24h": { interval: "15m", limit: 96 },
  "7d": { interval: "1h", limit: 168 },
  "30d": { interval: "4h", limit: 180 },
  "90d": { interval: "12h", limit: 180 },
  "180d": { interval: "1d", limit: 180 },
  "1y": { interval: "1d", limit: 365 },
  "5y": { interval: "1w", limit: 261 },
};

export const asCryptoWindow = (value: unknown): CryptoWindow => (typeof value === "string" && value in KLINES ? (value as CryptoWindow) : "24h");

export type CryptoChange = "24h" | "window" | "none";

const quoteAssetOf = (pair: string) => /(USDT|USDC|FDUSD|BUSD|BRL|EUR|TRY|BTC|ETH|BNB)$/.exec(pair)?.[1] ?? "USDT";

/**
 * Binance public market data for a pair (BTCUSDT): klines over the window; the change is the
 * 24 h ticker's ("24h", against the price 24 h ago), from the first open of the chart window
 * ("window") or none.
 */
export function cryptoQuote(symbol: string, window: CryptoWindow = "24h", change: CryptoChange = "24h"): Promise<Quote> {
  const s = symbol.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const k = KLINES[window] ?? KLINES["24h"];
  return cached(`binance:${s}:${window}:${change}`, 60_000, async () => {
    const [ticker, klines] = await Promise.all([
      json<{ lastPrice: string; openPrice: string; openTime: number; closeTime: number }>("Binance", `https://api.binance.com/api/v3/ticker/24hr?symbol=${s}`),
      json<[number, string, string, string, string][]>("Binance", `https://api.binance.com/api/v3/klines?symbol=${s}&interval=${k.interval}&limit=${k.limit}`),
    ]);
    const last = Number(ticker.lastPrice);
    const day = { v: Number(ticker.openPrice), at: Number(ticker.openTime) };
    const first = { v: Number(klines[0]?.[1]), at: Number(klines[0]?.[0]) };
    const ref = change === "none" ? undefined : change === "window" && first.v ? first : day.v ? day : undefined;
    return {
      price: last,
      change: ref ? ((last - ref.v) / ref.v) * 100 : 0,
      series: klines.map((c) => Number(c[4])),
      currency: quoteAssetOf(s),
      reference: ref?.v,
      referenceAt: ref?.at,
      asOf: Number(ticker.closeTime) || Date.now(),
    };
  });
}

/** The pair's closes over the window (the last one is the running candle: the current price), for the chart panel. */
export function cryptoHistory(symbol: string, window: CryptoWindow): Promise<History> {
  const s = symbol.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const k = KLINES_HISTORY[window] ?? KLINES_HISTORY["24h"];
  return cached(`binance:${s}:h:${window}`, 60_000, async () => {
    const klines = await json<[number, string, string, string, string][]>("Binance", `https://api.binance.com/api/v3/klines?symbol=${s}&interval=${k.interval}&limit=${k.limit}`);
    const points = klines.map((c) => ({ at: Number(c[0]), v: Number(c[4]) })).filter((p) => Number.isFinite(p.v));
    if (points.length === 0) throw new Error("Binance 404");
    return { points, currency: quoteAssetOf(s), asOf: Date.now() };
  });
}

export type StockRange = "1d" | "5d" | "1mo" | "3mo" | "6mo" | "1y" | "5y";
export type StockChange = "day" | "window";

const YAHOO_INTERVAL: Record<StockRange, string> = { "1d": "5m", "5d": "30m", "1mo": "60m", "3mo": "1d", "6mo": "1d", "1y": "1d", "5y": "1wk" };

export const asStockRange = (value: unknown): StockRange => (typeof value === "string" && value in YAHOO_INTERVAL ? (value as StockRange) : "1d");

interface YahooChart {
  meta: {
    regularMarketPrice: number;
    regularMarketTime?: number;
    chartPreviousClose?: number;
    previousClose?: number;
    currency?: string;
    shortName?: string;
    currentTradingPeriod?: { regular?: { start: number; end: number } };
  };
  series: number[];
  points: Point[];
}

function yahooChart(ticker: string, range: StockRange): Promise<YahooChart> {
  // Intraday ranges move by the minute; a day's close moves once a day.
  const ttl = range === "1d" || range === "5d" ? 60_000 : 10 * 60_000;
  return cached(`yahoo:${ticker}:${range}`, ttl, async () => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=${range}&interval=${YAHOO_INTERVAL[range]}`;
    const body = await json<{
      chart: {
        result: { meta: YahooChart["meta"]; timestamp?: number[]; indicators: { quote: { close: (number | null)[] }[] } }[] | null;
        error: unknown;
      };
    }>("Yahoo", url, { headers: UA });
    const r = body.chart.result?.[0];
    if (!r) throw new Error("Yahoo 404");
    const close = r.indicators.quote[0]?.close ?? [];
    const points: Point[] = [];
    close.forEach((v, i) => {
      const at = r.timestamp?.[i];
      if (v != null && at) points.push({ at: at * 1000, v });
    });
    return { meta: r.meta, series: close.filter((v): v is number => v != null), points };
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
    reference: prev,
    series: chart.series,
    currency: chart.meta.currency ?? "USD",
    name: chart.meta.shortName,
    closed: marketClosed(chart.meta.currentTradingPeriod?.regular),
  };
}

/** The ticker's closes over the range, for the chart panel (same request as the tile's). */
export async function stockHistory(ticker: string, range: StockRange): Promise<History> {
  const t = ticker.trim().toUpperCase();
  const chart = await yahooChart(t, YAHOO_INTERVAL[range] ? range : "1d");
  if (chart.points.length === 0) throw new Error("Yahoo 404");
  return {
    points: chart.points,
    currency: chart.meta.currency ?? "USD",
    name: chart.meta.shortName,
    asOf: chart.meta.regularMarketTime ? chart.meta.regularMarketTime * 1000 : chart.points[chart.points.length - 1]!.at,
  };
}

/** Outside the regular session Yahoo reports (epoch seconds); unknown counts as open. */
function marketClosed(regular: { start: number; end: number } | undefined, now = Date.now()) {
  if (!regular?.start || !regular.end) return false;
  return now < regular.start * 1000 || now >= regular.end * 1000;
}
