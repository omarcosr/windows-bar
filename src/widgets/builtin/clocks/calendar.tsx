import { Column, Row, Text, View } from "@tarve/core";
import { HoverTip } from "../../../menu/hover-tip";
import { openNotificationCenter } from "../../../native/desktop";
import { firstDayOfWeek } from "../../../native/clocks-zones";
import { formatDate } from "../../../native/locale-format";
import { clockTip } from "../../../services/clock-tooltip";
import { weather, weatherLabel, weatherPoller } from "../../../services/weather";
import { numeric, ui } from "../../../theme";
import { Tile } from "../../ui";
import { defineWidget } from "../../types";
import { Caption, clockMenu, clockState, hourFormatSetting, monthName, timeText, weekdayName, type HourFormat } from "./shared";

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The current temperature, or a demo one in the gallery before the first fetch. */
const temperature = (preview: boolean) => (weather.ready ? `${weather.temperature}°` : preview ? "24°" : "–");
const conditions = (preview: boolean) => (weather.ready ? weatherLabel(weather.code) : preview ? "Céu limpo" : "");

/** Windows' long date, split into the weekday and the rest when the format starts with it. */
function longDate(d: Date) {
  const text = formatDate(d, "long");
  const comma = text.indexOf(", ");
  return comma > 0 ? { head: capital(text.slice(0, comma)), rest: text.slice(comma + 2) } : { head: weekdayName(d, true), rest: text };
}

/** The full date in large type. */
export const date = defineWidget({
  type: "clocks-date",
  name: "Data",
  description: "A data completa em letras grandes, no formato longo do Windows.",
  category: "clock",
  defaultConfig: {},
  setup(ctx) {
    return clockState(ctx, () => "day");
  },
  menu: clockMenu,
  View({ state, ctx, preview }) {
    const d = longDate(state.now);
    return (
      <HoverTip id={`tip:${ctx.instanceId}`} tip={clockTip} disabled={preview}>
        <Tile padding={{ left: 12, right: 12 }} onClick={openNotificationCenter}>
          <Column style={{ gap: 0 }}>
            <Text size={ui.tile.lines.primary + 3} weight={700} color={ui.text} style={{ lineHeight: 1.1 }}>
              {d.head}
            </Text>
            <Text size={ui.tile.lines.secondary} weight={500} color={ui.muted} style={{ ...numeric, lineHeight: 1.15 }}>
              {d.rest}
            </Text>
          </Column>
        </Tile>
      </HoverTip>
    );
  },
});

/** A tear-off calendar page: month on a red band, the day number below. */
export const dayNumber = defineWidget({
  type: "clocks-day",
  name: "Dia do mês",
  description: "Uma folha de calendário com o mês e o número do dia.",
  category: "clock",
  defaultConfig: { showWeekday: true },
  settings: [{ kind: "toggle", key: "showWeekday", label: "Mostrar dia da semana" }],
  setup(ctx) {
    return clockState(ctx, () => "day");
  },
  menu: clockMenu,
  View({ state, ctx, preview }) {
    const now = state.now;
    const h = ui.tile.height;
    const band = Math.round(h * 0.3);
    // The weekday needs a 36 px page (the 48 px bar): on a shorter one it would be cut off at the
    // bottom edge, so it moves to the tooltip.
    const weekday = ctx.config.showWeekday && h >= 34;
    return (
      <HoverTip id={`tip:${ctx.instanceId}`} tip={clockTip} disabled={preview}>
        <Tile width={Math.round(h * 0.95)} padding={0} gap={0} background="#f5f5f7" onClick={openNotificationCenter} style={{ direction: "column", align: "stretch" }}>
          <Row style={{ height: band, background: ui.red, align: "center", justify: "center" }}>
            <Text size={Math.max(7, Math.min(13, Math.round(band * 0.62)))} weight={700} color="#fff" style={{ lineHeight: 1 }}>
              {monthName(now).toUpperCase()}
            </Text>
          </Row>
          <Column style={{ flex: 1, align: "center", justify: "center", gap: 0 }}>
            <Text size={Math.round(h * (weekday ? 0.4 : 0.48))} weight={700} color="#1c1c1f" style={{ ...numeric, lineHeight: 1 }}>
              {String(now.getDate())}
            </Text>
            {weekday ? (
              <Text size={Math.max(8, Math.round(h * 0.17))} weight={600} color="#6e6e73" style={{ lineHeight: 1 }}>
                {weekdayName(now)}
              </Text>
            ) : null}
          </Column>
        </Tile>
      </HoverTip>
    );
  },
});

/** Weekday, date, time and the weather in one tile. */
export const today = defineWidget({
  type: "clocks-today",
  name: "Hoje",
  description: "Dia da semana, data, hora e o clima atual.",
  category: "clock",
  defaultConfig: { hourFormat: "system", showWeather: true },
  settings: [hourFormatSetting, { kind: "toggle", key: "showWeather", label: "Mostrar clima" }],
  setup(ctx) {
    ctx.onDispose(weatherPoller.acquire());
    return clockState(ctx, () => "minute");
  },
  menu: clockMenu,
  View({ state, ctx, preview }) {
    const now = state.now;
    const tip = () => [...clockTip(), weather.ready ? `${weather.city ? `${weather.city}: ` : ""}${weather.temperature}° · ${weatherLabel(weather.code)}` : ""];
    return (
      <HoverTip id={`tip:${ctx.instanceId}`} tip={tip} disabled={preview}>
        <Tile padding={{ left: 12, right: 12 }} gap={12} onClick={openNotificationCenter}>
          <Column style={{ gap: 0 }}>
            <Text size={ui.tile.lines.primary} weight={700} color={ui.text} style={{ lineHeight: 1.15 }}>
              {weekdayName(now, true)}
            </Text>
            <Caption>{`${now.getDate()} de ${monthName(now, true).toLowerCase()}`}</Caption>
          </Column>
          <Text size={Math.round(ui.tile.height * 0.4)} weight={700} color={ui.text} style={{ ...numeric, lineHeight: 1 }}>
            {timeText(now, ctx.config.hourFormat as HourFormat)}
          </Text>
          {ctx.config.showWeather && (weather.ready || preview) ? (
            <Column style={{ gap: 0, align: "end" }}>
              <Text size={ui.tile.lines.primary + 2} weight={700} color={ui.text} style={{ ...numeric, lineHeight: 1.1 }}>
                {temperature(preview)}
              </Text>
              <Caption>{conditions(preview)}</Caption>
            </Column>
          ) : null}
        </Tile>
      </HoverTip>
    );
  },
});

/** The week as a strip of days from Windows' first weekday, today marked with the temperature. */
export const week = defineWidget({
  type: "clocks-week",
  name: "7 dias",
  description: "A semana em faixa, com o dia de hoje destacado e a temperatura atual.",
  category: "clock",
  defaultConfig: { showWeather: true },
  settings: [{ kind: "toggle", key: "showWeather", label: "Mostrar temperatura de hoje" }],
  setup(ctx) {
    ctx.onDispose(weatherPoller.acquire());
    return clockState(ctx, () => "day");
  },
  menu: clockMenu,
  View({ state, ctx, preview }) {
    const now = state.now;
    const first = firstDayOfWeek();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() - first + 7) % 7));
    const days = Array.from({ length: 7 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
    // Wide enough for "QUA"/"SÁB" on the highlighted day at every bar height.
    const cell = Math.max(22, Math.round(ui.tile.height * 0.62));
    return (
      <HoverTip id={`tip:${ctx.instanceId}`} tip={clockTip} disabled={preview}>
        <Tile padding={{ left: 6, right: 8 }} gap={2} onClick={openNotificationCenter}>
          {days.map((d) => {
            const isToday = d.getDate() === now.getDate() && d.getMonth() === now.getMonth();
            return (
              <View style={{ width: cell, height: ui.tile.height - (ui.tile.height < 34 ? 4 : 8), radius: ui.tile.height < 34 ? 6 : 8, background: isToday ? ui.blue : "transparent", align: "center", justify: "center", gap: 1 }}>
                <Text size={8} weight={700} color={isToday ? "#fff" : ui.muted} style={{ lineHeight: 1 }}>
                  {weekdayName(d).slice(0, 3).toUpperCase()}
                </Text>
                <Text size={ui.tile.lines.primary} weight={700} color={isToday ? "#fff" : ui.text} style={{ ...numeric, lineHeight: 1.05 }}>
                  {String(d.getDate())}
                </Text>
              </View>
            );
          })}
          {ctx.config.showWeather && (weather.ready || preview) ? (
            <Column style={{ gap: 0, align: "center", padding: { left: 4 } }}>
              <Text size={ui.tile.lines.primary + 2} weight={700} color={ui.text} style={{ ...numeric, lineHeight: 1.1 }}>
                {temperature(preview)}
              </Text>
              <Caption>hoje</Caption>
            </Column>
          ) : null}
        </Tile>
      </HoverTip>
    );
  },
});
