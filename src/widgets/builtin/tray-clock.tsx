import { Column, Text, store } from "@tarve/core";
import { tapKeys, VK } from "../../native/win32";
import { launch } from "../../services/windows";
import { numeric, ui } from "../../theme";
import { Tile } from "../ui";
import { defineWidget } from "../types";

const pad = (n: number) => String(n).padStart(2, "0");

/** Time over date, right-aligned, as at the end of the Windows 11 taskbar. */
export default defineWidget({
  type: "tray-clock",
  name: "Relógio da barra",
  description: "Hora e data como no Windows. Clique abre a central de notificações.",
  category: "clock",
  defaultConfig: { hour12: false, seconds: false },
  setup(ctx) {
    const state = store({ now: new Date() });
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const step = ctx.config.seconds ? 1000 : 60_000;
      timer = setTimeout(
        () => {
          state.now = new Date();
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
        { label: "Notificações e calendário", icon: "bell", onSelect: () => tapKeys(VK.LWIN, 0x4e /* N */) },
        { label: "Ajustar data e hora", icon: "settings", onSelect: () => launch("ms-settings:dateandtime") },
        { label: "Abrir Relógio do Windows", icon: "bell", onSelect: () => launch("ms-clock:") },
      ],
    ];
  },
  View({ state, ctx }) {
    const now = state.now;
    let h = now.getHours();
    if (ctx.config.hour12) h = h % 12 || 12;
    const time = `${ctx.config.hour12 ? h : pad(h)}:${pad(now.getMinutes())}${ctx.config.seconds ? `:${pad(now.getSeconds())}` : ""}`;
    const date = `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()}`;
    return (
      <Tile padding={{ left: 12, right: 12 }} onClick={() => tapKeys(VK.LWIN, 0x4e /* N */)}>
        <Column style={{ align: "end", gap: 2 }}>
          <Text size={13} weight={600} color={ui.text} style={numeric}>
            {time}
          </Text>
          <Text size={12} weight={500} color={ui.muted} style={numeric}>
            {date}
          </Text>
        </Column>
      </Tile>
    );
  },
});
