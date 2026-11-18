import { store } from "@tarve/core";
import {
  closeGpuAdapters,
  openGpuAdapters,
  openThermalZones,
  readGpus,
  readThermalZones,
  type GpuAdapter,
  type ThermalZones,
} from "../native/thermal";
import { createPoller } from "./poller";

/**
 * Sampled temperatures (Windows sends no change notification for sensors): every 2 s while a
 * widget uses them and the dock can be seen (createPoller rests while covered or away).
 * See native/thermal.ts for the sources.
 */

const SAMPLE_MS = 2000;
const HISTORY = 30;

export interface GpuTemperature {
  name: string;
  celsius: number;
  /** °C where the driver says the GPU throttles / is at its limit; 0 when not reported. */
  warningC: number;
  maxC: number;
  fanRpm: number | null;
}

export const thermal = store({
  /** True once the GPUs were read at least once. */
  gpuRead: false,
  /** GPUs whose driver reports a temperature (Task Manager's "Temperatura da GPU"), hottest first. */
  gpus: [] as GpuTemperature[],
  /** Temperature history of the hottest GPU, oldest first. */
  gpuHistory: [] as number[],
  /** True once the thermal zones were probed (the first open of PDH costs ~0.3 s, measured). */
  zonesRead: false,
  /**
   * Hottest ACPI thermal zone in °C, null when the machine has none or its zones never change
   * (a static firmware value, as many desktops and VMs report).
   */
  zone: null as number | null,
});

// ---------- GPU ----------

let adapters: GpuAdapter[] | null = null;

function sampleGpus() {
  adapters ??= openGpuAdapters();
  let readings = readGpus(adapters);
  if (!readings) {
    // An adapter went away (driver update, eGPU unplugged): open the list again.
    closeGpuAdapters(adapters);
    adapters = openGpuAdapters();
    readings = readGpus(adapters) ?? [];
  }
  const gpus: GpuTemperature[] = [];
  for (const r of readings) {
    if (r.temperature === null) continue;
    gpus.push({ name: r.adapter.name, celsius: r.temperature, warningC: r.adapter.warningC, maxC: r.adapter.maxC, fanRpm: r.fanRpm });
  }
  gpus.sort((a, b) => b.celsius - a.celsius);
  thermal.gpus = gpus;
  thermal.gpuHistory = gpus[0] ? [...thermal.gpuHistory, gpus[0].celsius].slice(-HISTORY) : [];
  thermal.gpuRead = true;
}

const gpuPoller = createPoller(SAMPLE_MS, sampleGpus);
let gpuUsers = 0;

/** GPU temperatures while acquired; the adapter handles are closed when the last user leaves. */
export const gpuThermal = {
  acquire(): () => void {
    gpuUsers++;
    const release = gpuPoller.acquire();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
      if (--gpuUsers === 0 && adapters) {
        closeGpuAdapters(adapters);
        adapters = null;
      }
    };
  },
};

// ---------- ACPI thermal zones ----------

/** Opened once: false when the counter set has no instance on this machine. */
let zones: ThermalZones | null | false = null;
/** First value of each zone; a zone counts once it moved away from it. */
const firstValue = new Map<string, number>();
const live = new Set<string>();

function sampleZones() {
  if (zones === null) zones = openThermalZones() ?? false;
  thermal.zonesRead = true;
  if (!zones) return;
  let hottest: number | null = null;
  for (const zone of readThermalZones(zones, true)) {
    const first = firstValue.get(zone.name);
    if (first === undefined) firstValue.set(zone.name, zone.celsius);
    else if (first !== zone.celsius) live.add(zone.name);
    if (live.has(zone.name) && (hottest === null || zone.celsius > hottest)) hottest = zone.celsius;
  }
  thermal.zone = hottest;
}

/** The hottest live ACPI thermal zone while acquired. The PDH query stays open (reopening is ~0.2 ms but the first open is not). */
export const zoneThermal = createPoller(SAMPLE_MS, sampleZones);

// ---------- Both ----------

export interface Hottest {
  celsius: number;
  /** "GPU" or "Zona térmica (ACPI)". */
  source: string;
  /** Upper end of the gauge: the GPU's reported limit, else 100 °C. */
  maxC: number;
}

/** The hottest available sensor, or null when none reports. */
export function hottestSensor(): Hottest | null {
  const gpu = thermal.gpus[0];
  const zone = thermal.zone;
  if (gpu && (zone === null || gpu.celsius >= zone)) return { celsius: gpu.celsius, source: "GPU", maxC: gpu.maxC || 100 };
  if (zone !== null) return { celsius: zone, source: "Zona térmica (ACPI)", maxC: 100 };
  return null;
}
