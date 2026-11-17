
/**
 * Diagnostics, off unless WINDOWSBAR_PERF=1: times every timer callback, microtask (renders) and
 * worker message by where it came from, and the event loop's lag; prints a report every 30 s.
 * Import it before anything else.
 */
const enabled = process.env.WINDOWSBAR_PERF === "1";

interface Site { calls: number; total: number; max: number }
const sites = new Map<string, Site>();
let lagMax = 0;
let lagTotal = 0;
let lagSamples = 0;
let started = performance.now();
let cpuMark = enabled ? process.cpuUsage() : undefined;
let rssMark = enabled ? process.memoryUsage().rss : 0;
const statWindows = new Map<string, (options: { reset: boolean }) => Promise<unknown>>();

/** The first frame in the app's own code (not this file, not a dependency): who wrote to a store. */
function appFrame(): string {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 40;
  const stack = new Error().stack ?? "";
  Error.stackTraceLimit = limit;
  const lines = stack.split("\n").slice(3).map((l) => l.trim().replace(/^at /, ""));
  const where = lines.find((l) => /[\\/]src[\\/]/.test(l) && !/perf-probe|node_modules/.test(l)) ?? lines[0] ?? "?";
  return where.replace(/^(\S+) \(.*[\\/]/, "$1 @ ").replace(/^.*[\\/]/, "");
}

function origin(fn: Function): string {
  const lines = (new Error().stack ?? "").split("\n").slice(3, 6).map((l) => l.trim().replace(/^at /, ""));
  const where = lines.find((l) => !/perf-probe/.test(l)) ?? "?";
  return `${fn.name || "anonymous"} @ ${where.replace(/^.*[\\/]/, "")}`;
}

/** Counts native events of a window (`handle.onEvent`) by type when the probe is on. */
export function probeEvents(name: string, handle: { onEvent(listener: (event: { type: string }) => void): unknown; stats?(options: { reset: boolean }): Promise<unknown> }) {
  if (!enabled) return;
  // The window's own counters (renders and their phases in JS, frames and paint time on the native side), printed with each report.
  if (handle.stats) statWindows.set(name, handle.stats.bind(handle));
  handle.onEvent((event) => {
    const key = `event ${name} ${event.type}${"id" in event && event.id ? " " + String(event.id).slice(0, 40) : ""}`;
    let s = sites.get(key);
    if (!s) sites.set(key, (s = { calls: 0, total: 0, max: 0 }));
    s.calls++;
  });
}

/** Times `fn` under `key` when the probe is on; otherwise just runs it. */
export function measure<T>(key: string, fn: () => T): T {
  if (!enabled) return fn();
  return wrap(fn, key)() as T;
}

function wrap(fn: Function, key: string) {
  return function (this: unknown, ...args: unknown[]) {
    const t0 = performance.now();
    try {
      return fn.apply(this, args);
    } finally {
      const ms = performance.now() - t0;
      let s = sites.get(key);
      if (!s) sites.set(key, (s = { calls: 0, total: 0, max: 0 }));
      s.calls++;
      s.total += ms;
      if (ms > s.max) s.max = ms;
    }
  };
}

function report() {
  const span = (performance.now() - started) / 1000;
  const rows = [...sites.entries()].sort((a, b) => b[1].total - a[1].total || b[1].calls - a[1].calls).slice(0, 40);
  // Process CPU (all threads, native included) and memory next to the JS sites, to tell JS cost from native/worker cost.
  const cpu = process.cpuUsage(cpuMark);
  cpuMark = process.cpuUsage();
  const mem = process.memoryUsage();
  const mb = (n: number) => (n / 1048576).toFixed(1);
  const lines = [
    `--- ${new Date().toISOString()} window ${span.toFixed(1)} s | loop lag avg ${(lagTotal / Math.max(1, lagSamples)).toFixed(1)} ms max ${lagMax.toFixed(0)} ms`,
    `    process cpu ${(((cpu.user + cpu.system) / 1000 / span) / 10).toFixed(2)}% core (user ${(cpu.user / 1e6).toFixed(2)} s sys ${(cpu.system / 1e6).toFixed(2)} s) | rss ${mb(mem.rss)} MB (${mem.rss >= rssMark ? "+" : ""}${mb(mem.rss - rssMark)}) heap ${mb(mem.heapUsed)}/${mb(mem.heapTotal)} MB external ${mb(mem.external)} MB`,
    ...rows.map(([k, s]) => `${((s.total / span) / 10).toFixed(2).padStart(6)}% core  ${s.calls.toString().padStart(6)}x  avg ${(s.total / s.calls).toFixed(2).padStart(7)} ms  max ${s.max.toFixed(1).padStart(7)} ms  ${k}`),
  ];
  rssMark = mem.rss;
  console.log(lines.join("\n"));
  for (const [name, stats] of statWindows) {
    stats({ reset: true }).then(
      (s) => console.log(`    stats ${name}: ${JSON.stringify(s)}`),
      (error) => console.log(`    stats ${name}: ${error}`),
    );
  }
  sites.clear();
  lagMax = lagTotal = lagSamples = 0;
  started = performance.now();
}

if (enabled) {
  const g = globalThis as Record<string, any>;
  const si = g.setInterval.bind(globalThis);
  const st = g.setTimeout.bind(globalThis);
  g.setInterval = (fn: Function, ms?: number, ...rest: unknown[]) => si(wrap(fn, `interval ${ms ?? 0}ms ${origin(fn)}`), ms, ...rest);
  g.setTimeout = (fn: Function, ms?: number, ...rest: unknown[]) => st(wrap(fn, `timeout ${origin(fn)}`), ms, ...rest);
  // Renders and store reactions are scheduled as microtasks.
  const qm = g.queueMicrotask.bind(globalThis);
  // A chain of microtasks that never ends starves every timer (the app hangs at 100% CPU with no
  // report): count them between two macrotasks and print where they come from once it runs away.
  let chain = 0;
  let reported = false;
  const chainSites = new Map<string, number>();
  g.queueMicrotask = (fn: Function) => {
    const key = `microtask ${origin(fn)} ${fn.name ? "" : String(fn).replace(/\s+/g, " ").slice(0, 70)}`;
    if (++chain > 20_000) {
      chainSites.set(key, (chainSites.get(key) ?? 0) + 1);
      if (chain > 40_000 && !reported) {
        reported = true;
        console.log(`[perf] runaway microtask chain (${chain}):\n` + [...chainSites].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, n]) => `  ${n}x ${k}`).join("\n") + "\n" + new Error().stack);
      }
    }
    // A store write schedules one flush that re-renders every open window: count who wrote.
    if (!fn.name && String(fn).includes("[...listeners]")) {
      const at = `store write (flush) ${appFrame()}`;
      const s = sites.get(at) ?? { calls: 0, total: 0, max: 0 };
      s.calls++;
      sites.set(at, s);
    }
    return qm(wrap(fn, key));
  };
  si(() => {
    chain = 0;
    chainSites.clear();
  }, 50);
  // Event loop lag: how late a 100 ms tick fires.
  let expected = performance.now() + 100;
  si(() => {
    const now = performance.now();
    const lag = Math.max(0, now - expected);
    lagTotal += lag;
    lagSamples++;
    if (lag > lagMax) lagMax = lag;
    expected = now + 100;
  }, 100);
  si(report, 30_000);
  // WINDOWSBAR_PERF_STRESS=config: from WINDOWSBAR_PERF_STRESS_AT s on (default 20), changes and saves
  // a few settings every 300 ms for 30 s, like a user dragging sliders in the settings window, then
  // puts the original values back. Only the main thread loads this file (workers run plain source
  // strings), and node:worker_threads does not exist under txiki, so no thread check.
  if (process.env.WINDOWSBAR_PERF_STRESS === "config") {
    {
      st(async () => {
        const { config, saveConfig } = await import("../config");
        const c = config as unknown as Record<string, number>;
        const keys = ["opacity", "widgetGap", "hoverIntensity", "cornerRadius"] as const;
        const original = Object.fromEntries(keys.map((k) => [k, c[k]])) as Record<(typeof keys)[number], number>;
        console.log("[perf] config stress: start");
        let n = 0;
        const timer = si(() => {
          n++;
          c.opacity = n % 2 ? 0.95 : original.opacity;
          c.widgetGap = original.widgetGap + (n % 4);
          c.hoverIntensity = original.hoverIntensity + (n % 3) * 10;
          c.cornerRadius = original.cornerRadius + (n % 2);
          saveConfig();
        }, 300);
        st(() => {
          clearInterval(timer);
          Object.assign(c, original);
          saveConfig();
          console.log(`[perf] config stress: end (${n} changes)`);
        }, 30_000);
      }, Number(process.env.WINDOWSBAR_PERF_STRESS_AT ?? 20) * 1000);
    }
  }
}
