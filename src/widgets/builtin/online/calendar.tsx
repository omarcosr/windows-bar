import { Column, Text, store } from "@tarve/core";
import { launch } from "../../../services/windows";
import { parseIcs, type CalendarEvent } from "../../../services/online-ical";
import { ui } from "../../../theme";
import { Dot, Tile } from "../../ui";
import { defineWidget } from "../../types";
import { errorText, refreshNow, registerRefresh } from "./common";
import { nextBoundary, onClock, type ClockSubscription } from "../../../services/clock";
import { refreshWidget, remoteGet } from "../../../services/remote";

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
  if (event.start <= now) return event.allDay ? "hoje" : `agora · até ${hhmm(event.end)}`;
  const mins = Math.round((event.start - now) / 60_000);
  const days = Math.round((startOfDay(event.start) - startOfDay(now)) / DAY);
  if (event.allDay) return days === 1 ? "amanhã" : new Date(event.start).toLocaleDateString("pt-BR", { weekday: "short", day: "numeric" });
  if (mins < 60) return `em ${Math.max(1, mins)} min`;
  if (days === 0) return mins < 180 ? `em ${Math.floor(mins / 60)} h ${String(mins % 60).padStart(2, "0")}` : `hoje ${hhmm(event.start)}`;
  if (days === 1) return `amanhã ${hhmm(event.start)}`;
  const wd = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"][new Date(event.start).getDay()];
  return `${wd} ${hhmm(event.start)}`;
}

function demoEvents(): CalendarEvent[] {
  const now = Date.now();
  const at = (minsFromNow: number, length: number, title: string): CalendarEvent => {
    const start = Math.round((now + minsFromNow * 60_000) / 300_000) * 300_000;
    return { uid: title, title, location: "", start, end: start + length * 60_000, allDay: false };
  };
  return [at(25, 30, "Daily do time"), at(150, 60, "Revisão de design"), at(60 * 22, 45, "1:1 com a gestora")];
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
  description: "Próximo compromisso e em quanto tempo, de um ou mais links iCal secretos. Clique abre o Calendário.",
  category: "productivity",
  defaultConfig: { urls: "", showAllDay: false },
  settings: [
    {
      kind: "text",
      key: "urls",
      label: "Links iCal secretos",
      description: "Um ou mais endereços .ics (Google: endereço secreto no formato iCal; Outlook: publicar calendário → ICS), separados por espaço ou vírgula. Vazio mostra dados de exemplo.",
      placeholder: "https://calendar.google.com/calendar/ical/…/basic.ics",
      secret: true,
    },
    { kind: "toggle", key: "showAllDay", label: "Mostrar eventos de dia inteiro como próximo" },
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
            label: `${e.allDay ? "Dia todo" : hhmm(e.start)} · ${e.title}${e.location ? ` (${e.location})` : ""}`,
            onSelect: () => launch("outlookcal:"),
          }))
        : [{ label: "Nenhum evento hoje", onSelect: () => {} }],
      [
        { label: "Abrir Calendário", icon: "chevron-right", onSelect: () => launch("outlookcal:") },
        { label: "Atualizar agora", icon: "download", onSelect: () => refreshNow(state) },
      ],
    ];
  },
  View({ state, ctx }) {
    const now = state.now;
    const next = state.events.find((e) => e.end > now && (ctx.config.showAllDay || !e.allDay));
    const l = ui.tile.lines;
    const soon = next && !next.allDay && next.start - now < 15 * 60_000;
    return (
      <Tile width={184} onClick={() => launch("outlookcal:")}>
        <Dot color={state.error ? ui.danger : soon ? ui.orange : ui.blue} size={8} />
        <Column style={{ flex: 1, gap: l.gap }}>
          <Text size={l.primary} weight={600} color={ui.text} style={{ ...line, lineHeight: l.lineHeight }}>
            {next ? next.title : "Sem compromissos"}
          </Text>
          <Text size={l.secondary - 1} color={soon ? ui.orange : ui.muted} style={{ ...line, lineHeight: l.lineHeight }}>
            {next ? howSoon(next, now) : "nos próximos 7 dias"}
            {state.demo ? " · demo" : state.error ? " · erro" : ""}
          </Text>
        </Column>
      </Tile>
    );
  },
});
