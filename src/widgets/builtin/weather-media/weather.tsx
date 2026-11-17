import { Circle, Column, Path, Row, Svg, Text, store } from "@tarve/core";
import { forecastPoller, compass, upcomingDays, upcomingHours } from "../../../services/weather-media-forecast";
import { weatherLabel } from "../../../services/weather";
import { launch } from "../../../services/windows";
import { formatTime } from "../../../native/locale-format";
import { numeric, ui } from "../../../theme";
import { Tile } from "../../ui";
import { defineWidget, type WidgetContext } from "../../types";
import { every, onClock, type ClockUnit } from "../../../services/clock";
import type { DockMenuItem } from "../../../menu/dock-menu";
import { WeatherIcon, forecastData, weekday } from "./shared";

/** The Windows weather app (MSN Weather), which the taskbar's weather opens. */
const openWeather = () => launch("msnweather:");

/** `now` moves on the shared clock at the coarsest boundary the face shows (none when it shows no time). */
function setup<C extends object>(ctx: WidgetContext<C>, unit: ClockUnit | null): { now: number } {
  ctx.onDispose(forecastPoller.acquire());
  const state = store({ now: Date.now() });
  if (unit) ctx.onDispose(onClock(every(unit), (now) => (state.now = now)).cancel);
  return state;
}

function menu(): DockMenuItem[][] {
  return [[{ label: "Abrir Clima", icon: { fluent: 0xe8a7 /* OpenInNewWindow */ }, onSelect: openWeather }]];
}

const line = { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } as const;

function Small(props: { children: string; color?: string; size?: number; weight?: number }) {
  return (
    <Text size={props.size ?? 10} weight={props.weight ?? 500} color={props.color ?? ui.muted} style={{ ...numeric, ...line, lineHeight: 1.15 }}>
      {props.children}
    </Text>
  );
}

const deg = (n: number | undefined) => (n === undefined ? "–" : `${n}°`);

const weatherNow = defineWidget({
  type: "weather-media-weather",
  name: "Clima",
  description: "Temperatura agora e a máxima e mínima de hoje.",
  category: "clock",
  defaultConfig: {},
  setup: (ctx) => setup(ctx, "day"),
  menu,
  View({ state, preview }) {
    const f = forecastData(preview);
    const today = upcomingDays(1, state.now)[0] ?? f.days[0];
    const icon = Math.round(ui.tile.control * 0.9);
    return (
      <Tile width={100} onClick={preview ? undefined : openWeather} padding={{ left: 8, right: 8 }} gap={6}>
        <WeatherIcon code={f.code} isDay={f.isDay} size={icon} />
        <Column style={{ gap: 0, minWidth: 0 }}>
          <Text size={ui.tile.lines.primary + 3} weight={700} color={ui.text} style={{ ...numeric, lineHeight: 1.05 }}>
            {f.ready ? `${f.temperature}°` : "–"}
          </Text>
          <Small>{today ? `↑${today.max}° ↓${today.min}°` : "Carregando"}</Small>
        </Column>
      </Tile>
    );
  },
});

const weatherDetails = defineWidget({
  type: "weather-media-details",
  name: "Detalhes do clima",
  description: "Vento, chance de chuva e a variação de temperatura do dia.",
  category: "clock",
  defaultConfig: {},
  setup: (ctx) => setup(ctx, "day"),
  menu,
  View({ state, preview }) {
    const f = forecastData(preview);
    const today = upcomingDays(1, state.now)[0] ?? f.days[0];
    const cell = (label: string, value: string) => (
      <Column style={{ gap: 1, width: 44, minWidth: 0 }}>
        <Small size={9}>{label}</Small>
        <Small size={11} weight={650} color={ui.text}>
          {value}
        </Small>
      </Column>
    );
    return (
      <Tile width={160} onClick={preview ? undefined : openWeather} gap={6}>
        {cell("Vento", f.ready ? `${f.wind} ${compass(f.windDirection)}` : "–")}
        {cell("Chuva", today ? `${today.rainChance}%` : "–")}
        {cell("Dia", today ? `${today.min}–${today.max}°` : "–")}
      </Tile>
    );
  },
});

const weatherForecast = defineWidget({
  type: "weather-media-forecast",
  name: "Hoje e previsão",
  description: "Hoje e os próximos 3 dias, com máxima e mínima.",
  category: "clock",
  defaultConfig: {},
  setup: (ctx) => setup(ctx, "day"),
  menu,
  View({ state, preview }) {
    const f = forecastData(preview);
    let list = upcomingDays(4, state.now);
    if (!list.length) list = f.days.slice(0, 4);
    return (
      <Tile width={172} onClick={preview ? undefined : openWeather} gap={2} padding={{ left: 6, right: 6 }}>
        {list.length ? (
          list.map((d, i) => (
            <Column style={{ flex: 1, align: "center", gap: 1, minWidth: 0 }}>
              <Small size={9} weight={i === 0 ? 700 : 500} color={i === 0 ? ui.text : ui.muted}>
                {i === 0 ? "Hoje" : weekday(new Date(d.date))}
              </Small>
              <Row style={{ align: "center", gap: 2 }}>
                <WeatherIcon code={d.code} size={13} />
                <Small size={10} weight={650} color={ui.text}>
                  {`${d.max}°`}
                </Small>
                <Small size={9}>{`${d.min}°`}</Small>
              </Row>
            </Column>
          ))
        ) : (
          <Small>Carregando previsão…</Small>
        )}
      </Tile>
    );
  },
});

const weatherStatus = defineWidget({
  type: "weather-media-status",
  name: "Condição do tempo",
  description: "O tempo agora em palavras e a sua cidade.",
  category: "clock",
  defaultConfig: { showTemperature: true },
  settings: [{ kind: "toggle", key: "showTemperature", label: "Mostrar temperatura" }],
  setup: (ctx) => setup(ctx, null),
  menu,
  View({ ctx, preview }) {
    const f = forecastData(preview);
    const lines = ui.tile.lines;
    return (
      <Tile width={150} onClick={preview ? undefined : openWeather} gap={7}>
        <WeatherIcon code={f.code} isDay={f.isDay} size={Math.round(ui.tile.control * 0.85)} />
        <Column style={{ flex: 1, gap: lines.gap, minWidth: 0 }}>
          <Text size={lines.primary - 1} weight={650} color={ui.text} style={{ ...line, lineHeight: lines.lineHeight }}>
            {f.ready ? `${ctx.config.showTemperature ? `${f.temperature}° · ` : ""}${weatherLabel(f.code)}` : "Carregando…"}
          </Text>
          <Text size={lines.secondary - 1} color={ui.muted} style={{ ...line, lineHeight: lines.lineHeight }}>
            {f.city || "Localizando"}
          </Text>
        </Column>
      </Tile>
    );
  },
});

const weatherHourly = defineWidget({
  type: "weather-media-hourly",
  name: "Por hora",
  description: "Temperatura e tempo das próximas 6 horas.",
  category: "clock",
  defaultConfig: { showRain: false },
  settings: [{ kind: "toggle", key: "showRain", label: "Mostrar chance de chuva", description: "No lugar da temperatura." }],
  setup: (ctx) => setup(ctx, "hour"),
  menu,
  View({ state, ctx, preview }) {
    const f = forecastData(preview);
    let hours = upcomingHours(6, state.now);
    if (!hours.length) hours = f.hours.slice(0, 6);
    return (
      <Tile width={190} onClick={preview ? undefined : openWeather} gap={2} padding={{ left: 6, right: 6 }}>
        {hours.length ? (
          hours.map((h, i) => (
            <Column style={{ flex: 1, align: "center", gap: 1, minWidth: 0 }}>
              <Small size={9} weight={i === 0 ? 700 : 500} color={i === 0 ? ui.text : ui.muted}>
                {i === 0 ? "Agora" : `${new Date(h.time).getHours()}h`}
              </Small>
              <Row style={{ align: "center", gap: 1 }}>
                <WeatherIcon code={h.code} size={12} />
                <Small size={10} weight={650} color={ctx.config.showRain ? "#4aa8ff" : ui.text}>
                  {ctx.config.showRain ? `${h.rainChance}%` : deg(h.temperature)}
                </Small>
              </Row>
            </Column>
          ))
        ) : (
          <Small>Carregando previsão…</Small>
        )}
      </Tile>
    );
  },
});

const weatherSun = defineWidget({
  type: "weather-media-sun",
  name: "Nascer e pôr do sol",
  description: "A posição do sol no céu entre o nascer e o pôr do sol.",
  category: "clock",
  defaultConfig: {},
  setup: (ctx) => setup(ctx, "minute"),
  menu,
  View({ state, preview }) {
    const f = forecastData(preview);
    const today = upcomingDays(1, state.now)[0] ?? f.days[0];
    const w = 56;
    const h = Math.max(18, Math.min(26, ui.tile.height - 16));
    const r = Math.min(w / 2 - 4, h - 4);
    const cx = w / 2;
    const cy = h - 2;
    let sun: { x: number; y: number } | undefined;
    let progress = 0;
    if (today) {
      progress = (state.now - today.sunrise) / (today.sunset - today.sunrise);
      if (progress >= 0 && progress <= 1) {
        const a = Math.PI * (1 - progress);
        sun = { x: cx + Math.cos(a) * r, y: cy - Math.sin(a) * r };
      }
    }
    const arc = `M${cx - r} ${cy}A${r} ${r} 0 0 1 ${cx + r} ${cy}`;
    const t = Math.max(0, Math.min(1, progress));
    const end = { x: cx + Math.cos(Math.PI * (1 - t)) * r, y: cy - Math.sin(Math.PI * (1 - t)) * r };
    const done = t > 0 ? `M${cx - r} ${cy}A${r} ${r} 0 0 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}` : "";
    return (
      <Tile width={136} onClick={preview ? undefined : openWeather} gap={6}>
        <Svg width={w} height={h} viewBox={[0, 0, w, h]}>
          <Path d={`M1 ${cy}H${w - 1}`} fill="none" stroke={ui.faint} stroke-width={1} />
          <Path d={arc} fill="none" stroke={ui.track} stroke-width={1.6} stroke-dasharray="2 2.5" />
          {done ? <Path d={done} fill="none" stroke="#ffb340" stroke-width={1.8} stroke-linecap="round" /> : null}
          {sun ? <Circle cx={sun.x} cy={sun.y} r={3.6} fill="#ffcc33" stroke="none" /> : null}
        </Svg>
        <Column style={{ gap: 1, minWidth: 0 }}>
          <Small size={10} color={ui.text} weight={600}>
            {today ? `↑ ${formatTime(new Date(today.sunrise))}` : "–"}
          </Small>
          <Small size={10}>{today ? `↓ ${formatTime(new Date(today.sunset))}` : "Carregando"}</Small>
        </Column>
      </Tile>
    );
  },
});

export default [weatherNow, weatherDetails, weatherForecast, weatherStatus, weatherHourly, weatherSun];
