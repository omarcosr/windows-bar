import { dlopen, ptr, toArrayBuffer } from "./ffi";
import { decodeWide, encodeWide } from "./wide";

/**
 * Temperatures from the two sources Windows itself exposes without a driver:
 *  - GPU: the graphics kernel (dxgkrnl) through D3DKMTQueryAdapterInfo(KMTQAITYPE_ADAPTERPERFDATA),
 *    the call Task Manager's GPU page reads ("Temperatura da GPU", fan, power). Only drivers that
 *    report it fill Temperature (WDDM 2.4+, usually dedicated GPUs); 0 means "not reported".
 *  - System: the ACPI thermal zones of the "Thermal Zone Information" performance counter set
 *    (the same data as WMI's Win32_PerfFormattedData_Counters_ThermalZoneInformation), read via PDH
 *    without admin. It is the firmware's zone, not a CPU core sensor: Windows has no documented
 *    CPU temperature API for user mode.
 */

const gdi32 = dlopen("gdi32.dll", {
  D3DKMTEnumAdapters2: { args: ["ptr"], returns: "i32" },
  D3DKMTQueryAdapterInfo: { args: ["ptr"], returns: "i32" },
  D3DKMTCloseAdapter: { args: ["ptr"], returns: "i32" },
});

const G = gdi32.symbols;

// d3dkmthk.h (SDK 10.0.26100)
const KMTQAITYPE_ADAPTERREGISTRYINFO = 8;
const KMTQAITYPE_ADAPTERTYPE = 15;
const KMTQAITYPE_PHYSICALADAPTERCOUNT = 30;
const KMTQAITYPE_ADAPTERPERFDATA = 62;
const KMTQAITYPE_ADAPTERPERFDATA_CAPS = 63;
const ADAPTERINFO_SIZE = 20; // hAdapter, LUID, NumOfSources, bPrecisePresentRegionsPreferred
const TYPE_RENDER = 1;
const TYPE_SOFTWARE = 4;
const TYPE_INDIRECT_DISPLAY = 64;

export interface GpuAdapter {
  handle: number;
  /** "NVIDIA GeForce RTX 4070" (ADAPTERREGISTRYINFO.AdapterString). */
  name: string;
  /** Physical GPUs behind this adapter (LDA chains have more than one). */
  physical: number;
  /** Fan RPM the driver can report (ADAPTERPERFDATA_CAPS.MaxFanRPM); 0 when it reports none. */
  maxFanRpm: number;
  /** °C where throttling begins / damage, from the caps; 0 when not reported. */
  warningC: number;
  maxC: number;
}

export interface GpuReading {
  adapter: GpuAdapter;
  index: number;
  /** °C, null when the driver reports no temperature. */
  temperature: number | null;
  /** Fan RPM, null when the adapter reports no fan. */
  fanRpm: number | null;
  /** Power draw in % of the board limit, null when not reported. */
  power: number | null;
}

const query = new Uint8Array(24);
const queryView = new DataView(query.buffer);

function queryInfo(handle: number, type: number, data: Uint8Array): boolean {
  queryView.setUint32(0, handle, true);
  queryView.setUint32(4, type, true);
  queryView.setBigUint64(8, BigInt(ptr(data)), true);
  queryView.setUint32(16, data.byteLength, true);
  return G.D3DKMTQueryAdapterInfo(query) >= 0;
}

function closeAdapter(handle: number) {
  const close = new Uint32Array([handle]);
  G.D3DKMTCloseAdapter(new Uint8Array(close.buffer));
}

/**
 * The physical GPUs (render-capable, not the Basic Render Driver, not indirect display), opened
 * with D3DKMTEnumAdapters2. The handles stay open until closeGpuAdapters().
 */
export function openGpuAdapters(): GpuAdapter[] {
  const head = new Uint8Array(16);
  const headView = new DataView(head.buffer);
  if (G.D3DKMTEnumAdapters2(head) < 0) return [];
  const count = headView.getUint32(0, true);
  if (!count) return [];
  const list = new Uint8Array(count * ADAPTERINFO_SIZE);
  headView.setUint32(0, count, true);
  headView.setBigUint64(8, BigInt(ptr(list)), true);
  if (G.D3DKMTEnumAdapters2(head) < 0) return [];
  const found = Math.min(count, headView.getUint32(0, true));
  const view = new DataView(list.buffer);
  const out: GpuAdapter[] = [];
  const type = new Uint8Array(4);
  const registry = new Uint8Array(4 * 520);
  const physical = new Uint8Array(4);
  const caps = new Uint8Array(40);
  const capsView = new DataView(caps.buffer);
  for (let i = 0; i < found; i++) {
    const handle = view.getUint32(i * ADAPTERINFO_SIZE, true);
    const flags = queryInfo(handle, KMTQAITYPE_ADAPTERTYPE, type) ? new DataView(type.buffer).getUint32(0, true) : 0;
    if (!(flags & TYPE_RENDER) || flags & (TYPE_SOFTWARE | TYPE_INDIRECT_DISPLAY)) {
      closeAdapter(handle);
      continue;
    }
    registry.fill(0);
    let name = "GPU";
    if (queryInfo(handle, KMTQAITYPE_ADAPTERREGISTRYINFO, registry)) {
      const text = decodeWide(registry.buffer, 0, 520);
      const end = text.indexOf("\0");
      name = (end < 0 ? text : text.slice(0, end)).trim() || name;
    }
    const n = queryInfo(handle, KMTQAITYPE_PHYSICALADAPTERCOUNT, physical) ? new DataView(physical.buffer).getUint32(0, true) : 1;
    caps.fill(0);
    const hasCaps = queryInfo(handle, KMTQAITYPE_ADAPTERPERFDATA_CAPS, caps);
    out.push({
      handle,
      name,
      physical: Math.max(1, n),
      maxFanRpm: hasCaps ? capsView.getUint32(24, true) : 0,
      maxC: hasCaps ? capsView.getUint32(28, true) / 10 : 0,
      warningC: hasCaps ? capsView.getUint32(32, true) / 10 : 0,
    });
  }
  return out;
}

export function closeGpuAdapters(adapters: readonly GpuAdapter[]) {
  for (const adapter of adapters) closeAdapter(adapter.handle);
}

const perf = new Uint8Array(64);
const perfView = new DataView(perf.buffer);

/** One ADAPTERPERFDATA per physical GPU; null when the adapter went away (re-open the list). */
export function readGpus(adapters: readonly GpuAdapter[]): GpuReading[] | null {
  const out: GpuReading[] = [];
  for (const adapter of adapters) {
    for (let index = 0; index < adapter.physical; index++) {
      perf.fill(0);
      perfView.setUint32(0, index, true);
      if (!queryInfo(adapter.handle, KMTQAITYPE_ADAPTERPERFDATA, perf)) return null;
      const fan = perfView.getUint32(48, true);
      const power = perfView.getUint32(52, true);
      const temperature = perfView.getUint32(56, true);
      out.push({
        adapter,
        index,
        temperature: temperature > 0 ? temperature / 10 : null,
        fanRpm: adapter.maxFanRpm > 0 || fan > 0 ? fan : null,
        power: power > 0 ? power / 10 : null,
      });
    }
  }
  return out;
}

// ---------- ACPI thermal zones (PDH) ----------

const pdh = dlopen("pdh.dll", {
  PdhOpenQueryW: { args: ["ptr", "u64", "ptr"], returns: "u32" },
  PdhAddEnglishCounterW: { args: ["ptr", "ptr", "u64", "ptr"], returns: "u32" },
  PdhCollectQueryData: { args: ["ptr"], returns: "u32" },
  PdhGetFormattedCounterArrayW: { args: ["ptr", "u32", "ptr", "ptr", "ptr"], returns: "u32" },
  PdhCloseQuery: { args: ["ptr"], returns: "u32" },
});

const P = pdh.symbols;
const PDH_FMT_DOUBLE = 0x200;
const PDH_MORE_DATA = 0x800007d2;
const ITEM_SIZE = 24; // PDH_FMT_COUNTERVALUE_ITEM_W: szName, { CStatus, double }

export interface ThermalZones {
  query: number;
  counter: number;
  /** "High Precision Temperature" is in tenths of a kelvin; "Temperature" in whole kelvin. */
  scale: number;
}

/** Opens a PDH query on every "Thermal Zone Information" instance; null when the set is missing. */
export function openThermalZones(): ThermalZones | null {
  const out = new BigUint64Array(1);
  if (P.PdhOpenQueryW(null, 0, new Uint8Array(out.buffer)) !== 0) return null;
  const query = Number(out[0]);
  for (const [name, scale] of [
    ["High Precision Temperature", 10],
    ["Temperature", 1],
  ] as const) {
    const counter = new BigUint64Array(1);
    if (P.PdhAddEnglishCounterW(query, encodeWide(`\\Thermal Zone Information(*)\\${name}`), 0, new Uint8Array(counter.buffer)) !== 0) continue;
    if (P.PdhCollectQueryData(query) !== 0) break;
    const zones = { query, counter: Number(counter[0]), scale };
    if (readThermalZones(zones).length) return zones;
    break;
  }
  P.PdhCloseQuery(query);
  return null;
}

let zoneBuf = new Uint8Array(1024);

/** Each zone's temperature in °C, by instance name ("\_TZ.TZ00"); empty when the read fails. */
export function readThermalZones(zones: ThermalZones, collect = false): { name: string; celsius: number }[] {
  if (collect && P.PdhCollectQueryData(zones.query) !== 0) return [];
  const sizes = new Uint32Array(2);
  const size = new Uint8Array(sizes.buffer, 0, 4);
  const count = new Uint8Array(sizes.buffer, 4, 4);
  sizes[0] = zoneBuf.byteLength;
  let status = P.PdhGetFormattedCounterArrayW(zones.counter, PDH_FMT_DOUBLE, size, count, zoneBuf);
  if (status === PDH_MORE_DATA) {
    zoneBuf = new Uint8Array(sizes[0]! + 256);
    sizes[0] = zoneBuf.byteLength;
    status = P.PdhGetFormattedCounterArrayW(zones.counter, PDH_FMT_DOUBLE, size, count, zoneBuf);
  }
  if (status !== 0) return [];
  const base = ptr(zoneBuf);
  const view = new DataView(zoneBuf.buffer);
  const out: { name: string; celsius: number }[] = [];
  for (let i = 0; i < sizes[1]!; i++) {
    const at = i * ITEM_SIZE;
    if (view.getUint32(at + 8, true) > 1) continue; // CStatus: PDH_CSTATUS_VALID_DATA / NEW_DATA
    const kelvin = view.getFloat64(at + 16, true) / zones.scale;
    if (!(kelvin > 200)) continue; // 0 K: the zone reports nothing
    out.push({ name: wideAt(Number(view.getBigUint64(at, true)), base), celsius: Math.round((kelvin - 273.15) * 10) / 10 });
  }
  return out;
}

function wideAt(address: number, base: number): string {
  if (!address) return "";
  const rel = address - base;
  const bytes = rel >= 0 && rel < zoneBuf.byteLength ? zoneBuf.subarray(rel) : new Uint8Array(toArrayBuffer(address, 0, 256));
  let end = 0;
  while (end + 1 < bytes.length && (bytes[end] || bytes[end + 1])) end += 2;
  return decodeWide(bytes.buffer, bytes.byteOffset, end);
}

export function closeThermalZones(zones: ThermalZones) {
  P.PdhCloseQuery(zones.query);
}
