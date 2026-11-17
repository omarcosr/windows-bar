import { Column, Text } from "@tarve/core";
import { tapKeys, VK } from "../../native/win32";
import { launch } from "../../services/windows";
import { languagePoller, refreshLanguage, status } from "../../services/status";
import { ui } from "../../theme";
import { Tile } from "../ui";
import { HoverTip } from "../../menu/hover-tip";
import { defineWidget } from "../types";

/** The input language indicator ("POR / PTB2"); a click switches layouts like Win+Space. */
export default defineWidget({
  type: "tray-language",
  name: "Idioma do teclado",
  description: "Idioma e layout do teclado da janela em foco. Clique alterna o layout (Win+Espaço).",
  category: "system",
  defaultConfig: {},
  setup(ctx) {
    ctx.onDispose(languagePoller.acquire());
    return {};
  },
  menu() {
    return [
      [
        { label: "Trocar idioma do teclado", icon: "chevron-right", onSelect: () => tapKeys(VK.LWIN, 0x20 /* Space */) },
        { label: "Configurações de idioma", icon: "settings", onSelect: () => launch("ms-settings:regionlanguage") },
      ],
    ];
  },
  View({ ctx, preview }) {
    const tip = () => [status.languageName || status.language, status.layout ? `Teclado ${status.layout}` : "", "Para alternar, pressione Windows + Espaço"];
    return (
      <HoverTip id={`tip:${ctx.instanceId}`} tip={tip} disabled={preview}>
      <Tile
        padding={{ left: 10, right: 10 }}
        onClick={() => {
          tapKeys(VK.LWIN, 0x20 /* Space */);
          setTimeout(refreshLanguage, 250);
        }}
      >
        <Column style={{ align: "center", gap: ui.tile.lines.gap }}>
          <Text size={ui.tile.lines.primary} weight={600} color={ui.text} style={{ lineHeight: ui.tile.lines.lineHeight }}>
            {status.language || "–"}
          </Text>
          <Text size={ui.tile.lines.secondary} weight={500} color={ui.muted} style={{ lineHeight: ui.tile.lines.lineHeight }}>
            {status.layout}
          </Text>
        </Column>
      </Tile>
      </HoverTip>
    );
  },
});
