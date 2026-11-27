import { Column, Row, Text, View, store } from "@tarve/core";
import { weather, weatherLabel, weatherPoller } from "../../services/weather";
import { Tile } from "../ui";
import { openNotificationCenter } from "../../native/desktop";
import { clockTip } from "../../services/clock-tooltip";
import { launch } from "../../services/windows";
import { numeric, ui } from "../../theme";
import { defineWidget } from "../types";
import { formatDatePicture, formatTime } from "../../native/locale-format";
import { every, onClock } from "../../services/clock";

import { t } from "../../i18n";
/** "seg." → "Seg": Windows' abbreviated weekday, capitalised for the label. */
const weekday = (d: Date) => {
  const day = formatDatePicture(d, "ddd").replace(/\.$/, "");
  return day.charAt(0).toUpperCase() + day.slice(1);
};

export default defineWidget({
  type: "clock-weather",
  name: t("widgets.clockWeather.clockAndWeather"),
  description: t("widgets.clockWeather.timeDayAndTemperature"),
  category: "clock",
  // The time and the weekday follow Windows' regional format.
  defaultConfig: { showWeather: true },
  settings: [
    { kind: "toggle", key: "showWeather", label: t("widgets.clockWeather.showTemperature"), description: t("widgets.clockWeather.circleWithCurrentTemperature") },
  ],
  setup(ctx) {
    const state = store({ now: new Date() });
    // Moves on the minute boundary (the shared clock), so the time never lags a full minute.
    ctx.onDispose(onClock(every("minute"), (now) => (state.now = new Date(now))).cancel);
    ctx.onDispose(weatherPoller.acquire());
    return state;
  },
  menu() {
    return [
      [
        { label: t("widgets.clockWeather.openWindowsClock"), icon: "bell", onSelect: () => launch("ms-clock:") },
        { label: t("widgets.clockWeather.adjustDateAndTime"), icon: "settings", onSelect: () => launch("ms-settings:dateandtime") },
      ],
    ];
  },
  View({ state, ctx, preview }) {
    const now = state.now;
    const compact = ui.tile.height < 44;
    const head = compact ? 15 : 25;
    // Below the red band: the circle only where it fits whole (from the 48 px bar), else plain text.
    const room = ui.tile.height - head;
    const badge = compact ? 16 : 22;
    const circle = room >= badge + 3;
    const tip = () => [
      ...clockTip(),
      weather.ready ? `${weather.city ? `${weather.city}: ` : ""}${weather.temperature}° · ${weatherLabel(weather.code)}` : "",
    ];
    return (
      // A clock: a click opens the calendar and notifications, as the taskbar clock does.
      <Tile
        width={66}
        background="#000"
        padding={0}
        gap={0}
        onClick={openNotificationCenter}
        preview={preview}
        tip={{ id: `tip:${ctx.instanceId}`, lines: tip }}
        style={{ direction: "column", align: "stretch" }}
      >
        <Row style={{ height: head, background: ui.red, align: "center", justify: "center" }}>
          <Text size={compact ? 12 : 16} weight={700} color="#fff" style={numeric}>
            {formatTime(now)}
          </Text>
        </Row>
        <Row style={{ flex: 1, align: "center", justify: "between", padding: { left: 6, right: 5 } }}>
          {compact ? (
            // The Windows-height bar (48 px) has room for one line: "Ter 17".
            <Text size={10} weight={700} color="#fff" style={{ ...numeric, lineHeight: 1 }}>
              {`${weekday(now)} ${now.getDate()}`}
            </Text>
          ) : (
            <Column style={{ gap: 0 }}>
              <Text size={9} weight={600} color={ui.muted}>
                {weekday(now)}
              </Text>
              <Text size={12} weight={700} color="#fff" style={{ ...numeric, lineHeight: 1 }}>
                {String(now.getDate())}
              </Text>
            </Column>
          )}
          {!ctx.config.showWeather ? null : circle ? (
            <View style={{ width: badge, height: badge, radius: badge / 2, background: "#d8d8dc", align: "center", justify: "center" }}>
              <Text size={compact ? 8 : 9} weight={700} color="#111" style={{ ...numeric, lineHeight: 1 }}>
                {weather.ready ? `${weather.temperature}°` : "–"}
              </Text>
            </View>
          ) : (
            <Text size={10} weight={700} color="#d8d8dc" style={{ ...numeric, lineHeight: 1 }}>
              {weather.ready ? `${weather.temperature}°` : "–"}
            </Text>
          )}
        </Row>
      </Tile>
    );
  },
});
