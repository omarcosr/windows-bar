import { dlopen } from "./ffi";
import { encodeWide, decodeWide } from "./wide";

/**
 * Windows' "Additional clocks" (Settings > Time & language > Date & time > Additional clocks):
 * up to two, stored per user in HKCU\Control Panel\TimeDate\AdditionalClocks\{1,2}. Their time
 * zone is a Windows zone name ("Tokyo Standard Time"), resolved with the system's own rules so
 * daylight saving matches what Windows shows.
 */

const advapi32 = dlopen("advapi32.dll", {
  RegGetValueW: { args: ["u64", "ptr", "ptr", "u32", "ptr", "ptr", "ptr"], returns: "i32" },
  EnumDynamicTimeZoneInformation: { args: ["u32", "ptr"], returns: "u32" },
});
const kernel32 = dlopen("kernel32.dll", {
  SystemTimeToTzSpecificLocalTimeEx: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
});

/** HKEY_CURRENT_USER, sign-extended as a 64-bit handle. */
const HKCU = 0xffffffff80000001n;
const RRF_RT_REG_SZ = 0x2;
const RRF_RT_DWORD = 0x10;
/** sizeof(DYNAMIC_TIME_ZONE_INFORMATION); TimeZoneKeyName (WCHAR[128]) starts at 172. */
const DTZI_SIZE = 432;
const KEY_NAME_OFFSET = 172;

const wide = (s: string) => encodeWide(s);
const text = new Uint16Array(260);
const dword = new Uint32Array(1);
const size = new Uint32Array(1);

function readString(sub: string, value: string): string {
  size[0] = text.byteLength;
  if (advapi32.symbols.RegGetValueW(HKCU, wide(sub), wide(value), RRF_RT_REG_SZ, null, new Uint8Array(text.buffer), new Uint8Array(size.buffer)) !== 0) return "";
  return decodeWide(text.buffer, 0, Math.max(0, size[0]! - 2));
}

function readDword(sub: string, value: string): number | null {
  size[0] = 4;
  if (advapi32.symbols.RegGetValueW(HKCU, wide(sub), wide(value), RRF_RT_DWORD, null, new Uint8Array(dword.buffer), new Uint8Array(size.buffer)) !== 0) return null;
  return dword[0]!;
}

const zones = new Map<string, Uint8Array | null>();

/** The system's DYNAMIC_TIME_ZONE_INFORMATION for a Windows zone name, cached. */
function zoneInfo(key: string): Uint8Array | null {
  if (zones.has(key)) return zones.get(key)!;
  let found: Uint8Array | null = null;
  for (let i = 0; ; i++) {
    const info = new Uint8Array(DTZI_SIZE);
    if (advapi32.symbols.EnumDynamicTimeZoneInformation(i, info) !== 0) break;
    const name = decodeWide(info.buffer, KEY_NAME_OFFSET, 256).replace(/\0.*$/s, "");
    if (name.toLowerCase() === key.toLowerCase()) {
      found = info;
      break;
    }
  }
  zones.set(key, found);
  return found;
}

const utcTime = new Uint16Array(8);
const localTime = new Uint16Array(8);

/** Minutes the zone is ahead of UTC at `at`, or null if Windows does not know the zone. */
function zoneOffset(key: string, at: Date): number | null {
  const info = zoneInfo(key);
  if (!info) return null;
  utcTime.set([at.getUTCFullYear(), at.getUTCMonth() + 1, at.getUTCDay(), at.getUTCDate(), at.getUTCHours(), at.getUTCMinutes(), 0, 0]);
  if (!kernel32.symbols.SystemTimeToTzSpecificLocalTimeEx(info, new Uint8Array(utcTime.buffer), new Uint8Array(localTime.buffer))) return null;
  const [y, mo, , d, h, mi] = localTime;
  const local = Date.UTC(y!, mo! - 1, d!, h!, mi!);
  const utc = Date.UTC(utcTime[0]!, utcTime[1]! - 1, utcTime[3]!, utcTime[4]!, utcTime[5]!);
  return Math.round((local - utc) / 60_000);
}

export interface AdditionalClock {
  name: string;
  /** Minutes ahead of UTC right now. */
  offset: number;
}

let cache: { at: number; clocks: { name: string; zone: string }[] } | undefined;

/** The enabled additional clocks with their current UTC offset (registry re-read every 10 s). */
export function additionalClocks(now = new Date()): AdditionalClock[] {
  if (!cache || now.getTime() - cache.at > 10_000) {
    const clocks: { name: string; zone: string }[] = [];
    for (const i of [1, 2]) {
      const sub = `Control Panel\\TimeDate\\AdditionalClocks\\${i}`;
      if (!readDword(sub, "Enable")) continue;
      const zone = readString(sub, "TzRegKeyName");
      if (zone) clocks.push({ name: readString(sub, "DisplayName") || zone, zone });
    }
    cache = { at: now.getTime(), clocks };
  }
  const out: AdditionalClock[] = [];
  for (const c of cache.clocks) {
    const offset = zoneOffset(c.zone, now);
    if (offset !== null) out.push({ name: c.name, offset });
  }
  return out;
}
