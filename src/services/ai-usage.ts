import { store } from "@tarve/core";
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createPoller } from "./poller";
import { openReadonly, type ReadonlyDatabase } from "../runtime/sqlite";
import { acquireWatch, onWatchChange, type WatchId } from "../native/shell-events";

/**
 * Usage limits of the AI coding tools the user already has, read from what those tools keep on
 * disk (read-only; nothing here ever writes their files):
 * - Claude Code: OAuth login in `~/.claude/.credentials.json`; the limits come from the endpoint
 *   Claude Code's own `/usage` uses (api.anthropic.com/api/oauth/usage); the token is only ever sent
 *   there. The model mix comes from the transcripts in `~/.claude/projects/**\/*.jsonl`.
 * - Codex CLI: every `token_count` event in `~/.codex/sessions/YYYY/MM/DD/*.jsonl` carries the
 *   account's `rate_limits` (5 h primary, weekly secondary) as the server reported them.
 * - OpenCode: no limits are stored locally (it talks to many providers); its own SQLite database
 *   (`~/.local/share/opencode/opencode.db`) gives the tokens, cost and models used.
 */

export interface UsageWindow {
  /** 0–100. */
  used: number;
  /** Epoch ms, or null when unknown. */
  resetsAt: number | null;
}

export type UsageStatus = "loading" | "ok" | "missing" | "expired" | "error";

export interface ModelShare {
  model: string;
  /** 0–100 of the tokens in the period. */
  share: number;
}

export interface LimitUsage {
  status: UsageStatus;
  /** Short pt-BR reason when status isn't ok. */
  note: string;
  plan: string;
  session: UsageWindow | null;
  weekly: UsageWindow | null;
  /** Claude only: the weekly Opus/Sonnet sub-limit when the plan has one. */
  weeklyModel: (UsageWindow & { label: string }) | null;
  updated: number;
}

export interface LocalUsage {
  status: UsageStatus;
  note: string;
  /** Tokens in the last 5 hours and 7 days. */
  tokens5h: number;
  tokens7d: number;
  cost5h: number;
  cost7d: number;
  messages7d: number;
  top: ModelShare[];
  updated: number;
}

const emptyLimits = (): LimitUsage => ({ status: "loading", note: "", plan: "", session: null, weekly: null, weeklyModel: null, updated: 0 });
const emptyLocal = (): LocalUsage => ({ status: "loading", note: "", tokens5h: 0, tokens7d: 0, cost5h: 0, cost7d: 0, messages7d: 0, top: [], updated: 0 });

export const aiUsage = store({
  claude: emptyLimits(),
  /** Model mix of Claude Code over the last 7 days (local transcripts). */
  claudeModels: [] as ModelShare[],
  codex: emptyLimits(),
  opencode: emptyLocal(),
});

const HOME = process.env.USERPROFILE ?? process.env.HOME ?? "";
const HOUR = 3_600_000;
const WEEK = 7 * 24 * HOUR;

const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || join(HOME, ".claude");
const codexDir = () => process.env.CODEX_HOME || join(HOME, ".codex");
const opencodeDb = () => join(process.env.XDG_DATA_HOME || join(HOME, ".local", "share"), "opencode", "opencode.db");

/** Bytes [from, to) of a file, as text. */
function readRange(path: string, from: number, to: number): Uint8Array {
  const bytes = new Uint8Array(Math.max(0, to - from));
  const fd = openSync(path, "r");
  try {
    let done = 0;
    while (done < bytes.length) {
      const n = readSync(fd, bytes, done, bytes.length - done, from + done);
      if (n <= 0) break;
      done += n;
    }
    return done < bytes.length ? bytes.subarray(0, done) : bytes;
  } finally {
    closeSync(fd);
  }
}

const utf8 = new TextDecoder();

function mtime(path: string) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function entries(dir: string): { name: string; dir: boolean }[] {
  try {
    return (readdirSync(dir, { withFileTypes: true }) as { name: string; isDirectory(): boolean }[]).map((e) => ({ name: e.name, dir: e.isDirectory() }));
  } catch {
    return [];
  }
}

/** A window whose reset time has passed starts over at 0 %. */
function fresh(window: UsageWindow | null): UsageWindow | null {
  if (window?.resetsAt && window.resetsAt <= Date.now()) return { used: 0, resetsAt: null };
  return window;
}

/** Friendly model names: "claude-opus-4-5-20251101" -> "Opus 4.5". */
export function modelLabel(id: string) {
  const claude = /claude-(?:(\d+)-(\d+)-)?(opus|sonnet|haiku)(?:-(\d+)(?:-(\d{1,2})(?!\d))?)?/i.exec(id);
  if (claude) {
    const family = claude[3]!.charAt(0).toUpperCase() + claude[3]!.slice(1);
    const version = claude[1] ? `${claude[1]}.${claude[2]}` : claude[4] ? (claude[5] ? `${claude[4]}.${claude[5]}` : claude[4]) : "";
    return version ? `${family} ${version}` : family;
  }
  return id.replace(/^.*\//, "");
}

function shares(tally: Map<string, number>, limit = 3): ModelShare[] {
  const total = [...tally.values()].reduce((a, b) => a + b, 0);
  if (!total) return [];
  return [...tally.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([model, n]) => ({ model, share: Math.round((n / total) * 100) }));
}

// ---------------------------------------------------------------- Claude

interface ClaudeCredentials {
  claudeAiOauth?: { accessToken?: string; expiresAt?: number; subscriptionType?: string };
}

function claudeWindow(raw: unknown): UsageWindow | null {
  if (!raw || typeof raw !== "object") return null;
  const w = raw as { utilization?: number | null; resets_at?: string | null };
  if (typeof w.utilization !== "number") return null;
  const resetsAt = w.resets_at ? Date.parse(w.resets_at) : NaN;
  return { used: Math.max(0, Math.min(100, Math.round(w.utilization))), resetsAt: Number.isFinite(resetsAt) ? resetsAt : null };
}

let claudeBusy = false;

export async function refreshClaude() {
  if (claudeBusy) return;
  claudeBusy = true;
  const set = (patch: Partial<LimitUsage>) => (aiUsage.claude = { ...aiUsage.claude, ...patch, updated: Date.now() });
  try {
    const path = join(claudeDir(), ".credentials.json");
    if (!existsSync(path)) return set({ status: "missing", note: "não instalado" });
    const oauth = (JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")) as ClaudeCredentials).claudeAiOauth;
    if (!oauth?.accessToken) return set({ status: "missing", note: "sem login" });
    const plan = oauth.subscriptionType ? oauth.subscriptionType.charAt(0).toUpperCase() + oauth.subscriptionType.slice(1) : "";
    // Claude Code renews its own token; the dock never refreshes it (that would rewrite its file).
    if (oauth.expiresAt && oauth.expiresAt <= Date.now()) return set({ status: "expired", note: "abra o Claude Code", plan });
    const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: { Authorization: `Bearer ${oauth.accessToken}`, "anthropic-beta": "oauth-2025-04-20", Accept: "application/json" },
    });
    if (res.status === 401 || res.status === 403) return set({ status: "expired", note: "abra o Claude Code", plan });
    if (!res.ok) return set({ status: aiUsage.claude.session ? "ok" : "error", note: `erro ${res.status}`, plan });
    const body = (await res.json()) as Record<string, unknown>;
    const opus = claudeWindow(body.seven_day_opus);
    const sonnet = claudeWindow(body.seven_day_sonnet);
    const sub = opus && (!sonnet || opus.used >= sonnet.used) ? { ...opus, label: "Opus" } : sonnet ? { ...sonnet, label: "Sonnet" } : null;
    set({ status: "ok", note: "", plan, session: claudeWindow(body.five_hour), weekly: claudeWindow(body.seven_day), weeklyModel: sub });
  } catch (error) {
    set({ status: aiUsage.claude.session ? "ok" : "error", note: "sem conexão" });
    console.error("[ai-usage] claude", error);
  } finally {
    claudeBusy = false;
  }
}

interface ClaudeFile {
  mtime: number;
  /** Bytes parsed so far (up to the last complete line): a transcript only grows, so a refresh reads what was appended. */
  offset: number;
  /** [epoch ms, model, tokens] per assistant message. */
  rows: [number, string, number][];
  seen: Set<string>;
}
const claudeFiles = new Map<string, ClaudeFile>();

/** Adds the assistant messages appended to a transcript since the last read (all of it the first time). */
function parseClaudeTranscript(path: string, file: ClaudeFile) {
  const size = statSync(path).size;
  if (size < file.offset) Object.assign(file, { offset: 0, rows: [], seen: new Set() });
  const bytes = readRange(path, file.offset, size);
  const end = bytes.lastIndexOf(0x0a) + 1;
  if (!end) return;
  file.offset += end;
  const { rows, seen } = file;
  for (const line of utf8.decode(bytes.subarray(0, end)).split("\n")) {
    if (!line.includes('"assistant"') || !line.includes('"usage"')) continue;
    try {
      const entry = JSON.parse(line) as {
        timestamp?: string;
        requestId?: string;
        message?: { id?: string; model?: string; usage?: Record<string, number> };
      };
      const msg = entry.message;
      if (!msg?.model || !msg.usage || msg.model.startsWith("<")) continue;
      // A streamed reply is logged once per content block with the same usage.
      const key = `${msg.id}:${entry.requestId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const u = msg.usage;
      const tokens = (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      rows.push([Date.parse(entry.timestamp ?? "") || 0, msg.model, tokens]);
    } catch {}
  }
}

export function refreshClaudeModels() {
  const root = join(claudeDir(), "projects");
  if (!existsSync(root)) return;
  const since = Date.now() - WEEK;
  const live = new Set<string>();
  const walk = (dir: string, depth: number) => {
    for (const e of entries(dir)) {
      const path = join(dir, e.name);
      if (e.dir) {
        if (depth < 3) walk(path, depth + 1);
      } else if (e.name.endsWith(".jsonl")) {
        const m = mtime(path);
        if (m < since) continue;
        live.add(path);
        const file = claudeFiles.get(path) ?? { mtime: 0, offset: 0, rows: [], seen: new Set<string>() };
        if (file.mtime === m) continue;
          try {
            parseClaudeTranscript(path, file);
          file.mtime = m;
          claudeFiles.set(path, file);
        } catch {}
      }
    }
  };
  walk(root, 0);
  for (const key of [...claudeFiles.keys()]) if (!live.has(key)) claudeFiles.delete(key);
  const tally = new Map<string, number>();
  for (const file of claudeFiles.values())
    for (const [at, model, tokens] of file.rows) if (at >= since) tally.set(modelLabel(model), (tally.get(modelLabel(model)) ?? 0) + tokens);
  aiUsage.claudeModels = shares(tally);
}

// ---------------------------------------------------------------- Codex

interface CodexRateLimits {
  primary?: { used_percent?: number; window_minutes?: number; resets_at?: number } | null;
  secondary?: { used_percent?: number; window_minutes?: number; resets_at?: number } | null;
  plan_type?: string | null;
}

const codexWindow = (raw: CodexRateLimits["primary"]): UsageWindow | null =>
  raw && typeof raw.used_percent === "number"
    ? { used: Math.max(0, Math.min(100, Math.round(raw.used_percent))), resetsAt: raw.resets_at ? raw.resets_at * 1000 : null }
    : null;

let codexSeen = { path: "", mtime: 0 };

/**
 * The latest rate_limits snapshot in a rollout file, newest line first. Rollouts grow to tens of MB
 * and a token_count event follows every turn: the tail is read first, the whole file only when it
 * has none.
 */
function lastRateLimits(path: string): { limits: CodexRateLimits; at: number } | null {
  const size = statSync(path).size;
  for (let tail = 256 * 1024; ; tail *= 8) {
    const from = Math.max(0, size - tail);
    const lines = utf8.decode(readRange(path, from, size)).split("\n");
    // The first line of a tail is cut mid-way.
    for (let i = lines.length - 1; i >= (from ? 1 : 0); i--) {
      const line = lines[i]!;
      if (!line.includes('"rate_limits"') || !line.includes('"token_count"')) continue;
      try {
        const entry = JSON.parse(line) as { timestamp?: string; payload?: { rate_limits?: CodexRateLimits | null } };
        const limits = entry.payload?.rate_limits;
        if (limits?.primary || limits?.secondary) return { limits, at: Date.parse(entry.timestamp ?? "") || 0 };
      } catch {}
    }
    if (!from) return null;
  }
}

export function refreshCodex() {
  const set = (patch: Partial<LimitUsage>) => (aiUsage.codex = { ...aiUsage.codex, ...patch, updated: Date.now() });
  const root = join(codexDir(), "sessions");
  if (!existsSync(root)) return set({ status: "missing", note: "não instalado" });
  // sessions/YYYY/MM/DD: the newest few days, newest file first (a session keeps the folder of the day it began).
  const days: string[] = [];
  for (const y of entries(root).filter((e) => e.dir).map((e) => e.name).sort().reverse()) {
    for (const m of entries(join(root, y)).filter((e) => e.dir).map((e) => e.name).sort().reverse()) {
      for (const d of entries(join(root, y, m)).filter((e) => e.dir).map((e) => e.name).sort().reverse()) {
        days.push(join(root, y, m, d));
        if (days.length >= 3) break;
      }
      if (days.length >= 3) break;
    }
    if (days.length >= 3) break;
  }
  const files = days
    .flatMap((dir) => entries(dir).filter((e) => !e.dir && e.name.endsWith(".jsonl")).map((e) => join(dir, e.name)))
    .map((path) => ({ path, mtime: mtime(path) }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!files.length) return set({ status: "missing", note: "sem sessões" });
  if (codexSeen.path === files[0]!.path && codexSeen.mtime === files[0]!.mtime && aiUsage.codex.status === "ok") {
    // Nothing new: only let windows whose reset time passed start over.
    return set({ session: fresh(aiUsage.codex.session), weekly: fresh(aiUsage.codex.weekly) });
  }
  for (const file of files.slice(0, 6)) {
    const found = lastRateLimits(file.path);
    if (!found) continue;
    codexSeen = files[0]!;
    const plan = found.limits.plan_type ? found.limits.plan_type.charAt(0).toUpperCase() + found.limits.plan_type.slice(1) : "";
    return set({ status: "ok", note: "", plan, session: fresh(codexWindow(found.limits.primary)), weekly: fresh(codexWindow(found.limits.secondary)) });
  }
  set({ status: "error", note: "sem dados de limite" });
}

// ---------------------------------------------------------------- OpenCode

let ocDb: ReadonlyDatabase | null = null;
let ocBusy = false;

export async function refreshOpencode() {
  if (ocBusy) return;
  ocBusy = true;
  const set = (patch: Partial<LocalUsage>) => (aiUsage.opencode = { ...aiUsage.opencode, ...patch, updated: Date.now() });
  try {
    const path = opencodeDb();
    if (!existsSync(path)) return set({ status: "missing", note: "não instalado" });
    ocDb ??= await openReadonly(path);
    const now = Date.now();
    const since = Math.floor(now - WEEK);
    const rows = ocDb.all<{ at: number; provider: string | null; model: string | null; cost: number | null; tokens: number | null }>(
      `select time_created as at, json_extract(data,'$.model.providerID') as provider, json_extract(data,'$.model.id') as model,
         json_extract(data,'$.cost') as cost,
         coalesce(json_extract(data,'$.tokens.input'),0) + coalesce(json_extract(data,'$.tokens.output'),0) +
         coalesce(json_extract(data,'$.tokens.reasoning'),0) + coalesce(json_extract(data,'$.tokens.cache.write'),0) as tokens
       from session_message where type = 'assistant' and time_created >= ${since}`,
    );
    const next = emptyLocal();
    const tally = new Map<string, number>();
    for (const r of rows) {
      const tokens = Number(r.tokens) || 0;
      const cost = Number(r.cost) || 0;
      next.tokens7d += tokens;
      next.cost7d += cost;
      next.messages7d++;
      if (r.at >= now - 5 * HOUR) {
        next.tokens5h += tokens;
        next.cost5h += cost;
      }
      if (r.model) tally.set(modelLabel(r.model), (tally.get(modelLabel(r.model)) ?? 0) + tokens);
    }
    set({ ...next, status: "ok", top: shares(tally) });
  } catch (error) {
    // OpenCode writes to its database now and then; drop the handle and retry next tick.
    ocDb?.close();
    ocDb = null;
    if (!String(error).includes("locked")) {
      set({ status: aiUsage.opencode.status === "ok" ? "ok" : "error", note: "banco ilegível" });
      console.error("[ai-usage] opencode", error);
    }
  } finally {
    ocBusy = false;
  }
}

// ---------------------------------------------------------------- pollers

/** The usage endpoint is rate limited: every 5 minutes is plenty for a 5 h window. */
export const claudePoller = createPoller(5 * 60_000, refreshClaude);

/**
 * Local logs are read again when their folder changes: a lazy change notification in the shell-events
 * worker (FindFirstChangeNotification, subtree), held only while a widget shows them and reporting at
 * most once per 10 s while a session writes. The 5 h and 7 day windows also age with no new writes:
 * one slow re-read every 10 minutes moves them along.
 */
function fileDriven(id: WatchId, refresh: () => unknown) {
  const aging = createPoller(10 * 60_000, refresh);
  return {
    acquire(): () => void {
      const releaseAging = aging.acquire();
      const releaseWatch = acquireWatch(id);
      const off = onWatchChange([id], () => void refresh(), 500);
      return () => {
        off();
        releaseWatch();
        releaseAging();
      };
    },
  };
}

export const claudeModelsPoller = fileDriven("claudeProjects", refreshClaudeModels);
export const codexPoller = fileDriven("codexSessions", refreshCodex);
export const opencodePoller = fileDriven("opencode", refreshOpencode);

// ---------------------------------------------------------------- formatting

const weekdayFormat = new Intl.DateTimeFormat("pt-BR", { weekday: "short" });
const millionsFormat = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 });

/** "2h 13min", "45min", "seg 14:00" (more than a day away), "" when unknown. */
export function resetLabel(resetsAt: number | null) {
  if (!resetsAt) return "";
  const ms = resetsAt - Date.now();
  if (ms <= 0) return "agora";
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `${minutes}min`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}min`;
  const date = new Date(resetsAt);
  const day = weekdayFormat.format(date).replace(".", "");
  return `${day} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** "1,2 mi", "830 mil", "940". */
export function tokensLabel(n: number) {
  if (n >= 1e6) return `${millionsFormat.format(n / 1e6)} mi`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} mil`;
  return String(Math.round(n));
}
