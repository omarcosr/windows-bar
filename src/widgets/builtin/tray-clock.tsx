import { Column, Text, store } from "@tarve/core";
import { openNotificationCenter } from "../../native/desktop";
import { launch } from "../../services/windows";
import { numeric, ui } from "../../theme";
import { Tile } from "../ui";
import { HoverTip } from "../../menu/hover-tip";
import { clockTip } from "../../services/clock-tooltip";
import { defineWidget } from "../types";
import { clockShowsSeconds, formatDate, formatTime } from "../../native/locale-format";

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
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const step = state.seconds ? 1000 : 60_000;
      timer = setTimeout(
        () => {
          state.now = new Date();
          // Windows' "show seconds" setting, re-read as it may change while the dock runs.
          if (state.now.getSeconds() < 1 || state.seconds) state.seconds = clockShowsSeconds();
          schedule();
        },
        step - (Date.now() % step) + 20,
      );
    };
    schedule();
    ctx.onDispose(() => clearTimeout(timer));
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
        <Column style={{ align: "end", gap: 2 }}>
          <Text size={13} weight={600} color={ui.text} style={numeric}>
            {time}
          </Text>
          {ctx.config.showDate ? (
            <Text size={12} weight={500} color={ui.muted} style={numeric}>
              {date}
            </Text>
          ) : null}
        </Column>
      </Tile>
      </HoverTip>
    );
  },
});
