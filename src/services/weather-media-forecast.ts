import { store } from "@tarve/core";
import { acquireForecast, type MeteoData } from "./weather";
import { language } from "../i18n";

/**
 * Forecast data for the weather-media widgets: the same provider (Open-Meteo) and location
 * (IP lookup via ipwho.is) as services/weather.ts, which only carries the current temperature.
 * Times are epoch milliseconds.
 */
export interface HourForecast {
  time: number;
  temperature: number;
  code: number;
  rainChance: number;
}

export interface DayForecast {
  date: number;
  code: number;
  max: number;
  min: number;
  rainChance: number;
  rainSum: number;
  sunrise: number;
  sunset: number;
}

export const forecast = store({
  ready: false,
  city: "",
  temperature: 0,
  feelsLike: 0,
  code: 0,
  isDay: true,
  humidity: 0,
  /** km/h */
  wind: 0,
  /** Degrees the wind comes from. */
  windDirection: 0,
  /** mm in the current hour. */
  precipitation: 0,
  hours: [] as HourForecast[],
  days: [] as DayForecast[],
});

/** "2024-05-01T06:12" in the location's zone (timezone=auto) -> epoch ms. */
function localTime(value: string, offsetSeconds: number) {
  const [d, t = "00:00"] = value.split("T");
  const [y, m, day] = d!.split("-").map(Number);
  const [h, min] = t.split(":").map(Number);
  return Date.UTC(y!, m! - 1, day!, h!, min!) - offsetSeconds * 1000;
}

interface Response {
  utc_offset_seconds: number;
  current: {
    temperature_2m: number;
    apparent_temperature: number;
    weather_code: number;
    is_day: number;
    relative_humidity_2m: number;
    wind_speed_10m: number;
    wind_direction_10m: number;
    precipitation: number;
  };
  hourly: { time: string[]; temperature_2m: number[]; weather_code: number[]; precipitation_probability: (number | null)[] };
  daily: {
    time: string[];
    weather_code: number[];
    temperature_2m_max: number[];
    temperature_2m_min: number[];
    precipitation_probability_max: (number | null)[];
    precipitation_sum: (number | null)[];
    sunrise: string[];
    sunset: string[];
  };
}

/** Fills the forecast from the shared Open-Meteo request (services/weather.ts), every 15-minute slot. */
function apply(raw: MeteoData, city: string) {
  const data = raw as unknown as Response;
  const off = data.utc_offset_seconds ?? 0;
  const c = data.current;
  const hours = data.hourly.time.map((t, i) => ({
    time: localTime(t, off),
    temperature: Math.round(data.hourly.temperature_2m[i] ?? 0),
    code: data.hourly.weather_code[i] ?? 0,
    rainChance: data.hourly.precipitation_probability[i] ?? 0,
  }));
  const days = data.daily.time.map((t, i) => ({
    date: localTime(t, off),
    code: data.daily.weather_code[i] ?? 0,
    max: Math.round(data.daily.temperature_2m_max[i] ?? 0),
    min: Math.round(data.daily.temperature_2m_min[i] ?? 0),
    rainChance: data.daily.precipitation_probability_max[i] ?? 0,
    rainSum: data.daily.precipitation_sum[i] ?? 0,
    sunrise: localTime(data.daily.sunrise[i] ?? t, off),
    sunset: localTime(data.daily.sunset[i] ?? t, off),
  }));
  Object.assign(forecast, {
    ready: true,
    city,
    temperature: Math.round(c.temperature_2m),
    feelsLike: Math.round(c.apparent_temperature),
    code: c.weather_code,
    isDay: c.is_day === 1,
    humidity: Math.round(c.relative_humidity_2m),
    wind: Math.round(c.wind_speed_10m),
    windDirection: c.wind_direction_10m,
    precipitation: c.precipitation,
    hours,
    days,
  });
}

export const forecastPoller = { acquire: () => acquireForecast(apply) };

/** Hours from the current one on. */
export function upcomingHours(count: number, now = Date.now()) {
  const start = now - 60 * 60_000;
  return forecast.hours.filter((h) => h.time > start).slice(0, count);
}

/** Today (index 0) and the days after it. */
export function upcomingDays(count: number, now = Date.now()) {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  return forecast.days.filter((d) => d.date + 24 * 3600_000 > today.getTime() + 3600_000).slice(0, count);
}

/** Wind direction (degrees it comes from) -> compass point in the UI language. */
export function compass(deg: number) {
  const points = language === "pt-BR" ? ["N", "NE", "L", "SE", "S", "SO", "O", "NO"] : ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return points[Math.round((((deg % 360) + 360) % 360) / 45) % 8]!;
}
