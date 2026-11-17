import { dlopen } from "./ffi";
import { additionalClocks } from "./clocks";
import { decodeWide } from "./wide";

/**
 * Time zones for the clock widgets, resolved like Windows' own "Additional clocks": the zone is a
 * Windows time zone key ("Tokyo Standard Time") from the system's database
 * (EnumDynamicTimeZoneInformation) and the wall clock comes from SystemTimeToTzSpecificLocalTimeEx,
 * so daylight saving matches what the taskbar clock flyout shows. The widgets pick zones by IANA
 * id; each maps to the Windows key CLDR assigns it (windowsZones.xml).
 */

const advapi32 = dlopen("advapi32.dll", {
  EnumDynamicTimeZoneInformation: { args: ["u32", "ptr"], returns: "u32" },
});
const kernel32 = dlopen("kernel32.dll", {
  SystemTimeToTzSpecificLocalTimeEx: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
  GetLocaleInfoEx: { args: ["ptr", "u32", "ptr", "i32"], returns: "i32" },
});

/** sizeof(DYNAMIC_TIME_ZONE_INFORMATION); TimeZoneKeyName (WCHAR[128]) starts at 172. */
const DTZI_SIZE = 432;
const KEY_NAME_OFFSET = 172;

export interface ZoneOption {
  /** IANA id, or "windows:N" for Windows' additional clock N (0 or 1). */
  value: string;
  label: string;
  /** Windows time zone key. */
  windows?: string;
}

/** IANA zones offered by the widgets, with their CLDR Windows key and a pt-BR city label. */
export const zoneOptions: readonly ZoneOption[] = [
  { value: "windows:0", label: "Relógio adicional 1 do Windows" },
  { value: "windows:1", label: "Relógio adicional 2 do Windows" },
  { value: "UTC", label: "UTC", windows: "UTC" },
  { value: "America/Sao_Paulo", label: "São Paulo", windows: "E. South America Standard Time" },
  { value: "America/Manaus", label: "Manaus", windows: "SA Western Standard Time" },
  { value: "America/Argentina/Buenos_Aires", label: "Buenos Aires", windows: "Argentina Standard Time" },
  { value: "America/Santiago", label: "Santiago", windows: "Pacific SA Standard Time" },
  { value: "America/Bogota", label: "Bogotá", windows: "SA Pacific Standard Time" },
  { value: "America/Mexico_City", label: "Cidade do México", windows: "Central Standard Time (Mexico)" },
  { value: "America/New_York", label: "Nova York", windows: "Eastern Standard Time" },
  { value: "America/Chicago", label: "Chicago", windows: "Central Standard Time" },
  { value: "America/Denver", label: "Denver", windows: "Mountain Standard Time" },
  { value: "America/Los_Angeles", label: "Los Angeles", windows: "Pacific Standard Time" },
  { value: "Europe/London", label: "Londres", windows: "GMT Standard Time" },
  { value: "Europe/Lisbon", label: "Lisboa", windows: "GMT Standard Time" },
  { value: "Europe/Paris", label: "Paris", windows: "Romance Standard Time" },
  { value: "Europe/Madrid", label: "Madri", windows: "Romance Standard Time" },
  { value: "Europe/Berlin", label: "Berlim", windows: "W. Europe Standard Time" },
  { value: "Europe/Moscow", label: "Moscou", windows: "Russian Standard Time" },
  { value: "Africa/Johannesburg", label: "Joanesburgo", windows: "South Africa Standard Time" },
  { value: "Asia/Dubai", label: "Dubai", windows: "Arabian Standard Time" },
  { value: "Asia/Kolkata", label: "Mumbai", windows: "India Standard Time" },
  { value: "Asia/Shanghai", label: "Xangai", windows: "China Standard Time" },
  { value: "Asia/Singapore", label: "Singapura", windows: "Singapore Standard Time" },
  { value: "Asia/Tokyo", label: "Tóquio", windows: "Tokyo Standard Time" },
  { value: "Australia/Sydney", label: "Sydney", windows: "AUS Eastern Standard Time" },
  { value: "Pacific/Auckland", label: "Auckland", windows: "New Zealand Standard Time" },
];

const zones = new Map<string, Uint8Array | null>();

/** The system's DYNAMIC_TIME_ZONE_INFORMATION for a Windows zone key, cached. */
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

/** Minutes the Windows zone is ahead of UTC at `at`, or null if Windows does not know it. */
function windowsOffset(key: string, at: Date): number | null {
  const info = zoneInfo(key);
  if (!info) return null;
  utcTime.set([at.getUTCFullYear(), at.getUTCMonth() + 1, at.getUTCDay(), at.getUTCDate(), at.getUTCHours(), at.getUTCMinutes(), 0, 0]);
  if (!kernel32.symbols.SystemTimeToTzSpecificLocalTimeEx(info, new Uint8Array(utcTime.buffer), new Uint8Array(localTime.buffer))) return null;
  const [y, mo, , d, h, mi] = localTime;
  const local = Date.UTC(y!, mo! - 1, d!, h!, mi!);
  const utc = Date.UTC(utcTime[0]!, utcTime[1]! - 1, utcTime[3]!, utcTime[4]!, utcTime[5]!);
  return Math.round((local - utc) / 60_000);
}

export interface ZoneTime {
  label: string;
  /** Minutes ahead of UTC right now. */
  offset: number;
  /** The zone's wall clock in the UTC fields (getUTCHours() etc.); format with `{ utc: true }`. */
  wall: Date;
}

/** The current wall clock of a zone option, or null when the zone or the additional clock is missing. */
export function zoneTime(value: string, now = new Date()): ZoneTime | null {
  let label: string;
  let offset: number | null;
  if (value.startsWith("windows:")) {
    const clock = additionalClocks(now)[Number(value.slice(8))];
    if (!clock) return null;
    label = clock.name;
    offset = clock.offset;
  } else {
    const option = zoneOptions.find((z) => z.value === value);
    if (!option?.windows) return null;
    label = option.label;
    offset = windowsOffset(option.windows, now);
  }
  if (offset === null) return null;
  return { label, offset, wall: new Date(now.getTime() + offset * 60_000) };
}

/** "UTC−3", "UTC+5:30". */
export function utcLabel(offset: number) {
  if (offset === 0) return "UTC";
  const sign = offset < 0 ? "−" : "+";
  const abs = Math.abs(offset);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `UTC${sign}${h}${m ? `:${String(m).padStart(2, "0")}` : ""}`;
}

const LOCALE_IFIRSTDAYOFWEEK = 0x100c;
const localeOut = new Uint16Array(8);

/**
 * The user's first day of the week (Settings > Time & language > Language & region > Regional
 * format), as a JS weekday (0 = Sunday). Windows stores 0 = Monday … 6 = Sunday.
 */
export function firstDayOfWeek(): number {
  const n = kernel32.symbols.GetLocaleInfoEx(null, LOCALE_IFIRSTDAYOFWEEK, new Uint8Array(localeOut.buffer), localeOut.length);
  const win = n > 1 ? Number(decodeWide(localeOut.buffer, 0, (n - 1) * 2)) : 6;
  return Number.isFinite(win) ? (win + 1) % 7 : 0;
}

