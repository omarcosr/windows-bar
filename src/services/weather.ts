import { store } from "@tarve/core";
import { remoteJson, sharedRefresh } from "./remote";
import { sleep } from "../runtime/proc";

import { t } from "../i18n";
export const weather = store({
  ready: false,
  temperature: 0,
  code: 0,
  city: "",
});

let coords: Promise<{ lat: number; lon: number; city: string }> | undefined;

/**
 * Where the user is, from the IP: looked up once and shared by the weather and forecast widgets
 * (both start together, so the lookup is shared while in flight too); a failed one is tried again.
 */
export function locate() {
  coords ??= (async () => {
    const data = (await getJson("https://ipwho.is/")) as { latitude: number; longitude: number; city: string; success: boolean };
    if (!data.success) throw new Error("ip lookup failed");
    return { lat: data.latitude, lon: data.longitude, city: data.city };
  })();
  coords.catch(() => (coords = undefined));
  return coords;
}

/** GET + json (conditional, shared in flight) with one retry: transient network drops (ECONNRESET) shouldn't surface. */
async function getJson(url: string): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    try {
      return (await remoteJson<unknown>(url, {}, "HTTP")).body;
    } catch (error) {
      if (attempt >= 1) throw error;
      await sleep(2_000);
    }
  }
}

/** The Open-Meteo answer: `current` always; hourly and daily when a forecast widget asked for them. */
export interface MeteoData {
  utc_offset_seconds?: number;
  current: { time?: string; interval?: number; temperature_2m: number; weather_code: number } & Record<string, unknown>;
  [key: string]: unknown;
}

const FORECAST_FIELDS =
  `&timezone=auto&forecast_days=5` +
  `&current=temperature_2m,apparent_temperature,weather_code,is_day,relative_humidity_2m,wind_speed_10m,wind_direction_10m,precipitation` +
  `&hourly=temperature_2m,weather_code,precipitation_probability` +
  `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,sunrise,sunset`;

const PERIOD = 15 * 60_000;
/** When Open-Meteo's current values change next (the end of their 15-minute slot). */
let nextSlot = 0;
const forecastListeners = new Set<(data: MeteoData, city: string) => void>();
let forecastServed = false;

/**
 * One Open-Meteo request per slot serves every weather widget: the forecast's URL carries the
 * current temperature and code too, so with a forecast widget on the dock the plain one asks nothing.
 * The next request is timed to the end of the 15-minute slot the answer belongs to
 * (current.time + current.interval), when the model's current values change.
 */
async function refreshMeteo() {
  const { lat, lon, city } = await locate();
  const full = forecastListeners.size > 0;
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    (full ? FORECAST_FIELDS : `&timezone=auto&current=temperature_2m,weather_code`);
  const data = (await getJson(url)) as MeteoData;
  weather.temperature = Math.round(data.current.temperature_2m);
  weather.code = data.current.weather_code;
  weather.city = city;
  weather.ready = true;
  if (full) {
    forecastServed = true;
    for (const fn of forecastListeners) fn(data, city);
  }
  const { time, interval } = data.current;
  const start = time ? Date.parse(`${time}:00Z`) - (data.utc_offset_seconds ?? 0) * 1000 : NaN;
  nextSlot = Number.isFinite(start) && interval ? start + interval * 1000 + 60_000 : 0;
  // A forecast widget arrived while the plain request was in flight: its data is needed now.
  if (!full && forecastListeners.size) await refreshMeteo();
}

const meteo = sharedRefresh(refreshMeteo, {
  every: () => (nextSlot ? Math.min(30 * 60_000, Math.max(5 * 60_000, nextSlot - Date.now())) : PERIOD),
  label: "[weather]",
});

export const weatherPoller = { acquire: () => meteo.acquire() };

/** Used by the forecast widgets: the shared request then carries the hourly and daily forecast. */
export function acquireForecast(listener: (data: MeteoData, city: string) => void): () => void {
  forecastListeners.add(listener);
  const release = meteo.acquire();
  // Already running for a plain widget: fetch the forecast at once instead of at the next slot.
  if (!forecastServed && forecastListeners.size === 1) void meteo.now();
  return () => {
    forecastListeners.delete(listener);
    if (!forecastListeners.size) forecastServed = false;
    release();
  };
}

/** WMO weather code -> short Portuguese label. */
export function weatherLabel(code: number) {
  if (code === 0) return t("services.weather.clearSky");
  if (code <= 2) return t("services.weather.partlyCloudy");
  if (code === 3) return t("services.weather.cloudy");
  if (code <= 48) return t("services.weather.fog");
  if (code <= 67) return t("services.weather.rain");
  if (code <= 77) return t("services.weather.snow");
  if (code <= 82) return t("services.weather.showers");
  return t("services.weather.thunderstorm");
}
