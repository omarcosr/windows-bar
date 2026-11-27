import { Circle, Path, Svg } from "@tarve/core";
import { forecast, type DayForecast, type HourForecast } from "../../../services/weather-media-forecast";
import { formatDatePicture, formatTime } from "../../../native/locale-format";
import { weatherLabel } from "../../../services/weather";

import { t } from "../../../i18n";
export type Forecast = typeof forecast;

const H = 3600_000;

/** Demo data for the gallery preview while the forecast has not arrived. */
function demo(): Forecast {
  const now = Date.now();
  const hour = Math.floor(now / H) * H;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const t0 = today.getTime();
  const hours: HourForecast[] = [24, 25, 26, 26, 25, 23, 22, 21].map((temperature, i) => ({
    time: hour + i * H,
    temperature,
    code: [1, 1, 2, 3, 61, 61, 2, 0][i]!,
    rainChance: [5, 10, 20, 40, 70, 60, 20, 5][i]!,
  }));
  const days: DayForecast[] = [
    [2, 27, 18, 30],
    [61, 24, 17, 80],
    [3, 25, 16, 20],
    [0, 29, 17, 0],
    [1, 28, 18, 10],
  ].map(([code, max, min, rain], i) => ({
    date: t0 + i * 24 * H,
    code: code!,
    max: max!,
    min: min!,
    rainChance: rain!,
    rainSum: rain! > 50 ? 6.4 : 0,
    sunrise: t0 + i * 24 * H + 6.1 * H,
    sunset: t0 + i * 24 * H + 17.9 * H,
  }));
  return {
    ready: true,
    city: "São Paulo",
    temperature: 24,
    feelsLike: 25,
    code: 2,
    isDay: true,
    humidity: 62,
    wind: 12,
    windDirection: 135,
    precipitation: 0,
    hours,
    days,
  } as Forecast;
}

let cachedDemo: Forecast | undefined;

/** The live forecast, or demo data in the gallery while it is still loading. */
export function forecastData(preview: boolean): Forecast {
  if (forecast.ready || !preview) return forecast;
  return (cachedDemo ??= demo());
}

/** "seg." -> "Seg": Windows' abbreviated weekday in the user's language. */
export function weekday(d: Date) {
  const day = formatDatePicture(d, "ddd").replace(/\.$/, "");
  return day.charAt(0).toUpperCase() + day.slice(1);
}

const CLOUD_UP = "M7 15h10.5a3.6 3.6 0 0 0 .5-7.17A5.2 5.2 0 0 0 8 6.3 4.4 4.4 0 0 0 7 15Z";
const CLOUD = "M7 19h10.5a3.6 3.6 0 0 0 .5-7.17A5.2 5.2 0 0 0 8 10.3 4.4 4.4 0 0 0 7 19Z";

function sun(cx: number, cy: number, r: number) {
  const rays = Array.from({ length: 8 }, (_, i) => {
    const a = (i * Math.PI) / 4;
    const x1 = cx + Math.cos(a) * (r + 1.6);
    const y1 = cy + Math.sin(a) * (r + 1.6);
    const x2 = cx + Math.cos(a) * (r + 3.4);
    const y2 = cy + Math.sin(a) * (r + 3.4);
    return `M${x1.toFixed(2)} ${y1.toFixed(2)}L${x2.toFixed(2)} ${y2.toFixed(2)}`;
  }).join("");
  return (
    <>
      <Circle cx={cx} cy={cy} r={r} fill="#ffcc33" stroke="none" />
      <Path d={rays} fill="none" stroke="#ffcc33" stroke-width={1.6} stroke-linecap="round" />
    </>
  );
}

function moon(cx: number, cy: number, r: number) {
  return <Path d={`M${cx + r * 0.3} ${cy - r}a${r} ${r} 0 1 0 ${r * 0.7} ${r * 1.55}A${r * 0.8} ${r * 0.8} 0 0 1 ${cx + r * 0.3} ${cy - r}Z`} fill="#d6dcef" stroke="none" />;
}

/** A small drawn icon for a WMO weather code, as the Windows weather widget shows beside the temperature. */
export function WeatherIcon(props: { code: number; isDay?: boolean; size: number }) {
  const { code, size } = props;
  const day = props.isDay !== false;
  const sky = (cx: number, cy: number, r: number) => (day ? sun(cx, cy, r) : moon(cx, cy, r));
  let body;
  if (code === 0) body = sky(12, 12, 5);
  else if (code <= 2)
    body = (
      <>
        {sky(9, 9, 4)}
        <Path d={CLOUD} fill="#e6e8ee" stroke="none" />
      </>
    );
  else if (code <= 48)
    body = (
      <>
        <Path d={CLOUD} fill="#b8bcc6" stroke="none" />
        {code >= 45 ? <Path d="M5 21.5h14" fill="none" stroke="#b8bcc6" stroke-width={1.4} stroke-linecap="round" /> : null}
      </>
    );
  else if (code >= 95)
    body = (
      <>
        <Path d={CLOUD_UP} fill="#9ea3ae" stroke="none" />
        <Path d="M12.5 15l-2.5 4h3l-1.5 4 4-5.5h-3l1.5-2.5Z" fill="#ffcc33" stroke="none" />
      </>
    );
  else {
    const snow = (code >= 71 && code <= 77) || code === 85 || code === 86;
    body = (
      <>
        <Path d={CLOUD_UP} fill="#c9ccd4" stroke="none" />
        {snow ? (
          <>
            <Circle cx={8.5} cy={19} r={1.2} fill="#fff" stroke="none" />
            <Circle cx={12.5} cy={21} r={1.2} fill="#fff" stroke="none" />
            <Circle cx={16.5} cy={19} r={1.2} fill="#fff" stroke="none" />
          </>
        ) : (
          <Path d="M9 17l-1 3M13 17l-1 3M17 17l-1 3" fill="none" stroke="#4aa8ff" stroke-width={1.6} stroke-linecap="round" />
        )}
      </>
    );
  }
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {body}
    </Svg>
  );
}

export type TempUnit = "c" | "f";

/** The unit choice every weather tile offers; Open-Meteo answers in °C and km/h, converted here. */
export const unitSetting = {
  kind: "choice" as const,
  key: "unit" as const,
  label: t("widgets.weatherMedia.shared.unit"),
  options: [
    { value: "c", label: "Celsius (°C, km/h)" },
    { value: "f", label: "Fahrenheit (°F, mph)" },
  ],
};

/** A temperature (°C from the service) in the tile's unit, rounded. */
export const temp = (celsius: number, unit: unknown) => Math.round(unit === "f" ? (celsius * 9) / 5 + 32 : celsius);

/** "12 km/h" or "7 mph". */
export const windSpeed = (kmh: number, unit: unknown) => (unit === "f" ? `${Math.round(kmh / 1.609)} mph` : `${Math.round(kmh)} km/h`);

const SLOT = 15 * 60_000;

/**
 * The weather tiles' tooltip: what the numbers are and where they come from. Open-Meteo's current
 * values are 15-minute averages; the service refetches at the end of each slot, so the values shown
 * are those of the slot that started at `slot`.
 */
export function weatherTip(f: Forecast, unit: unknown, extra: string[] = []) {
  if (!f.ready) return [t("widgets.weatherMedia.shared.weatherLoading"), "Fonte: Open-Meteo"];
  const slot = new Date(Math.floor(Date.now() / SLOT) * SLOT);
  return [
    `${f.city ? `${f.city}: ` : ""}${temp(f.temperature, unit)}° · ${weatherLabel(f.code)}`,
    t("widgets.weatherMedia.shared.feelsLikeHumidityWind", { p0: temp(f.feelsLike, unit), humidity: f.humidity, p2: windSpeed(f.wind, unit) }),
    ...extra,
    t("widgets.weatherMedia.shared.openMeteoLocationFrom", { p0: formatTime(slot) }),
    t("widgets.weatherMedia.shared.clickToOpenWeather"),
  ];
}
