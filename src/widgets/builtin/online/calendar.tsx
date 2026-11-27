import { Column, Text, store } from "@tarve/core";
import { launch } from "../../../services/windows";
import { parseIcs, type CalendarEvent } from "../../../services/online-ical";
import { ui } from "../../../theme";
import { Dot, Tile , DayMark } from "../../ui";
import { defineWidget } from "../../types";
import { errorText, refreshNow, registerRefresh } from "./common";
import { nextBoundary, onClock, type ClockSubscription } from "../../../services/clock";
import { refreshWidget, remoteGet } from "../../../services/remote";

import { t as tr, language } from "../../../i18n";
const DAY = 86_400_000;
const line = { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } as const;

function hhmm(t: number) {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function startOfDay(t: number) {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** "agora", "em 25 min", "em 2 h 10", "amanhã 09:00", "qua 14:30". */
export function howSoon(event: CalendarEvent, now: number) {
  if (event.start <= now) return event.allDay ? tr("widgets.online.calendar.today") : tr("widgets.online.calendar.nowUntil", { p0: hhmm(event.end) });
  const mins = Math.round((event.start - now) / 60_000);
  const days = Math.round((startOfDay(event.start) - startOfDay(now)) / DAY);
  if (event.allDay) return days === 1 ? tr("widgets.online.calendar.tomorrow") : new Date(event.start).toLocaleDateString(language, { weekday: "short", day: "numeric" });
  if (mins < 60) return tr("widgets.online.calendar.inMin", { p0: Math.max(1, mins) });
  if (days === 0) return mins < 180 ? tr("widgets.online.calendar.inH", { p0: Math.floor(mins / 60), p1: String(mins % 60).padStart(2, "0") }) : tr("widgets.online.calendar.today2", { p0: hhmm(event.start) });
  if (days === 1) return tr("widgets.online.calendar.tomorrow2", { p0: hhmm(event.start) });
  const wd = new Date(event.start).toLocaleDateString(language, { weekday: "short" }).replace(".", "");
  return `${wd} ${hhmm(event.start)}`;
}

function demoEvents(): CalendarEvent[] {
  const now = Date.now();
  const at = (minsFromNow: number, length: number, title: string): CalendarEvent => {
    const start = Math.round((now + minsFromNow * 60_000) / 300_000) * 300_000;
    return { uid: title, title, location: "", start, end: start + length * 60_000, allDay: false };
  };
  return [at(25, 30, tr("widgets.online.calendar.teamDaily")), at(150, 60, tr("widgets.online.calendar.designReview")), at(60 * 22, 45, "1:1 com a gestora")];
}

function urlsOf(value: string) {
  return value
    .split(/[\s,;]+/)
    .map((u) => u.trim().replace(/^webcals?:\/\//i, "https://"))
    .filter((u) => /^https?:\/\//i.test(u));
}

export default defineWidget({
  type: "online-calendar",
  name: "Agenda (iCal)",
  description: tr("widgets.online.calendar.nextEventAndHow"),
  category: "productivity",
  defaultConfig: { urls: "", showAllDay: false },
  settings: [
    {
      kind: "text",
      key: "urls",
      label: tr("widgets.online.calendar.secretIcalLinks"),
      description: tr("widgets.online.calendar.oneOrMoreIcs"),
      placeholder: "https://calendar.google.com/calendar/ical/…/basic.ics",
      secret: true,
    },
    { kind: "toggle", key: "showAllDay", label: tr("widgets.online.calendar.showAllDayEvents") },
  ],
  setup(ctx) {
    let clock: ClockSubscription | undefined;
    const state = store({
      events: demoEvents(),
      time: Date.now(),
      demo: true,
      error: "",
      /** Read by every render (new events, settings): re-plans the wake for what it now shows. */
      get now(): number {
        clock?.update();
        return this.time;
      },
    });
    const load = async () => {
      const urls = urlsOf(String(ctx.config.urls || ""));
      if (!urls.length) {
        Object.assign(state, { events: demoEvents(), demo: true, error: "" });
        return;
      }
      const from = startOfDay(Date.now());
      const to = from + 8 * DAY;
      const results = await Promise.allSettled(
        urls.map(async (url) => {
          const res = await remoteGet(url, { Accept: "text/calendar" }, "iCal");
          if (!res.ok) throw new Error(`iCal ${res.status}`);
          return parseIcs(res.text, from, to);
        }),
      );
      const events = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
      const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
      if (failed && events.length === 0) {
        state.error = errorText(failed.reason);
        return;
      }
      events.sort((a, b) => a.start - b.start);
      Object.assign(state, { events, demo: false, error: failed ? errorText(failed.reason) : "" });
    };
    registerRefresh(state, load);
    refreshWidget(ctx, 15 * 60_000, load, () => !!state.error);
    // The line under the title (howSoon) moves on the shared clock only when its text changes: the
    // rounded minutes ("em 25 min", "em 2 h 10"), the 15 min "soon" colour, the start ("agora"),
    // the end (next event) and midnight ("amanhã" -> today), not on a 30 s check.
    clock = onClock((now, covered) => {
      if (covered) return null;
      let next = nextBoundary("day", now);
      const at = (t: number) => {
        if (t > now && t < next) next = t;
      };
      const e = state.events.find((e) => e.end > now && (ctx.config.showAllDay || !e.allDay));
      if (e) {
        at(e.end);
        if (!e.allDay && e.start > now) {
          at(e.start);
          at(e.start - 15 * 60_000);
          const mins = Math.round((e.start - now) / 60_000);
          at(e.start - (Math.min(mins, 180) - 0.5) * 60_000);
        }
      }
      return next;
    }, (now) => (state.time = now));
    ctx.onDispose(clock.cancel);
    return state;
  },
  menu({ state }) {
    const today = startOfDay(Date.now());
    const todays = state.events.filter((e) => e.start < today + DAY && e.end > today);
    return [
      todays.length
        ? todays.map((e) => ({
            label: `${e.allDay ? tr("widgets.online.calendar.allDay") : hhmm(e.start)} · ${e.title}${e.location ? ` (${e.location})` : ""}`,
            onSelect: () => launch("outlookcal:"),
          }))
        : [{ label: tr("widgets.online.calendar.noEventsToday"), onSelect: () => {} }],
      [
        { label: tr("widgets.online.calendar.openCalendar"), icon: "chevron-right", onSelect: () => launch("outlookcal:") },
        { label: tr("widgets.online.calendar.refreshNow"), icon: "download", onSelect: () => refreshNow(state) },
      ],
    ];
  },
  View({ state, ctx, preview }) {
    const now = state.now;
    const tip = () => {
      const upcoming = state.events.filter((e) => e.end > now && (ctx.config.showAllDay || !e.allDay)).slice(0, 4);
      return [
        ...(upcoming.length ? upcoming.map((e) => `${e.allDay ? tr("widgets.online.calendar.allDay") : hhmm(e.start)} · ${e.title}${e.location ? ` (${e.location})` : ""}`) : [tr("widgets.online.calendar.noEventsInNext")]),
        state.demo ? tr("widgets.online.calendar.sampleDataEnterIcal") : state.error ? tr("widgets.online.calendar.couldntRead", { error: state.error }) : tr("widgets.online.calendar.sourceYourIcalCalendars"),
        tr("widgets.online.calendar.clickToOpenCalendar"),
      ];
    };
    const next = state.events.find((e) => e.end > now && (ctx.config.showAllDay || !e.allDay));
    const l = ui.tile.lines;
    const soon = next && !next.allDay && next.start - now < 15 * 60_000;
    return (
      <Tile icon={<DayMark />} width={184} onClick={() => launch("outlookcal:")} tip={{ id: `tip:${ctx.instanceId}`, lines: tip }} preview={preview}>
        <Dot color={state.error ? ui.danger : soon ? ui.orange : ui.blue} size={8} />
        <Column style={{ flex: 1, gap: l.gap }}>
          <Text size={l.primary} weight={600} color={ui.text} style={{ ...line, lineHeight: l.lineHeight }}>
            {next ? next.title : tr("widgets.online.calendar.noEvents")}
          </Text>
          <Text size={l.secondary - 1} color={soon ? ui.orange : ui.muted} style={{ ...line, lineHeight: l.lineHeight }}>
            {next ? howSoon(next, now) : tr("widgets.online.calendar.inNext7Days")}
            {state.demo ? " · demo" : state.error ? tr("widgets.online.calendar.error") : ""}
          </Text>
        </Column>
      </Tile>
    );
  },
});
