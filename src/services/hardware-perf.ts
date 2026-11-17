import { store } from "@tarve/core";
import { diskSpace, networkOctets, processSnapshot, systemDriveRoot } from "../native/hardware-perf";
import { exePathOf } from "../native/win32";
import { createPoller } from "./poller";

const HISTORY = 30;

// ---------- Network ----------

export const network = store({
  /** Bytes per second. */
  down: 0,
  up: 0,
  downHistory: [] as number[],
  upHistory: [] as number[],
  ready: false,
});

let lastNet: { received: number; sent: number; at: number } | null = null;

export const networkPoller = createPoller(1000, () => {
  const now = Date.now();
  const sample = networkOctets();
  if (!sample) return;
  const prev = lastNet;
  lastNet = { ...sample, at: now };
  if (!prev) return;
  const seconds = Math.max(0.25, (now - prev.at) / 1000);
  // An adapter going down or up changes the sum: never show a negative rate.
  const down = Math.max(0, (sample.received - prev.received) / seconds);
  const up = Math.max(0, (sample.sent - prev.sent) / seconds);
  network.down = down;
  network.up = up;
  network.downHistory = [...network.downHistory, down].slice(-HISTORY);
  network.upHistory = [...network.upHistory, up].slice(-HISTORY);
  network.ready = true;
});

// ---------- Storage ----------

export const storage = store({ root: "C:\\", free: 0, total: 0, ready: false });

export const storagePoller = createPoller(60_000, () => {
  const root = systemDriveRoot();
  const space = diskSpace(root);
  storage.root = root;
  if (!space) return;
  storage.free = space.free;
  storage.total = space.total;
  storage.ready = true;
});

// ---------- Processes ----------

export interface TopProcess {
  /** Image name without ".exe". */
  name: string;
  /** Full exe path of one of its processes (for the icon), "" when access is denied. */
  path: string;
  /** Number of processes grouped under it. */
  count: number;
  /** CPU share 0..100 (topCpu) or private working set in bytes (topRam). */
  value: number;
}

export const processes = store({
  topCpu: [] as TopProcess[],
  topRam: [] as TopProcess[],
  ready: false,
});

let lastTimes = new Map<string, bigint>();

const displayName = (image: string) => image.replace(/\.exe$/i, "");

function top(groups: Map<string, { name: string; pid: number; count: number; value: number }>, n: number): TopProcess[] {
  return [...groups.values()]
    .sort((a, b) => b.value - a.value)
    .slice(0, n)
    .map((g) => ({ name: displayName(g.name), path: exePathOf(g.pid), count: g.count, value: g.value }));
}

export const processPoller = createPoller(2000, () => {
  const list = processSnapshot();
  if (!list.length) return;
  const times = new Map<string, bigint>();
  let total = 0n;
  const cpu = new Map<string, { name: string; pid: number; count: number; value: number }>();
  const ram = new Map<string, { name: string; pid: number; count: number; value: number }>();
  const deltas: { pid: number; name: string; delta: bigint }[] = [];
  for (const p of list) {
    const key = `${p.pid}:${p.created}`;
    times.set(key, p.cpuTime);
    const prev = lastTimes.get(key);
    const delta = prev !== undefined && p.cpuTime > prev ? p.cpuTime - prev : 0n;
    // The idle process (pid 0) takes the unused share: all deltas together are the elapsed CPU time.
    total += delta;
    if (p.pid === 0 || !p.name) continue;
    deltas.push({ pid: p.pid, name: p.name, delta });
    const group = p.name.toLowerCase();
    const r = ram.get(group) ?? { name: p.name, pid: p.pid, count: 0, value: 0 };
    r.count++;
    r.value += p.privateBytes;
    ram.set(group, r);
  }
  const primed = lastTimes.size > 0;
  lastTimes = times;
  processes.topRam = top(ram, 3);
  if (!primed || total <= 0n) return;
  for (const d of deltas) {
    const group = d.name.toLowerCase();
    const c = cpu.get(group) ?? { name: d.name, pid: d.pid, count: 0, value: 0 };
    c.count++;
    c.value += Number((d.delta * 10000n) / total) / 100;
    cpu.set(group, c);
  }
  processes.topCpu = top(cpu, 3);
  processes.ready = true;
});

// ---------- Formatting ----------

/** "12,3 MB" style sizes, binary units like Explorer. */
export function formatBytes(bytes: number, digits = 1): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const d = unit === 0 ? 0 : value >= 100 ? 0 : digits;
  return `${value.toLocaleString("pt-BR", { minimumFractionDigits: d, maximumFractionDigits: d })} ${units[unit]}`;
}

/** Network rate in bits per second like Task Manager ("2,4 Mbps"). */
export function formatRate(bytesPerSecond: number): string {
  const bits = bytesPerSecond * 8;
  const units = ["bps", "Kbps", "Mbps", "Gbps"];
  let value = bits;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  const d = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toLocaleString("pt-BR", { minimumFractionDigits: d, maximumFractionDigits: d })} ${units[unit]}`;
}
