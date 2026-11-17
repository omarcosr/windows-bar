import { store } from "@tarve/core";
import { diskSpace, networkOctets, processSnapshot, systemDriveRoot } from "../native/hardware-perf";
import { exePathOf } from "../native/win32";
import { createPoller } from "./poller";
import { onShellEvent } from "../native/shell-events";

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

function readStorage() {
  const root = systemDriveRoot();
  const space = diskSpace(root);
  storage.root = root;
  if (!space) return;
  storage.free = space.free;
  storage.total = space.total;
  storage.ready = true;
}

/**
 * Free space is read when the shell reports it changed (SHCNE_FREESPACE: emptying the Recycle Bin, shell
 * copies and deletes, a drive or medium coming or going; SHChangeNotifyRegister in shell-events.ts), as
 * Explorer's This PC follows it, instead of once a minute.
 */
export const storagePoller = {
  acquire(): () => void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    readStorage();
    const off = onShellEvent((event) => {
      if (event.type !== "freeSpace") return;
      clearTimeout(timer);
      timer = setTimeout(readStorage, 300);
    });
    return () => {
      clearTimeout(timer);
      off();
    };
  },
};

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

/**
 * Writes a top list only when what it shows changed (values compared at `unit`: 1 MB, 1 %), so
 * a sample that moves nothing visible renders nothing.
 */
function setIfChanged(key: "topRam" | "topCpu", next: TopProcess[], unit: number) {
  const shape = (list: readonly TopProcess[]) => JSON.stringify(list.map((p) => [p.name, p.count, Math.round(p.value / unit)]));
  if (shape(processes[key]) !== shape(next)) processes[key] = next;
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
    // "Memory Compression" is the kernel's store of compressed pages, not an app: Task Manager's
    // Processes list leaves it out (its RAM is counted as "Compactada" in Desempenho), so do we.
    if (p.pid === 0 || !p.name || p.name === "Memory Compression") continue;
    deltas.push({ pid: p.pid, name: p.name, delta });
    const group = p.name.toLowerCase();
    const r = ram.get(group) ?? { name: p.name, pid: p.pid, count: 0, value: 0 };
    r.count++;
    r.value += p.privateBytes;
    ram.set(group, r);
  }
  const primed = lastTimes.size > 0;
  lastTimes = times;
  setIfChanged("topRam", top(ram, 3), 2 ** 20);
  if (!primed || total <= 0n) return;
  for (const d of deltas) {
    const group = d.name.toLowerCase();
    const c = cpu.get(group) ?? { name: d.name, pid: d.pid, count: 0, value: 0 };
    c.count++;
    c.value += Number((d.delta * 10000n) / total) / 100;
    cpu.set(group, c);
  }
  setIfChanged("topCpu", top(cpu, 3), 1);
  if (!processes.ready) processes.ready = true;
});

// ---------- Formatting ----------

/** "12,3 MB" style sizes, binary units like Explorer. */
/** One pt-BR formatter per number of decimals: toLocaleString with options built one per call (~15 µs). */
const formatters = new Map<number, Intl.NumberFormat>();
function fixed(value: number, d: number) {
  let f = formatters.get(d);
  if (!f) formatters.set(d, (f = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: d, maximumFractionDigits: d })));
  return f.format(value);
}

export function formatBytes(bytes: number, digits = 1): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const d = unit === 0 ? 0 : value >= 100 ? 0 : digits;
  return `${fixed(value, d)} ${units[unit]}`;
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
  return `${fixed(value, d)} ${units[unit]}`;
}
