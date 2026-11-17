
/**
 * Diagnostics, off unless WINDOWSBAR_PERF=1: times every timer callback (setInterval/setTimeout)
 * by where it was scheduled, and the event loop's lag, and prints a report to stdout every 30 s.
 * Import it before anything else.
 */
const enabled = process.env.WINDOWSBAR_PERF === "1";

interface Site { calls: number; total: number; max: number }
const sites = new Map<string, Site>();
let lagMax = 0;
let lagTotal = 0;
let lagSamples = 0;
let started = performance.now();

function origin(fn: Function): string {
  const lines = (new Error().stack ?? "").split("\n").slice(3, 6).map((l) => l.trim().replace(/^at /, ""));
  const where = lines.find((l) => !/perf-probe/.test(l)) ?? "?";
  return `${fn.name || "anonymous"} @ ${where.replace(/^.*[\\/]/, "")}`;
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
  const rows = [...sites.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, 25);
  const lines = [
    `--- ${new Date().toISOString()} window ${span.toFixed(1)} s | loop lag avg ${(lagTotal / Math.max(1, lagSamples)).toFixed(1)} ms max ${lagMax.toFixed(0)} ms`,
    ...rows.map(([k, s]) => `${((s.total / span) / 10).toFixed(2).padStart(6)}% core  ${s.calls.toString().padStart(6)}x  avg ${(s.total / s.calls).toFixed(2).padStart(7)} ms  max ${s.max.toFixed(1).padStart(7)} ms  ${k}`),
  ];
  console.log(lines.join("\n"));
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
}
