import { Column, Row, Text, View, store } from "@tarve/core";
import { weather, weatherLabel, weatherPoller } from "../../services/weather";
import { HoverTip } from "../../menu/hover-tip";
import { clockTip } from "../../services/clock-tooltip";
import { launch } from "../../services/windows";
import { numeric, ui } from "../../theme";
import { defineWidget } from "../types";

const days = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
const pad = (n: number) => String(n).padStart(2, "0");

export default defineWidget({
  type: "clock-weather",
  name: "Relógio e clima",
  description: "Hora, dia e temperatura num bloco só.",
  category: "clock",
  defaultConfig: { hour12: false, showWeather: true },
  settings: [
    { kind: "toggle", key: "hour12", label: "Formato 12 horas" },
    { kind: "toggle", key: "showWeather", label: "Mostrar temperatura", description: "O círculo com a temperatura atual." },
  ],
  setup(ctx) {
    const state = store({ now: new Date() });
    // Tick on the minute boundary so the clock never lags a full minute.
    const tick = () => (state.now = new Date());
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(
        () => {
          tick();
          schedule();
        },
        60_000 - (Date.now() % 60_000) + 50,
      );
    };
    schedule();
    ctx.onDispose(() => clearTimeout(timer));
    ctx.onDispose(weatherPoller.acquire());
    return state;
  },
  menu() {
    return [
      [
        { label: "Abrir Relógio do Windows", icon: "bell", onSelect: () => launch("ms-clock:") },
        { label: "Ajustar data e hora", icon: "settings", onSelect: () => launch("ms-settings:dateandtime") },
      ],
    ];
  },
  View({ state, ctx, preview }) {
    const now = state.now;
    let h = now.getHours();
    if (ctx.config.hour12) h = h % 12 || 12;
    const tip = () => [
      ...clockTip(!!ctx.config.hour12),
      weather.ready ? `${weather.city ? `${weather.city}: ` : ""}${weather.temperature}° · ${weatherLabel(weather.code)}` : "",
    ];
    return (
      <HoverTip id={`tip:${ctx.instanceId}`} tip={tip} disabled={preview}>
      <Column style={{ width: 66, height: ui.tile.height, radius: ui.tile.radius, overflow: "hidden", shrink: 0, background: "#000" }}>
        <Row style={{ height: 25, background: ui.red, align: "center", justify: "center" }}>
          <Text size={16} weight={700} color="#fff" style={numeric}>
            {`${pad(h)}:${pad(now.getMinutes())}`}
          </Text>
        </Row>
        <Row style={{ flex: 1, align: "center", justify: "between", padding: { left: 6, right: 5 } }}>
          <Column style={{ gap: 0 }}>
            <Text size={9} weight={600} color={ui.muted}>
              {days[now.getDay()]}
            </Text>
            <Text size={12} weight={700} color="#fff" style={{ ...numeric, lineHeight: 1 }}>
              {String(now.getDate())}
            </Text>
          </Column>
          {ctx.config.showWeather ? (
            <View style={{ width: 22, height: 22, radius: 11, background: "#d8d8dc", align: "center", justify: "center" }}>
              <Text size={9} weight={700} color="#111">
                {weather.ready ? `${weather.temperature}°` : "–"}
              </Text>
            </View>
          ) : null}
        </Row>
      </Column>
      </HoverTip>
    );
  },
});
