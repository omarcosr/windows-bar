import { HttpError } from "./online-http";
import { remoteJson } from "./remote";

/**
 * Providers that answer with the user's own key (pasted in the widget's settings). Each key is sent
 * only to its provider's endpoint, through services/remote.ts (cache, backoff, shared requests).
 */

// ---------------------------------------------------------------- DeepSeek

export interface DeepseekBalance {
  /** False when the balance no longer covers API calls. */
  available: boolean;
  currency: string;
  total: number;
  granted: number;
  toppedUp: number;
}

interface DeepseekBody {
  is_available?: boolean;
  balance_infos?: { currency?: string; total_balance?: string; granted_balance?: string; topped_up_balance?: string }[];
}

/**
 * GET https://api.deepseek.com/user/balance (documented: api-docs.deepseek.com/api/get-user-balance).
 * The API reports only the balance (per currency, CNY or USD); it has no usage/spend endpoint.
 */
export async function deepseekBalance(key: string): Promise<DeepseekBalance> {
  const { body } = await remoteJson<DeepseekBody>("https://api.deepseek.com/user/balance", { Authorization: `Bearer ${key.trim()}` }, "DeepSeek");
  const infos = body.balance_infos ?? [];
  const main = infos.find((i) => Number(i.total_balance) > 0) ?? infos[0];
  return {
    available: body.is_available !== false,
    currency: main?.currency ?? "USD",
    total: Number(main?.total_balance) || 0,
    granted: Number(main?.granted_balance) || 0,
    toppedUp: Number(main?.topped_up_balance) || 0,
  };
}

// ---------------------------------------------------------------- Z.ai / Zhipu GLM Coding Plan

export interface ZaiWindow {
  /** 0–100. */
  used: number;
  resetsAt: number | null;
}

export interface ZaiQuota {
  plan: string;
  /** The 5 h token window. */
  tokens: ZaiWindow | null;
  /** Monthly MCP (web search/reader) calls. */
  mcp: (ZaiWindow & { current: number; total: number }) | null;
}

interface ZaiLimit {
  type?: string;
  percentage?: number;
  currentValue?: number;
  usage?: number;
  nextResetTime?: number | string;
}

interface ZaiBody {
  code?: number;
  msg?: string;
  success?: boolean;
  data?: { limits?: ZaiLimit[]; level?: string; planName?: string };
}

function resetTime(raw: unknown): number | null {
  if (typeof raw === "number" && raw > 0) return raw < 1e12 ? raw * 1000 : raw;
  if (typeof raw === "string") {
    const t = Number.isFinite(Number(raw)) ? Number(raw) : Date.parse(raw);
    return Number.isFinite(t) && t > 0 ? (t < 1e12 ? t * 1000 : t) : null;
  }
  return null;
}

const pct = (n: unknown) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));

/**
 * The quota of the GLM Coding Plan, from the endpoint Z.ai's own `glm-plan-usage` plugin queries
 * (github.com/zai-org/zai-coding-plugins, query-usage.mjs): GET {base}/api/monitor/usage/quota/limit
 * with the plan's API key as the bare Authorization header. Not in the public API reference: the
 * plugin is the only documented client. Errors come back as HTTP 200 with `success: false`.
 */
export async function zaiQuota(key: string, region: string): Promise<ZaiQuota> {
  const base = region === "cn" ? "https://open.bigmodel.cn" : "https://api.z.ai";
  const { body } = await remoteJson<ZaiBody>(
    `${base}/api/monitor/usage/quota/limit`,
    { Authorization: key.trim().replace(/^Bearer\s+/i, ""), "Accept-Language": "en-US,en" },
    "Z.ai",
  );
  if (body.success === false || (body.code !== undefined && body.code !== 200 && body.code !== 0))
    throw new HttpError(body.code ?? 500, `Z.ai ${body.code ?? "?"}: ${body.msg ?? ""}`);
  const limits = body.data?.limits ?? [];
  const tokens = limits.find((l) => l.type === "TOKENS_LIMIT");
  const mcp = limits.find((l) => l.type === "TIME_LIMIT");
  const level = body.data?.planName ?? body.data?.level ?? "";
  return {
    plan: level ? level.charAt(0).toUpperCase() + level.slice(1).toLowerCase() : "",
    tokens: tokens ? { used: pct(tokens.percentage), resetsAt: resetTime(tokens.nextResetTime) } : null,
    mcp: mcp
      ? { used: pct(mcp.percentage), resetsAt: resetTime(mcp.nextResetTime), current: Number(mcp.currentValue) || 0, total: Number(mcp.usage) || 0 }
      : null,
  };
}

// ---------------------------------------------------------------- DataFast

/** YYYY-MM-DD of the local day `back` days before today. */
function localDay(back: number) {
  const d = new Date();
  d.setDate(d.getDate() - back);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

interface DatafastBody {
  status?: string;
  data?: { timestamp?: string; visitors?: number }[];
}

/**
 * Visitors per day over the last `days` days, oldest first (today last), from DataFast's
 * time-series API (datafa.st/docs/api/website/analytics/timeseries): a `df_` website key alone,
 * or a `dft_` account token with the website id.
 */
export async function datafastVisitors(key: string, websiteId: string, days = 14): Promise<number[]> {
  const params = new URLSearchParams({ fields: "visitors", interval: "day", startAt: localDay(days - 1), endAt: localDay(0) });
  if (websiteId.trim()) params.set("websiteId", websiteId.trim());
  const { body } = await remoteJson<DatafastBody>(
    `https://datafa.st/api/v1/analytics/timeseries?${params}`,
    { Authorization: `Bearer ${key.trim()}` },
    "DataFast",
  );
  const byDay = new Map<string, number>();
  for (const row of body.data ?? []) if (row.timestamp) byDay.set(row.timestamp.slice(0, 10), (byDay.get(row.timestamp.slice(0, 10)) ?? 0) + (Number(row.visitors) || 0));
  return Array.from({ length: days }, (_, i) => byDay.get(localDay(days - 1 - i)) ?? 0);
}
