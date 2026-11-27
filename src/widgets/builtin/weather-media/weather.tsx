import { Circle, Column, Path, Row, Svg, Text, store, type Child } from "@tarve/core";
import { forecastPoller, compass, upcomingDays, upcomingHours } from "../../../services/weather-media-forecast";
import { weatherLabel } from "../../../services/weather";
import { launch } from "../../../services/windows";
import { formatTime } from "../../../native/locale-format";
import { numeric, ui } from "../../../theme";
import { Tile } from "../../ui";
import { defineWidget, type WidgetContext } from "../../types";
import { every, onClock, type ClockUnit } from "../../../services/clock";
import type { DockMenuItem } from "../../../menu/dock-menu";
import { HoverTip } from "../../../menu/hover-tip";
import { WeatherIcon, forecastData, temp, unitSetting, weatherTip, weekday, windSpeed } from "./shared";

import { t as tr, formatDecimal } from "../../../i18n";
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
  return [[{ label: tr("widgets.weatherMedia.weather.openWeather"), icon: { fluent: 0xe8a7 /* OpenInNewWindow */ }, onSelect: openWeather }]];
}

const line = { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } as const;

function Small(props: { children: string; color?: string; size?: number; weight?: number }) {
  return (
    <Text size={props.size ?? 10} weight={props.weight ?? 500} color={props.color ?? ui.muted} style={{ ...numeric, ...line, lineHeight: 1.15 }}>
      {props.children}
    </Text>
  );
}

const deg = (n: number | undefined, unit: unknown) => (n === undefined ? "–" : `${temp(n, unit)}°`);

/** The tooltip wrapper of every weather tile (off in the gallery preview). */
function Tip(props: { id: string; preview: boolean; tip: () => string[]; children: Child }) {
  return (
    <HoverTip id={`tip:${props.id}`} tip={props.tip} disabled={props.preview}>
      {props.children}
    </HoverTip>
  );
}

const weatherNow = defineWidget({
  type: "weather-media-weather",
  name: tr("widgets.weatherMedia.weather.weather"),
  description: tr("widgets.weatherMedia.weather.temperatureNowAndTodays"),
  category: "clock",
  defaultConfig: { unit: "c" },
  settings: [unitSetting],
  setup: (ctx) => setup(ctx, "day"),
  menu,
  View({ state, ctx, preview }) {
    const f = forecastData(preview);
    const u = ctx.config.unit;
    const today = upcomingDays(1, state.now)[0] ?? f.days[0];
    const icon = Math.round(ui.tile.control * 0.9);
    const lines = ui.tile.lines;
    return (
      <Tip id={ctx.instanceId} preview={preview} tip={() => weatherTip(f, u, today ? [tr("widgets.weatherMedia.weather.todayHighLow", { p0: temp(today.max, u), p1: temp(today.min, u) })] : [])}>
        <Tile onClick={preview ? undefined : openWeather} padding={{ left: 8, right: 12 }} gap={6}>
          <WeatherIcon code={f.code} isDay={f.isDay} size={icon} />
          <Column style={{ gap: 0, minWidth: 0, justify: "center" }}>
            <Text size={lines.primary + 3} weight={700} color={ui.text} style={{ ...numeric, lineHeight: 1.1 }}>
              {f.ready ? `${temp(f.temperature, u)}°` : "–"}
            </Text>
            <Small>{today ? `↑${temp(today.max, u)}° ↓${temp(today.min, u)}°` : tr("widgets.weatherMedia.weather.loading")}</Small>
          </Column>
        </Tile>
      </Tip>
    );
  },
});

const weatherDetails = defineWidget({
  type: "weather-media-details",
  name: tr("widgets.weatherMedia.weather.weatherDetails"),
  description: tr("widgets.weatherMedia.weather.windChanceOfRain"),
  category: "clock",
  defaultConfig: { unit: "c" },
  settings: [unitSetting],
  setup: (ctx) => setup(ctx, "day"),
  menu,
  View({ state, ctx, preview }) {
    const f = forecastData(preview);
    const u = ctx.config.unit;
    const today = upcomingDays(1, state.now)[0] ?? f.days[0];
    const cell = (label: string, value: string) => (
      <Column style={{ gap: 1, minWidth: 0, justify: "center" }}>
        <Small size={9}>{label}</Small>
        <Small size={11} weight={650} color={ui.text}>
          {value}
        </Small>
      </Column>
    );
    const tip = () =>
      weatherTip(f, u, [
        f.ready ? tr("widgets.weatherMedia.weather.windFromAt", { p0: compass(f.windDirection), p1: windSpeed(f.wind, u) }) : "",
        today ? tr("widgets.weatherMedia.weather.chanceOfRainToday", { rainChance: today.rainChance, p1: today.rainSum ? ` (${formatDecimal(today.rainSum, 1)} mm)` : "" }) : "",
      ].filter(Boolean));
    return (
      <Tip id={ctx.instanceId} preview={preview} tip={tip}>
        <Tile onClick={preview ? undefined : openWeather} padding={{ left: 10, right: 12 }} gap={12}>
          {cell(tr("widgets.weatherMedia.weather.wind"), f.ready ? `${u === "f" ? Math.round(f.wind / 1.609) : f.wind} ${compass(f.windDirection)}` : "–")}
          {cell(tr("widgets.weatherMedia.weather.rain"), today ? `${today.rainChance}%` : "–")}
          {cell(tr("widgets.weatherMedia.weather.day"), today ? `${temp(today.min, u)}–${temp(today.max, u)}°` : "–")}
        </Tile>
      </Tip>
    );
  },
});

const weatherForecast = defineWidget({
  type: "weather-media-forecast",
  name: tr("widgets.weatherMedia.weather.todayAndForecast"),
  description: tr("widgets.weatherMedia.weather.todayAndNext3"),
  category: "clock",
  defaultConfig: { unit: "c", days: "4" },
  settings: [
    unitSetting,
    {
      kind: "choice",
      key: "days",
      label: tr("widgets.weatherMedia.weather.days"),
      options: [
        { value: "3", label: tr("widgets.weatherMedia.weather.todayAnd2Days") },
        { value: "4", label: tr("widgets.weatherMedia.weather.todayAnd3Days") },
        { value: "5", label: tr("widgets.weatherMedia.weather.todayAnd4Days") },
      ],
    },
  ],
  setup: (ctx) => setup(ctx, "day"),
  menu,
  View({ state, ctx, preview }) {
    const f = forecastData(preview);
    const u = ctx.config.unit;
    const n = Math.max(3, Math.min(5, Number(ctx.config.days) || 4));
    let list = upcomingDays(n, state.now);
    if (!list.length) list = f.days.slice(0, n);
    const tip = () =>
      weatherTip(
        f,
        u,
        list.map((d, i) => tr("widgets.weatherMedia.weather.rain2", { p0: i === 0 ? tr("widgets.weatherMedia.weather.today") : weekday(new Date(d.date)), p1: weatherLabel(d.code), p2: temp(d.max, u), p3: temp(d.min, u), p4: d.rainChance })),
      );
    return (
      <Tip id={ctx.instanceId} preview={preview} tip={tip}>
        <Tile onClick={preview ? undefined : openWeather} gap={4} padding={{ left: 8, right: 8 }}>
          {list.length ? (
            list.map((d, i) => (
              // Fixed cells: the min temperature of one day no longer runs into the next day's icon.
              <Column style={{ width: 44, align: "center", gap: 1, justify: "center" }}>
                <Small size={9} weight={i === 0 ? 700 : 500} color={i === 0 ? ui.text : ui.muted}>
                  {i === 0 ? tr("widgets.weatherMedia.weather.today") : weekday(new Date(d.date))}
                </Small>
                <Row style={{ align: "center", gap: 2 }}>
                  <WeatherIcon code={d.code} size={13} />
                  <Small size={10} weight={650} color={ui.text}>
                    {`${temp(d.max, u)}°`}
                  </Small>
                  <Small size={9}>{`${temp(d.min, u)}°`}</Small>
                </Row>
              </Column>
            ))
          ) : (
            <Small>{tr("widgets.weatherMedia.weather.loadingForecast")}</Small>
          )}
        </Tile>
      </Tip>
    );
  },
});

const weatherStatus = defineWidget({
  type: "weather-media-status",
  name: tr("widgets.weatherMedia.weather.weatherCondition"),
  description: tr("widgets.weatherMedia.weather.weatherNowInWords"),
  category: "clock",
  defaultConfig: { showTemperature: true, unit: "c" },
  settings: [{ kind: "toggle", key: "showTemperature", label: tr("widgets.weatherMedia.weather.showTemperature") }, unitSetting],
  setup: (ctx) => setup(ctx, null),
  menu,
  View({ ctx, preview }) {
    const f = forecastData(preview);
    const lines = ui.tile.lines;
    const u = ctx.config.unit;
    return (
      <Tip id={ctx.instanceId} preview={preview} tip={() => weatherTip(f, u)}>
        <Tile onClick={preview ? undefined : openWeather} gap={7} padding={{ left: 8, right: 12 }} style={{ maxWidth: 220 }}>
          <WeatherIcon code={f.code} isDay={f.isDay} size={Math.round(ui.tile.control * 0.85)} />
          <Column style={{ flex: 1, gap: lines.gap, minWidth: 0, justify: "center" }}>
            <Text size={lines.primary - 1} weight={650} color={ui.text} style={{ ...line, lineHeight: lines.lineHeight }}>
              {f.ready ? `${ctx.config.showTemperature ? `${temp(f.temperature, u)}° · ` : ""}${weatherLabel(f.code)}` : tr("widgets.weatherMedia.weather.loading2")}
            </Text>
            <Text size={lines.secondary - 1} color={ui.muted} style={{ ...line, lineHeight: lines.lineHeight }}>
              {f.city || tr("widgets.weatherMedia.weather.locating")}
            </Text>
          </Column>
        </Tile>
      </Tip>
    );
  },
});

const weatherHourly = defineWidget({
  type: "weather-media-hourly",
  name: tr("widgets.weatherMedia.weather.hourly"),
  description: tr("widgets.weatherMedia.weather.temperatureAndWeatherFor"),
  category: "clock",
  defaultConfig: { showRain: false, unit: "c" },
  settings: [{ kind: "toggle", key: "showRain", label: tr("widgets.weatherMedia.weather.showChanceOfRain"), description: tr("widgets.weatherMedia.weather.inPlaceOfTemperature") }, unitSetting],
  setup: (ctx) => setup(ctx, "hour"),
  menu,
  View({ state, ctx, preview }) {
    const f = forecastData(preview);
    const u = ctx.config.unit;
    let hours = upcomingHours(6, state.now);
    if (!hours.length) hours = f.hours.slice(0, 6);
    const hourLabel = (time: number) => formatTime(new Date(time));
    const tip = () => weatherTip(f, u, hours.map((h) => tr("widgets.weatherMedia.weather.rain3", { p0: hourLabel(h.time), p1: deg(h.temperature, u), p2: weatherLabel(h.code), rainChance: h.rainChance })));
    return (
      <Tip id={ctx.instanceId} preview={preview} tip={tip}>
        <Tile onClick={preview ? undefined : openWeather} gap={2} padding={{ left: 8, right: 8 }}>
          {hours.length ? (
            hours.map((h, i) => (
              <Column style={{ width: 34, align: "center", gap: 1, justify: "center" }}>
                <Small size={9} weight={i === 0 ? 700 : 500} color={i === 0 ? ui.text : ui.muted}>
                  {i === 0 ? tr("widgets.weatherMedia.weather.now") : `${new Date(h.time).getHours()}h`}
                </Small>
                <Row style={{ align: "center", gap: 2 }}>
                  <WeatherIcon code={h.code} size={12} />
                  <Small size={10} weight={650} color={ctx.config.showRain ? "#4aa8ff" : ui.text}>
                    {ctx.config.showRain ? `${h.rainChance}%` : deg(h.temperature, u)}
                  </Small>
                </Row>
              </Column>
            ))
          ) : (
            <Small>{tr("widgets.weatherMedia.weather.loadingForecast")}</Small>
          )}
        </Tile>
      </Tip>
    );
  },
});

const weatherSun = defineWidget({
  type: "weather-media-sun",
  name: tr("widgets.weatherMedia.weather.sunriseAndSunset"),
  description: tr("widgets.weatherMedia.weather.sunsPositionInSky"),
  category: "clock",
  defaultConfig: { unit: "c" },
  setup: (ctx) => setup(ctx, "minute"),
  menu,
  View({ state, ctx, preview }) {
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
      <Tip
        id={ctx.instanceId}
        preview={preview}
        tip={() =>
          weatherTip(f, ctx.config.unit, today ? [tr("widgets.weatherMedia.weather.sunriseSunset", { p0: formatTime(new Date(today.sunrise)), p1: formatTime(new Date(today.sunset)) }), tr("widgets.weatherMedia.weather.ofDaylight", { p0: Math.round(Math.max(0, Math.min(1, progress)) * 100) })] : [])
        }
      >
      <Tile onClick={preview ? undefined : openWeather} gap={8} padding={{ left: 10, right: 12 }}>
        <Svg width={w} height={h} viewBox={[0, 0, w, h]}>
          <Path d={`M1 ${cy}H${w - 1}`} fill="none" stroke={ui.faint} stroke-width={1} />
          <Path d={arc} fill="none" stroke={ui.track} stroke-width={1.6} stroke-dasharray="2 2.5" />
          {done ? <Path d={done} fill="none" stroke="#ffb340" stroke-width={1.8} stroke-linecap="round" /> : null}
          {sun ? <Circle cx={sun.x} cy={sun.y} r={3.6} fill="#ffcc33" stroke="none" /> : null}
        </Svg>
        <Column style={{ gap: 1, minWidth: 0, justify: "center" }}>
          <Small size={10} color={ui.text} weight={600}>
            {today ? `↑ ${formatTime(new Date(today.sunrise))}` : "–"}
          </Small>
          <Small size={10}>{today ? `↓ ${formatTime(new Date(today.sunset))}` : tr("widgets.weatherMedia.weather.loading")}</Small>
        </Column>
      </Tile>
      </Tip>
    );
  },
});

export default [weatherNow, weatherDetails, weatherForecast, weatherStatus, weatherHourly, weatherSun];
