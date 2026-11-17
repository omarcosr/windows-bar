/**
 * Minimal iCalendar (RFC 5545) reader for the calendar widget: VEVENTs with DTSTART/DTEND/DURATION
 * in UTC, TZID or floating time, all-day dates, simple DAILY/WEEKLY RRULEs (INTERVAL, COUNT, UNTIL,
 * BYDAY), EXDATE, RECURRENCE-ID overrides and cancelled events.
 */
export interface CalendarEvent {
  uid: string;
  title: string;
  location: string;
  start: number;
  end: number;
  allDay: boolean;
}

type Zone = { kind: "utc" } | { kind: "local" } | { kind: "tz"; tz: string };

interface Prop {
  name: string;
  params: Record<string, string>;
  value: string;
}

const DAY = 86_400_000;

/** Windows zone names (Outlook/Exchange feeds) to IANA, for the common ones. */
const WINDOWS_ZONES: Record<string, string> = {
  "E. South America Standard Time": "America/Sao_Paulo",
  "SA Eastern Standard Time": "America/Cayenne",
  "Argentina Standard Time": "America/Buenos_Aires",
  "Pacific SA Standard Time": "America/Santiago",
  "SA Pacific Standard Time": "America/Bogota",
  "Central Brazilian Standard Time": "America/Cuiaba",
  "Pacific Standard Time": "America/Los_Angeles",
  "Mountain Standard Time": "America/Denver",
  "Central Standard Time": "America/Chicago",
  "Eastern Standard Time": "America/New_York",
  "Atlantic Standard Time": "America/Halifax",
  "GMT Standard Time": "Europe/London",
  "Greenwich Standard Time": "Atlantic/Reykjavik",
  "W. Europe Standard Time": "Europe/Berlin",
  "Romance Standard Time": "Europe/Paris",
  "Central Europe Standard Time": "Europe/Budapest",
  "Central European Standard Time": "Europe/Warsaw",
  "E. Europe Standard Time": "Europe/Chisinau",
  "FLE Standard Time": "Europe/Kiev",
  "GTB Standard Time": "Europe/Bucharest",
  "Russian Standard Time": "Europe/Moscow",
  "India Standard Time": "Asia/Kolkata",
  "China Standard Time": "Asia/Shanghai",
  "Tokyo Standard Time": "Asia/Tokyo",
  "Singapore Standard Time": "Asia/Singapore",
  "AUS Eastern Standard Time": "Australia/Sydney",
  "New Zealand Standard Time": "Pacific/Auckland",
  UTC: "UTC",
  "Coordinated Universal Time": "UTC",
};

const formatters = new Map<string, Intl.DateTimeFormat | null>();

function formatter(tz: string) {
  if (!formatters.has(tz)) {
    let f: Intl.DateTimeFormat | null = null;
    try {
      f = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      f.formatToParts(new Date(0));
    } catch {
      f = null;
    }
    formatters.set(tz, f);
  }
  return formatters.get(tz)!;
}

/** An IANA zone the runtime knows for a TZID, or null (then the time is read as local). */
function resolveZone(tzid: string): string | null {
  const raw = tzid.replace(/^"|"$/g, "").trim();
  const candidates = [raw, WINDOWS_ZONES[raw], raw.split("/").slice(-2).join("/")].filter(Boolean) as string[];
  for (const c of candidates) if (formatter(c)) return c;
  return null;
}

/** Offset (ms) of tz at instant t: wall clock minus UTC. */
function zoneOffset(t: number, tz: string) {
  const f = formatter(tz)!;
  const p: Record<string, number> = {};
  for (const part of f.formatToParts(new Date(t))) if (part.type !== "literal") p[part.type] = Number(part.value);
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour! % 24, p.minute!, p.second!) - t;
}

/** Wall-clock fields packed as Date.UTC(...) to the real instant in zone. */
function toEpoch(wall: number, zone: Zone) {
  if (zone.kind === "utc") return wall;
  if (zone.kind === "local") {
    const d = new Date(wall);
    return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()).getTime();
  }
  let t = wall - zoneOffset(wall, zone.tz);
  t = wall - zoneOffset(t, zone.tz);
  return t;
}

interface Stamp {
  wall: number;
  zone: Zone;
  allDay: boolean;
}

function parseStamp(prop: Prop): Stamp | null {
  const v = prop.value.trim();
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?/.exec(v);
  if (!m) return null;
  const wall = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  if (!m[4] || prop.params.VALUE === "DATE") return { wall, zone: { kind: "local" }, allDay: true };
  if (m[7]) return { wall, zone: { kind: "utc" }, allDay: false };
  const tz = prop.params.TZID ? resolveZone(prop.params.TZID) : null;
  return { wall, zone: tz ? (tz === "UTC" ? { kind: "utc" } : { kind: "tz", tz }) : { kind: "local" }, allDay: false };
}

function parseDuration(v: string) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
  if (!m) return 0;
  const ms = (+(m[2] ?? 0) * 7 + +(m[3] ?? 0)) * DAY + +(m[4] ?? 0) * 3_600_000 + +(m[5] ?? 0) * 60_000 + +(m[6] ?? 0) * 1000;
  return m[1] === "-" ? -ms : ms;
}

function unescape(v: string) {
  return v.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1").trim();
}

function parseLine(line: string): Prop | null {
  // NAME;P=V;P="V:x":VALUE (colons inside quoted params are not the separator).
  let i = 0;
  let quoted = false;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    else if (c === ":" && !quoted) break;
  }
  if (i >= line.length) return null;
  const [name, ...rawParams] = line.slice(0, i).split(";");
  const params: Record<string, string> = {};
  for (const p of rawParams) {
    const eq = p.indexOf("=");
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: name!.toUpperCase(), params, value: line.slice(i + 1) };
}

const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

interface Rule {
  freq: string;
  interval: number;
  count: number;
  until: number;
  byDay: number[];
}

function parseRule(v: string, start: Stamp): Rule | null {
  const parts: Record<string, string> = {};
  for (const kv of v.split(";")) {
    const [k, val] = kv.split("=");
    if (k && val) parts[k.toUpperCase()] = val;
  }
  const freq = parts.FREQ ?? "";
  if (freq !== "DAILY" && freq !== "WEEKLY") return null;
  let until = Infinity;
  if (parts.UNTIL) {
    const s = parseStamp({ name: "UNTIL", params: {}, value: parts.UNTIL });
    if (s) until = s.allDay ? toEpoch(s.wall + DAY - 1, start.zone) : toEpoch(s.wall, s.zone);
  }
  const byDay = (parts.BYDAY ?? "")
    .split(",")
    .map((d) => WEEKDAYS.indexOf(d.replace(/^[+-]?\d+/, "")))
    .filter((d) => d >= 0);
  return { freq, interval: Math.max(1, Number(parts.INTERVAL) || 1), count: Number(parts.COUNT) || Infinity, until, byDay };
}

/** Wall-clock start times (as Date.UTC values) of the recurrence, up to `to`. */
function* expand(start: Stamp, rule: Rule, toWall: number) {
  let n = 0;
  if (rule.freq === "DAILY") {
    for (let wall = start.wall; wall <= toWall && n < rule.count && n < 20_000; wall += rule.interval * DAY, n++) yield wall;
    return;
  }
  const days = rule.byDay.length ? [...rule.byDay].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)) : [new Date(start.wall).getUTCDay()];
  // Weeks start on Monday (WKST default).
  const dow = (new Date(start.wall).getUTCDay() + 6) % 7;
  let week = start.wall - dow * DAY;
  for (let w = 0; w < 5_000 && week <= toWall; w++, week += rule.interval * 7 * DAY) {
    for (const d of days) {
      const wall = week + ((d + 6) % 7) * DAY;
      if (wall < start.wall) continue;
      if (n >= rule.count || wall > toWall) return;
      n++;
      yield wall;
    }
  }
}

/** Events overlapping [from, to] (epoch ms), sorted by start. */
export function parseIcs(text: string, from: number, to: number): CalendarEvent[] {
  const lines = text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n");
  const raw: Prop[][] = [];
  let current: Prop[] | null = null;
  let depth = 0;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      current = [];
      depth = 0;
    } else if (line === "END:VEVENT") {
      if (current) raw.push(current);
      current = null;
    } else if (current) {
      if (line.startsWith("BEGIN:")) depth++;
      else if (line.startsWith("END:")) depth--;
      else if (depth === 0) {
        const p = parseLine(line);
        if (p) current.push(p);
      }
    }
  }
  // RECURRENCE-ID overrides replace that instance of the master series.
  const overridden = new Map<string, Set<number>>();
  for (const props of raw) {
    const uid = props.find((p) => p.name === "UID")?.value ?? "";
    const rid = props.find((p) => p.name === "RECURRENCE-ID");
    const s = rid && parseStamp(rid);
    if (s) {
      if (!overridden.has(uid)) overridden.set(uid, new Set());
      overridden.get(uid)!.add(toEpoch(s.wall, s.zone));
    }
  }
  const out: CalendarEvent[] = [];
  for (const props of raw) {
    const get = (name: string) => props.find((p) => p.name === name);
    if ((get("STATUS")?.value ?? "").toUpperCase() === "CANCELLED") continue;
    const dt = get("DTSTART");
    const start = dt && parseStamp(dt);
    if (!start) continue;
    const uid = get("UID")?.value ?? "";
    const title = unescape(get("SUMMARY")?.value ?? "(sem título)") || "(sem título)";
    const location = unescape(get("LOCATION")?.value ?? "");
    const first = toEpoch(start.wall, start.zone);
    const endProp = get("DTEND");
    const endStamp = endProp && parseStamp(endProp);
    const duration = endStamp
      ? toEpoch(endStamp.wall, endStamp.zone) - first
      : get("DURATION")
        ? parseDuration(get("DURATION")!.value)
        : start.allDay
          ? DAY
          : 0;
    const push = (s: number) => {
      const e = s + Math.max(0, duration);
      if (e >= from && s <= to) out.push({ uid, title, location, start: s, end: e, allDay: start.allDay });
    };
    const rrule = get("RRULE");
    const rule = rrule && !get("RECURRENCE-ID") ? parseRule(rrule.value, start) : null;
    if (!rule) {
      push(first);
      continue;
    }
    const excluded = new Set(overridden.get(uid) ?? []);
    for (const p of props) {
      if (p.name !== "EXDATE") continue;
      for (const v of p.value.split(",")) {
        const s = parseStamp({ ...p, value: v });
        if (s) excluded.add(toEpoch(s.wall, s.allDay ? start.zone : s.zone));
      }
    }
    // Generous wall-clock bound: zones are at most ±14 h from UTC.
    const toWall = to + DAY;
    for (const wall of expand(start, rule, toWall)) {
      const s = toEpoch(wall, start.zone);
      if (s > rule.until) break;
      if (!excluded.has(s)) push(s);
    }
  }
  return out.sort((a, b) => a.start - b.start || Number(b.allDay) - Number(a.allDay));
}
