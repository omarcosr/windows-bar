import { Column, Text, store } from "@tarve/core";
import { openNotificationCenter } from "../../native/desktop";
import { launch } from "../../services/windows";
import { numeric, ui } from "../../theme";
import { Tile } from "../ui";
import { HoverTip } from "../../menu/hover-tip";
import { clockTip } from "../../services/clock-tooltip";
import { defineWidget } from "../types";
import { clockShowsSeconds, formatDate, formatTime } from "../../native/locale-format";
import { onWatchChange } from "../../native/shell-events";
import { every, onClock } from "../../services/clock";

/** Time over date, right-aligned, as at the end of the Windows 11 taskbar. */
export default defineWidget({
  type: "tray-clock",
  name: "Relógio da barra",
  description: "Hora e data nos formatos regionais do Windows. Clique abre a central de notificações.",
  category: "clock",
  // Time and date formats, and the seconds, follow Windows (Formato regional; Barra de tarefas).
  defaultConfig: { showDate: true },
  settings: [{ kind: "toggle", key: "showDate", label: "Mostrar data" }],
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
        { label: "Notificações e calendário", icon: "bell", onSelect: openNotificationCenter },
        { label: "Ajustar data e hora", icon: "settings", onSelect: () => launch("ms-settings:dateandtime") },
        { label: "Abrir Relógio do Windows", icon: "bell", onSelect: () => launch("ms-clock:") },
      ],
    ];
  },
  View({ state, ctx, preview }) {
    const now = state.now;
    const time = formatTime(now, { seconds: state.seconds });
    const date = formatDate(now, "short");
    return (
      <HoverTip id={`tip:${ctx.instanceId}`} tip={clockTip} disabled={preview}>
      <Tile padding={{ left: 12, right: 12 }} onClick={openNotificationCenter}>
        <Column style={{ align: "end", gap: ui.tile.lines.gap }}>
          <Text size={ui.tile.lines.primary} weight={600} color={ui.text} style={{ ...numeric, lineHeight: ui.tile.lines.lineHeight }}>
            {time}
          </Text>
          {ctx.config.showDate ? (
            <Text size={ui.tile.lines.secondary + 1} weight={500} color={ui.muted} style={{ ...numeric, lineHeight: ui.tile.lines.lineHeight }}>
              {date}
            </Text>
          ) : null}
        </Column>
      </Tile>
      </HoverTip>
    );
  },
});
