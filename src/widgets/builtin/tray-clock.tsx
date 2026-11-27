import { Column, Text, store } from "@tarve/core";
import { openNotificationCenter } from "../../native/desktop";
import { launch } from "../../services/windows";
import { numeric, ui } from "../../theme";
import { Tile } from "../ui";
import { dockVertical } from "../../services/taskbar-prefs";
import { clockTip } from "../../services/clock-tooltip";
import { defineWidget } from "../types";
import { clockShowsSeconds, formatDate, formatDayMonth, formatTime } from "../../native/locale-format";
import { onWatchChange } from "../../native/shell-events";
import { every, onClock } from "../../services/clock";

import { t } from "../../i18n";
/** Time over date, right-aligned, as at the end of the Windows 11 taskbar. */
export default defineWidget({
  type: "tray-clock",
  sideForm: "full",
  name: t("widgets.trayClock.taskbarClock"),
  description: t("widgets.trayClock.timeAndDateIn"),
  category: "clock",
  // Time and date formats, and the seconds, follow Windows (Formato regional; Barra de tarefas).
  defaultConfig: { showDate: true },
  settings: [{ kind: "toggle", key: "showDate", label: t("widgets.trayClock.showDate") }],
  setup(ctx) {
    const state = store({ now: new Date(), seconds: clockShowsSeconds() });
    // One wake per shown minute (or second), on the shared clock, as Explorer's clock does.
    const sub = onClock(every(() => (state.seconds ? "second" : "minute")), (now) => (state.now = new Date(now)));
    // Windows' "show seconds" (Explorer\Advanced ShowSecondsInSystemClock), re-read when the key
    // changes (RegNotifyChangeKeyValue in the shell-events worker) instead of on every tick.
    ctx.onDispose(
      onWatchChange(["advanced"], () => {
        const seconds = clockShowsSeconds();
        if (seconds === state.seconds) return;
        state.seconds = seconds;
        state.now = new Date();
        sub.update();
      }),
    );
    ctx.onDispose(sub.cancel);
    return state;
  },
  menu() {
    return [
      [
        { label: t("widgets.trayClock.notificationsAndCalendar"), icon: "bell", onSelect: openNotificationCenter },
        { label: t("widgets.trayClock.adjustDateAndTime"), icon: "settings", onSelect: () => launch("ms-settings:dateandtime") },
        { label: t("widgets.trayClock.openWindowsClock"), icon: "bell", onSelect: () => launch("ms-clock:") },
      ],
    ];
  },
  View({ state, ctx, preview }) {
    const now = state.now;
    const time = formatTime(now, { seconds: state.seconds });
    // A side-edge column is narrow: the date without its year ("19/11"), as Windows' vertical taskbar shows it.
    const vertical = dockVertical() && !preview;
    const date = vertical ? formatDayMonth(now) : formatDate(now, "short");
    return (
      <Tile onClick={openNotificationCenter} preview={preview} side="full" tip={{ id: `tip:${ctx.instanceId}`, lines: clockTip }}>
        <Column style={{ align: vertical ? "center" : "end", gap: ui.tile.lines.gap }}>
          <Text size={ui.tile.lines.primary} weight={400} color={ui.text} style={{ ...numeric, lineHeight: ui.tile.lines.lineHeight }}>
            {time}
          </Text>
          {ctx.config.showDate ? (
            // Windows 11 draws the date as the time: same size, same colour, right-aligned under it.
            <Text size={ui.tile.lines.primary} weight={400} color={ui.text} style={{ ...numeric, lineHeight: ui.tile.lines.lineHeight }}>
              {date}
            </Text>
          ) : null}
        </Column>
      </Tile>
    );
  },
});
