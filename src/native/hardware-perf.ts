import { dlopen, ptr, toArrayBuffer } from "./ffi";
import { decodeWide, encodeWide } from "./wide";

/**
 * Hardware counters read from the same sources Task Manager uses: the IP Helper interface table
 * (GetIfTable2) for network throughput, GetDiskFreeSpaceExW for drives and the process list of
 * NtQuerySystemInformation(SystemProcessInformation) for per-process CPU time and private working set.
 */

const iphlpapi = dlopen("iphlpapi.dll", {
  GetIfTable2: { args: ["ptr"], returns: "u32" },
  FreeMibTable: { args: ["ptr"], returns: "void" },
  GetIfEntry2: { args: ["ptr"], returns: "u32" },
});

const kernel32 = dlopen("kernel32.dll", {
  GetDiskFreeSpaceExW: { args: ["ptr", "ptr", "ptr", "ptr"], returns: "i32" },
  GetSystemWindowsDirectoryW: { args: ["ptr", "u32"], returns: "u32" },
});

const ntdll = dlopen("ntdll.dll", {
  NtQuerySystemInformation: { args: ["u32", "ptr", "u32", "ptr"], returns: "i32" },
});

const I = iphlpapi.symbols;
const K = kernel32.symbols;
const N = ntdll.symbols;

// ---------- Network (MIB_IF_TABLE2 / MIB_IF_ROW2, x64 layout) ----------

const ROW = 1352;
const TABLE_HEADER = 8;
const OFF_TYPE = 1128;
const OFF_FLAGS = 1152; // InterfaceAndOperStatusFlags bitfield
const OFF_OPER = 1156;
const OFF_IN_OCTETS = 1208;
const OFF_OUT_OCTETS = 1280;
const IF_TYPE_SOFTWARE_LOOPBACK = 24;
const IF_OPER_STATUS_UP = 1;
const FLAG_HARDWARE = 1;
const FLAG_FILTER = 2;

const OFF_INDEX = 8; // InterfaceIndex, after the 8-byte InterfaceLuid
/** The whole table is read again this often, so adapters plugged in later are counted too. */
const RESCAN_MS = 30_000;

/**
 * The physical interfaces (hardware, not a filter layer, not loopback), from the whole table
 * (GetIfTable2), up or not: their state is read on every sample. Null when the table fails.
 */
function scanInterfaces(): { indexes: number[]; at: number } | null {
  const out = new BigUint64Array(1);
  if (I.GetIfTable2(new Uint8Array(out.buffer)) !== 0) return null;
  const table = Number(out[0]);
  if (!table) return null;
  try {
    const count = new DataView(toArrayBuffer(table, 0, 4)).getUint32(0, true);
    const view = new DataView(toArrayBuffer(table, 0, TABLE_HEADER + count * ROW));
    const indexes: number[] = [];
    for (let i = 0; i < count; i++) {
      const row = TABLE_HEADER + i * ROW;
      const flags = view.getUint8(row + OFF_FLAGS);
      if (!(flags & FLAG_HARDWARE) || flags & FLAG_FILTER) continue;
      if (view.getUint32(row + OFF_TYPE, true) === IF_TYPE_SOFTWARE_LOOPBACK) continue;
      indexes.push(view.getUint32(row + OFF_INDEX, true));
    }
    return { indexes, at: Date.now() };
  } finally {
    I.FreeMibTable(table);
  }
}

let interfaces: { indexes: number[]; at: number } | null = null;
const ifRow = new Uint8Array(ROW);
const ifView = new DataView(ifRow.buffer);

/**
 * Total bytes received/sent by the physical interfaces that are up, as Task Manager's per-adapter
 * graphs count them. Null when the table fails. The whole table (GetIfTable2) costs ~1 ms (measured,
 * it asks every interface the system has, virtual and filter layers included); the few physical
 * ones are found there every 30 s and read one by one (GetIfEntry2, ~6 µs each), the same row.
 */
export function networkOctets(): { received: number; sent: number } | null {
  if (!interfaces || Date.now() - interfaces.at > RESCAN_MS) interfaces = scanInterfaces();
  if (!interfaces) return null;
  let received = 0n;
  let sent = 0n;
  for (const index of interfaces.indexes) {
    ifRow.fill(0);
    ifView.setUint32(OFF_INDEX, index, true);
    // An interface that went away: the table is read again on the next sample.
    if (I.GetIfEntry2(ifRow) !== 0) {
      interfaces.at = 0;
      continue;
    }
    if (ifView.getUint32(OFF_OPER, true) !== IF_OPER_STATUS_UP) continue;
    received += ifView.getBigUint64(OFF_IN_OCTETS, true);
    sent += ifView.getBigUint64(OFF_OUT_OCTETS, true);
  }
  return { received: Number(received), sent: Number(sent) };
}

// ---------- Storage ----------

/** Root of the drive Windows is installed on ("C:\"). */
export function systemDriveRoot(): string {
  const buf = new Uint8Array(520);
  const len = K.GetSystemWindowsDirectoryW(buf, 260);
  if (len >= 2) return `${decodeWide(buf.buffer, 0, 4)}\\`;
  return "C:\\";
}

/** Space on a volume, in bytes: `free` is what the user can still write (as Explorer shows it). */
export function diskSpace(root: string): { free: number; total: number } | null {
  const values = new BigUint64Array(3);
  const ok = K.GetDiskFreeSpaceExW(
    encodeWide(root),
    new Uint8Array(values.buffer, 0, 8),
    new Uint8Array(values.buffer, 8, 8),
    new Uint8Array(values.buffer, 16, 8),
  );
  if (!ok) return null;
  return { free: Number(values[0]), total: Number(values[1]) };
}

// ---------- Processes (SYSTEM_PROCESS_INFORMATION, x64 layout) ----------

const SYSTEM_PROCESS_INFORMATION = 5;
const STATUS_INFO_LENGTH_MISMATCH = 0xc0000004 | 0;

export interface ProcessSample {
  pid: number;
  /** Image name ("chrome.exe"); "" for the idle process. */
  name: string;
  /** CreateTime, so a reused pid is not mistaken for the old process. */
  created: bigint;
  /** User + kernel time in 100 ns units. */
  cpuTime: bigint;
  /** Private working set in bytes (Task Manager's "Memória"). */
  privateBytes: number;
}

/** Made on the first snapshot: 1 MB that only the process widgets need. */
let procBuf: Uint8Array | null = null;

let names = new Map<string, string>();

export function processSnapshot(): ProcessSample[] {
  procBuf ??= new Uint8Array(1 << 20);
  const needed = new Uint32Array(1);
  let status = -1;
  for (let attempt = 0; attempt < 4; attempt++) {
    status = N.NtQuerySystemInformation(SYSTEM_PROCESS_INFORMATION, procBuf, procBuf.byteLength, new Uint8Array(needed.buffer));
    if (status !== STATUS_INFO_LENGTH_MISMATCH) break;
    procBuf = new Uint8Array(Math.max(needed[0]! + 128 * 1024, procBuf.byteLength * 2));
  }
  if (status < 0) return [];
  const base = ptr(procBuf);
  const view = new DataView(procBuf.buffer, procBuf.byteOffset, procBuf.byteLength);
  const out: ProcessSample[] = [];
  const seen = new Map<string, string>();
  let offset = 0;
  for (;;) {
    const next = view.getUint32(offset, true);
    const nameBytes = view.getUint16(offset + 56, true);
    const namePtr = Number(view.getBigUint64(offset + 64, true));
    const pid = Number(view.getBigUint64(offset + 80, true));
    const created = view.getBigInt64(offset + 32, true);
    // Names are decoded once per process (pid + creation time), not on every sample.
    const id = `${pid}:${created}`;
    let name = names.get(id) ?? "";
    if (!names.has(id) && nameBytes && namePtr) {
      // ImageName.Buffer points inside the buffer we passed.
      const rel = namePtr - base;
      name =
        rel >= 0 && rel + nameBytes <= procBuf.byteLength
          ? decodeWide(procBuf.buffer, procBuf.byteOffset + rel, nameBytes)
          : decodeWide(toArrayBuffer(namePtr, 0, nameBytes), 0, nameBytes);
    }
    seen.set(id, name);
    out.push({
      pid,
      name,
      created,
      cpuTime: view.getBigInt64(offset + 40, true) + view.getBigInt64(offset + 48, true),
      privateBytes: Number(view.getBigInt64(offset + 8, true)),
    });
    if (next === 0 || offset + next >= procBuf.byteLength) break;
    offset += next;
  }
  names = seen;
  return out;
}
