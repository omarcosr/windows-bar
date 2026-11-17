import { store } from "@tarve/core";
import { createPoller } from "./poller";
import { sleep } from "../runtime/proc";

export const weather = store({
  ready: false,
  temperature: 0,
  code: 0,
  city: "",
});

let coords: { lat: number; lon: number; city: string } | undefined;

async function locate() {
  if (coords) return coords;
  const data = (await getJson("https://ipwho.is/")) as { latitude: number; longitude: number; city: string; success: boolean };
  if (!data.success) throw new Error("ip lookup failed");
  coords = { lat: data.latitude, lon: data.longitude, city: data.city };
  return coords;
}

/** fetch + json with a timeout and one retry: transient network drops (ECONNRESET) shouldn't surface. */
async function getJson(url: string): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      return await res.json();
    } catch (error) {
      if (attempt >= 1) throw error;
      await sleep(2_000);
    }
  }
}

export const weatherPoller = createPoller(15 * 60_000, async () => {
  const { lat, lon, city } = await locate();
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code`;
  const data = (await getJson(url)) as { current: { temperature_2m: number; weather_code: number } };
  weather.temperature = Math.round(data.current.temperature_2m);
  weather.code = data.current.weather_code;
  weather.city = city;
  weather.ready = true;
});

/** WMO weather code -> short Portuguese label. */
export function weatherLabel(code: number) {
  if (code === 0) return "Céu limpo";
  if (code <= 2) return "Parcialmente nublado";
  if (code === 3) return "Nublado";
  if (code <= 48) return "Neblina";
  if (code <= 67) return "Chuva";
  if (code <= 77) return "Neve";
  if (code <= 82) return "Pancadas";
  return "Tempestade";
}
