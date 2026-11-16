import { additionalClocks } from "../native/clocks";

const dayKey = (d: Date, timeZone?: string) => d.toLocaleDateString("en-CA", { timeZone });

/**
 * What the Windows clock's hover tip says: the full date and the time, then each of Windows'
 * additional clocks ("Tóquio: 02:35 · amanhã").
 */
export function clockTip(hour12: boolean): string[] {
  const now = new Date();
  const time = { hour: "2-digit", minute: "2-digit", hour12 } as const;
  const lines = [
    now.toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long", year: "numeric" }),
    now.toLocaleTimeString("pt-BR", time),
  ];
  const today = dayKey(now);
  for (const clock of additionalClocks(now)) {
    // The zone's wall clock, read as UTC so the local zone does not shift it again.
    const there = new Date(now.getTime() + clock.offset * 60_000);
    const day = dayKey(there, "UTC");
    const when = day > today ? " · amanhã" : day < today ? " · ontem" : "";
    lines.push(`${clock.name}: ${there.toLocaleTimeString("pt-BR", { ...time, timeZone: "UTC" })}${when}`);
  }
  return lines;
}
