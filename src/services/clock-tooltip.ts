import { additionalClocks } from "../native/clocks";
import { formatDate, formatTime } from "../native/locale-format";

const dayKey = (d: Date, timeZone?: string) => d.toLocaleDateString("en-CA", { timeZone });

/**
 * What the Windows clock's hover tip says: the long date and the time in the user's regional
 * formats, then each of Windows' additional clocks ("Tóquio: 02:35 · amanhã").
 */
export function clockTip(): string[] {
  const now = new Date();
  const lines = [formatDate(now, "long"), formatTime(now)];
  const today = dayKey(now);
  for (const clock of additionalClocks(now)) {
    // The zone's wall clock, read as UTC so the local zone does not shift it again.
    const there = new Date(now.getTime() + clock.offset * 60_000);
    const day = dayKey(there, "UTC");
    const when = day > today ? " · amanhã" : day < today ? " · ontem" : "";
    lines.push(`${clock.name}: ${formatTime(there, { utc: true })}${when}`);
  }
  return lines;
}
