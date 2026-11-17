import { dlopen } from "./ffi";
import { decodeWide, encodeWide } from "./wide";

/**
 * Dates and times in the user's Windows regional formats (Settings > Time & language > Language &
 * region > Regional format), formatted by Windows itself, as the taskbar clock does.
 */

const kernel32 = dlopen("kernel32.dll", {
  GetTimeFormatEx: { args: ["ptr", "u32", "ptr", "ptr", "ptr", "i32"], returns: "i32" },
  GetDateFormatEx: { args: ["ptr", "u32", "ptr", "ptr", "ptr", "i32", "ptr"], returns: "i32" },
});
const advapi32 = dlopen("advapi32.dll", {
  RegGetValueW: { args: ["u64", "ptr", "ptr", "u32", "ptr", "ptr", "ptr"], returns: "i32" },
});

const TIME_NOSECONDS = 0x2;
const DATE_SHORTDATE = 0x1;
const DATE_LONGDATE = 0x2;

const out = new Uint16Array(128);
const system = new Uint16Array(8);

/** SYSTEMTIME of the date's wall clock; `utc` reads its UTC fields (a zone's time shifted into UTC). */
function systemTime(d: Date, utc = false) {
  if (utc) system.set([d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDay(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), 0]);
  else system.set([d.getFullYear(), d.getMonth() + 1, d.getDay(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), 0]);
  return new Uint8Array(system.buffer);
}

const text = (length: number) => (length > 1 ? decodeWide(out.buffer, 0, (length - 1) * 2) : "");

/** The user's short time ("23:24", "11:24 PM"), with seconds only when asked. */
export function formatTime(d: Date, options: { seconds?: boolean; utc?: boolean } = {}): string {
  const flags = options.seconds ? 0 : TIME_NOSECONDS;
  return text(kernel32.symbols.GetTimeFormatEx(null, flags, systemTime(d, options.utc), null, new Uint8Array(out.buffer), out.length));
}

/** The user's short ("17/11/2026") or long ("terça-feira, 17 de novembro de 2026") date. */
export function formatDate(d: Date, style: "short" | "long" = "short"): string {
  const flags = style === "long" ? DATE_LONGDATE : DATE_SHORTDATE;
  return text(kernel32.symbols.GetDateFormatEx(null, flags, systemTime(d), null, new Uint8Array(out.buffer), out.length, null));
}

/** A date picture in the user's language, e.g. "ddd" for the abbreviated weekday. */
export function formatDatePicture(d: Date, picture: string): string {
  return text(kernel32.symbols.GetDateFormatEx(null, 0, systemTime(d), encodeWide(picture), new Uint8Array(out.buffer), out.length, null));
}

const HKCU = 0xffffffff80000001n;
const dword = new Uint32Array(1);
const size = new Uint32Array(1);

/** Settings > Personalization > Taskbar > "Show seconds in system tray clock". */
export function clockShowsSeconds(): boolean {
  size[0] = 4;
  const status = advapi32.symbols.RegGetValueW(
    HKCU,
    encodeWide("Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced"),
    encodeWide("ShowSecondsInSystemClock"),
    0x10 /* RRF_RT_DWORD */,
    null,
    new Uint8Array(dword.buffer),
    new Uint8Array(size.buffer),
  );
  return status === 0 && dword[0] === 1;
}
