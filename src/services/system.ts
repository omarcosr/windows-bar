import { store } from "@tarve/core";
import { cpuUsage, memoryStatus, powerStatus } from "../native/win32";
import { createPoller } from "./poller";

const HISTORY = 24;

export const system = store({
  cpu: 0,
  ram: 0,
  ramUsedGb: 0,
  ramTotalGb: 0,
  cpuHistory: [] as number[],
  battery: { hasBattery: false, percent: 0, charging: false },
});

cpuUsage(); // prime the first delta

export const systemPoller = createPoller(1500, () => {
  const cpu = Math.round(cpuUsage());
  const mem = memoryStatus();
  system.cpu = cpu;
  system.ram = mem.load;
  system.ramUsedGb = mem.used / 1024 ** 3;
  system.ramTotalGb = mem.total / 1024 ** 3;
  const history = [...system.cpuHistory, cpu].slice(-HISTORY);
  system.cpuHistory = history;
  const power = powerStatus();
  if (power.percent !== system.battery.percent || power.charging !== system.battery.charging) system.battery = power;
});
