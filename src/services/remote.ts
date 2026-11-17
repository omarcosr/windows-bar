import { HttpError } from "./online-http";
import { dockCovered, onDockCoveredChange } from "./poller";
import { onShellEvent } from "../native/shell-events";

/**
 * Remote data (weather, rates, APIs) has no push channel, so it is refreshed on a period, but
 * each refresh is made as cheap as the server allows, the way a browser's HTTP cache does:
 *  - Cache-Control max-age (minus Age) is honoured: within it the answer is served from memory.
 *  - ETag / Last-Modified are sent back (If-None-Match / If-Modified-Since): an unchanged
 *    resource costs a 304 without a body (and GitHub does not count it against the rate limit).
 *  - Retry-After on 429/503 (and GitHub's X-RateLimit-Reset at 0 remaining) holds that origin.
 *  - Requests for the same resource in flight at once are shared (several widget instances).
 * refreshLoop() runs the period: it rests while the dock is covered by a full-screen app, backs
 * off exponentially after failures (offline, bad key) and retries at once when the network is
 * back: an IP address changed (NotifyAddrChange, the shell-events "network" event) or a request
 * succeeded anywhere. After sleep ("resume") the backoff ends too and whatever came due runs.
 */

export interface RemoteResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  text: string;
  /** The server answered 304: the body is the one kept from before. */
  notModified: boolean;
}

interface Entry {
  status: number;
  headers: [string, string][];
  body: string;
  etag?: string;
  lastModified?: string;
  freshUntil: number;
}

const TIMEOUT = 15_000;
const MAX_ENTRIES = 64;
const entries = new Map<string, Entry>();
const inflight = new Map<string, Promise<RemoteResponse>>();
const heldUntil = new Map<string, number>();

/** Counters for measuring (REMOTE_DEBUG=1 logs each request). */
export const remoteStats = { sent: 0, notModified: 0, fromMemory: 0, shared: 0, failed: 0 };
const debug = !!process.env.REMOTE_DEBUG;

let offline = false;
const backListeners = new Set<() => void>();

/** Runs fn when a request reaches the network again after one failed to; returns the unsubscribe function. */
export function onNetworkBack(fn: () => void): () => void {
  backListeners.add(fn);
  return () => backListeners.delete(fn);
}

function reached() {
  if (!offline) return;
  offline = false;
  for (const fn of backListeners) fn();
}

/** What the system said since the last settle: an address changed, or the PC woke up. */
type Wake = "network" | "resume";
const wakeListeners = new Set<(reason: Wake) => void>();
/** Addresses change in bursts (DHCP, IPv6 privacy addresses) and DNS follows a moment later. */
const SETTLE = 2_000;
let settle: ReturnType<typeof setTimeout> | undefined;
let pending = new Set<Wake>();
let offShell: (() => void) | undefined;

function onSystemWake(fn: (reason: Wake) => void): () => void {
  wakeListeners.add(fn);
  offShell ??= onShellEvent((event) => {
    if (event.type !== "network" && event.type !== "resume") return;
    pending.add(event.type);
    clearTimeout(settle);
    settle = setTimeout(() => {
      const reasons = pending;
      pending = new Set();
      if (reasons.has("resume")) offline = false;
      for (const reason of reasons) for (const listener of [...wakeListeners]) listener(reason);
    }, SETTLE);
  });
  return () => {
    wakeListeners.delete(fn);
    if (wakeListeners.size) return;
    offShell?.();
    offShell = undefined;
    clearTimeout(settle);
    pending.clear();
  };
}

function maxAge(headers: Headers) {
  const cc = headers.get("cache-control") ?? "";
  if (/no-store|no-cache/i.test(cc)) return 0;
  const m = /(?:^|[,\s])max-age=(\d+)/i.exec(cc);
  if (!m) return 0;
  return Math.max(0, Number(m[1]) - (Number(headers.get("age")) || 0)) * 1000;
}

function retryAfter(headers: Headers) {
  const value = headers.get("retry-after");
  if (!value) return 60_000;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 60_000;
}

function response(e: Entry, notModified: boolean): RemoteResponse {
  return { status: e.status, ok: e.status >= 200 && e.status < 300, headers: new Headers(e.headers), text: e.body, notModified };
}

async function request(key: string, url: string, headers: Record<string, string>, label: string): Promise<RemoteResponse> {
  const origin = new URL(url).origin;
  if ((heldUntil.get(origin) ?? 0) > Date.now()) throw new HttpError(429, `${label} 429`);
  const entry = entries.get(key);
  if (entry && entry.freshUntil > Date.now()) {
    remoteStats.fromMemory++;
    return response(entry, false);
  }
  const sent = { ...headers };
  if (entry?.etag) sent["If-None-Match"] = entry.etag;
  if (entry?.lastModified) sent["If-Modified-Since"] = entry.lastModified;
  let res: Response;
  try {
    remoteStats.sent++;
    res = await fetch(url, { headers: sent, signal: AbortSignal.timeout(TIMEOUT) });
  } catch (error) {
    remoteStats.failed++;
    offline = true;
    throw error;
  }
  reached();
  if (debug) console.log("[remote]", res.status, label, url.slice(0, 100));
  if (res.status === 304 && entry) {
    remoteStats.notModified++;
    entry.freshUntil = Date.now() + maxAge(res.headers);
    return response(entry, true);
  }
  if (res.status === 429 || res.status === 503) heldUntil.set(origin, Date.now() + retryAfter(res.headers));
  else if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(res.headers.get("x-ratelimit-reset")) * 1000;
    if (reset > Date.now()) heldUntil.set(origin, reset);
  }
  const next: Entry = {
    status: res.status,
    headers: [...res.headers],
    body: await res.text(),
    etag: res.headers.get("etag") ?? undefined,
    lastModified: res.headers.get("last-modified") ?? undefined,
    freshUntil: Date.now() + maxAge(res.headers),
  };
  entries.delete(key);
  if (res.ok && (next.etag || next.lastModified || next.freshUntil > Date.now())) {
    entries.set(key, next);
    if (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!);
  }
  return response(next, false);
}

/** A GET through the cache rules above; requests for the same URL and headers in flight are shared. */
export function remoteGet(url: string, headers: Record<string, string> = {}, label = new URL(url).host): Promise<RemoteResponse> {
  const key = `${url}\n${JSON.stringify(headers)}`;
  const pending = inflight.get(key);
  if (pending) {
    remoteStats.shared++;
    return pending;
  }
  const promise = request(key, url, headers, label).finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

/** remoteGet + JSON, throwing HttpError("<label> <status>: <detail>") like online-http's getJson. */
export async function remoteJson<T>(url: string, headers: Record<string, string>, label: string): Promise<{ body: T; res: RemoteResponse }> {
  const res = await remoteGet(url, { Accept: "application/json", ...headers }, label);
  if (!res.ok) throw new HttpError(res.status, `${label} ${res.status}${res.text ? `: ${res.text.slice(0, 160)}` : ""}`);
  return { body: JSON.parse(res.text) as T, res };
}

/** "Atualizar agora": the next request revalidates even what max-age still covers. */
export function expireRemote() {
  for (const entry of entries.values()) entry.freshUntil = 0;
}

/** The URL of rel="next" in a Link header (GitHub pagination). */
export function nextLinkOf(res: { headers: Headers }): string | null {
  const m = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") ?? "");
  return m ? m[1]! : null;
}

export interface RefreshOptions {
  /** The period in ms; read after each run (a setting, or when the source says it changes next). */
  every: number | (() => number);
  /** Read after each run: true when it failed without throwing (a widget that shows its error). */
  failed?: () => boolean;
  label?: string;
}

/** Backed-off retries never wait longer than this (or the period, when it is longer). */
const BACKOFF_CAP = 60 * 60_000;

/**
 * Runs `run` now and again every `every` ms (a one-shot timer re-armed after each run, so runs never
 * overlap). While nothing can be seen (dockCovered(): behind a full-screen app, session locked or display off) a due run waits and happens when it comes back. After n
 * failures in a row the wait is every·2^n (up to an hour); the first request that reaches the
 * network again anywhere, an IP address change or a resume from sleep ends the wait.
 */
export function refreshLoop(run: () => unknown, options: RefreshOptions) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let stopped = false;
  let missed = false;
  let fails = 0;
  /** now() while a run is under way: one more run when it ends (its settings changed). */
  let again = false;
  const period = () => (typeof options.every === "function" ? options.every() : options.every);
  const delay = () => {
    const base = period();
    return fails ? Math.min(Math.max(base, BACKOFF_CAP), base * 2 ** fails) : base;
  };
  /** When the armed run is due (wall clock: a timer may not count the time the PC slept). */
  let dueAt = Infinity;
  const arm = (ms: number) => {
    clearTimeout(timer);
    const wait = Math.max(1000, ms);
    dueAt = Date.now() + wait;
    timer = setTimeout(fire, wait);
  };
    const tick = (rerun = false): Promise<void> => {
    if (running) {
      again ||= rerun;
      return running;
    }
    clearTimeout(timer);
    dueAt = Infinity;
    missed = false;
    let result: Promise<unknown>;
    try {
      result = Promise.resolve(run());
    } catch (error) {
      result = Promise.reject(error);
    }
    const current = result
      .then(
        () => !!options.failed?.(),
        (error) => {
          console.error(options.label ?? "[remote]", error);
          return true;
        },
      )
      .then((failed) => {
        fails = failed ? fails + 1 : 0;
        running = undefined;
        if (stopped) return;
        if (again) {
          again = false;
          return tick();
        }
        arm(delay());
      });
    running = current;
    return current;
  };
  function fire() {
    if (stopped) return;
    if (dockCovered()) missed = true;
    else void tick();
  }
  const offCovered = onDockCoveredChange(() => {
    if (!stopped && missed && !dockCovered()) void tick();
  });
  const offBack = onNetworkBack(() => {
    if (stopped || !fails || running) return;
    if (dockCovered()) missed = true;
    else void tick();
  });
  // The network came back (an address changed): what failed retries now, with the backoff reset.
  // After sleep: the backoff ends, and a run that came due while asleep happens now.
  const offWake = onSystemWake((reason) => {
    if (stopped || running) return;
    const due = fails > 0 || (reason === "resume" && Date.now() >= dueAt);
    if (!due) return;
    fails = 0;
    if (dockCovered()) missed = true;
    else void tick();
  });
  void tick();
  return {
    /** Runs now (a setting changed, "Atualizar agora"); the period restarts from here. */
    now: () => tick(true),
    stop() {
      stopped = true;
      clearTimeout(timer);
      offCovered();
      offBack();
      offWake();
    },
  };
}

/** A refreshLoop owned by a widget instance: stopped with it (a gallery preview reads once). */
export function refreshWidget(
  ctx: { onDispose(fn: () => void): void },
  every: RefreshOptions["every"],
  run: () => unknown,
  failed?: () => boolean,
) {
  const loop = refreshLoop(run, { every, failed, label: "[widget]" });
  ctx.onDispose(loop.stop);
  return loop;
}

/**
 * A refreshLoop shared by whoever acquires it (several widgets showing the same data): it runs
 * while there is at least one user.
 */
export function sharedRefresh(run: () => unknown, options: RefreshOptions) {
  let users = 0;
  let loop: ReturnType<typeof refreshLoop> | undefined;
  return {
    acquire(): () => void {
      if (users++ === 0) loop = refreshLoop(run, options);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (--users === 0) {
          loop?.stop();
          loop = undefined;
        }
      };
    },
    now: () => loop?.now(),
  };
}
