import { store } from "@tarve/core";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createPoller } from "./poller";
import type { LimitUsage, UsageStatus } from "./ai-usage";

import { t } from "../i18n";
/**
 * Gemini CLI quota, read the way the CLI's own /stats does (read-only):
 * - the Google login Gemini CLI keeps in `~/.gemini/oauth_creds.json` (access_token, expiry_date);
 * - POST cloudcode-pa.googleapis.com/v1internal:loadCodeAssist gives the Code Assist project and tier;
 * - POST …/v1internal:retrieveUserQuota {project} gives `buckets` (per model: remainingFraction,
 *   resetTime), what /stats shows as "usage remaining".
 * (packages/core/src/code_assist/server.ts and types.ts in google-gemini/gemini-cli.)
 * The token is only ever sent there. The CLI renews its own token while it runs; the dock never
 * refreshes it (that would rewrite the CLI's file), so an expired token asks to open the CLI.
 * These are POSTs, which services/remote.ts (a GET cache) does not cover: fetch directly, like
 * ai-usage.ts does for Claude's endpoint.
 */

export interface GeminiModelQuota {
  model: string;
  /** 0–100. */
  used: number;
  resetsAt: number | null;
}

export interface GeminiUsage {
  status: UsageStatus;
  note: string;
  plan: string;
  /** Most used first. */
  models: GeminiModelQuota[];
  updated: number;
}

const empty = (): GeminiUsage => ({ status: "loading", note: "", plan: "", models: [], updated: 0 });

export const gemini = store({ usage: empty() });

const HOME = process.env.USERPROFILE ?? process.env.HOME ?? "";
const geminiDir = () => join(HOME, ".gemini");
const endpoint = () => `${process.env.CODE_ASSIST_ENDPOINT ?? "https://cloudcode-pa.googleapis.com"}/v1internal`;

interface OAuthCreds {
  access_token?: string;
  expiry_date?: number;
}

/** The auth type chosen in the CLI: quota exists only for the Google login ("oauth-personal"). */
function authType(): string {
  try {
    const raw = readFileSync(join(geminiDir(), "settings.json"), "utf8").replace(/^\uFEFF/, "");
    const s = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, "")) as { selectedAuthType?: string; security?: { auth?: { selectedType?: string } } };
    return s.security?.auth?.selectedType ?? s.selectedAuthType ?? "";
  } catch {
    return "";
  }
}

async function post<T>(method: string, token: string, body: object): Promise<{ status: number; body: T | null }> {
  const res = await fetch(`${endpoint()}:${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  return { status: res.status, body: res.ok ? ((await res.json()) as T) : null };
}

/** "gemini-2.5-pro" -> "2.5 Pro". */
export function geminiModelLabel(id: string) {
  return id
    .replace(/^models\//, "")
    .replace(/^gemini-/, "")
    .replace(/_vertex$/, "")
    .split("-")
    .map((p) => (/^\d/.test(p) ? p : p.charAt(0).toUpperCase() + p.slice(1)))
    .join(" ");
}

let project: string | null = null;
let plan = "";
let busy = false;

export async function refreshGemini() {
  if (busy) return;
  busy = true;
  const set = (patch: Partial<GeminiUsage>) => (gemini.usage = { ...gemini.usage, ...patch, updated: Date.now() });
  try {
    const path = join(geminiDir(), "oauth_creds.json");
    if (!existsSync(path)) return set({ status: "missing", note: t("services.providers2Gemini.notInstalled") });
    const type = authType();
    if (type && type !== "oauth-personal") return set({ status: "missing", note: t("services.providers2Gemini.notSignedInTo") });
    const creds = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")) as OAuthCreds;
    if (!creds.access_token) return set({ status: "missing", note: t("services.providers2Gemini.notSignedIn") });
    if (creds.expiry_date && creds.expiry_date <= Date.now()) return set({ status: "expired", note: "abra o Gemini CLI", plan });
    const token = creds.access_token;
    if (!project) {
      const envProject = process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID || undefined;
      const load = await post<{ cloudaicompanionProject?: string | { id?: string } | null; currentTier?: { name?: string; id?: string } | null; paidTier?: { name?: string } | null }>(
        "loadCodeAssist",
        token,
        {
          cloudaicompanionProject: envProject,
          metadata: { ideType: "IDE_UNSPECIFIED", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI", duetProject: envProject },
        },
      );
      if (load.status === 401 || load.status === 403) return set({ status: "expired", note: "abra o Gemini CLI" });
      if (!load.body) return set({ status: gemini.usage.models.length ? "ok" : "error", note: t("services.providers2Gemini.error", { status: load.status }) });
      const p = load.body.cloudaicompanionProject;
      project = (typeof p === "string" ? p : p?.id) || envProject || null;
      plan = load.body.paidTier?.name ?? load.body.currentTier?.name ?? "";
      if (!project) return set({ status: "error", note: t("services.providers2Gemini.noProject"), plan });
    }
    const quota = await post<{ buckets?: { remainingFraction?: number; resetTime?: string; modelId?: string; tokenType?: string }[] }>(
      "retrieveUserQuota",
      token,
      { project },
    );
    if (quota.status === 401 || quota.status === 403) {
      project = null;
      return set({ status: "expired", note: "abra o Gemini CLI", plan });
    }
    if (!quota.body) return set({ status: gemini.usage.models.length ? "ok" : "error", note: t("services.providers2Gemini.error", { status: quota.status }), plan });
    const models = new Map<string, GeminiModelQuota>();
    for (const b of quota.body.buckets ?? []) {
      if (typeof b.remainingFraction !== "number" || !b.modelId) continue;
      const used = Math.max(0, Math.min(100, Math.round((1 - b.remainingFraction) * 100)));
      const reset = b.resetTime ? Date.parse(b.resetTime) : NaN;
      const prev = models.get(b.modelId);
      if (!prev || used > prev.used) models.set(b.modelId, { model: geminiModelLabel(b.modelId), used, resetsAt: Number.isFinite(reset) ? reset : null });
    }
    set({ status: "ok", note: "", plan, models: [...models.values()].sort((a, b) => b.used - a.used) });
  } catch (error) {
    set({ status: gemini.usage.models.length ? "ok" : "error", note: t("services.providers2Gemini.noConnection") });
    console.error("[providers2] gemini", error);
  } finally {
    busy = false;
  }
}

/** Daily quotas: every 10 minutes is plenty. */
export const geminiPoller = createPoller(10 * 60_000, refreshGemini);

const inHours = (h: number) => Date.now() + h * 3_600_000;

export const geminiDemo = (): GeminiUsage => ({
  status: "ok",
  note: "",
  plan: "Gemini Code Assist",
  models: [
    { model: "2.5 Pro", used: 46, resetsAt: inHours(9.5) },
    { model: "2.5 Flash", used: 12, resetsAt: inHours(9.5) },
  ],
  updated: Date.now(),
});

/** The Gemini quota as a LimitUsage (most used model in `session`), for the "Limites de IA" tile. */
export function geminiLimits(preview: boolean): LimitUsage {
  const u = preview ? geminiDemo() : gemini.usage;
  const top = u.models[0];
  return {
    status: u.status,
    note: u.note,
    plan: u.plan,
    session: top ? { used: top.used, resetsAt: top.resetsAt } : null,
    weekly: null,
    weeklyModel: null,
    updated: u.updated,
  };
}
