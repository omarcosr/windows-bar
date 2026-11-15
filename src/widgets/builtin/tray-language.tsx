import { Column, Text } from "@tarve/core";
import { tapKeys, VK } from "../../native/win32";
import { launch } from "../../services/windows";
import { languagePoller, refreshLanguage, status } from "../../services/status";
import { ui } from "../../theme";
import { Tile } from "../ui";
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
  View() {
    return (
      <Tile
        padding={{ left: 10, right: 10 }}
        onClick={() => {
          tapKeys(VK.LWIN, 0x20 /* Space */);
          setTimeout(refreshLanguage, 250);
        }}
      >
        <Column style={{ align: "center", gap: 2 }}>
          <Text size={12} weight={600} color={ui.text}>
            {status.language || "–"}
          </Text>
          <Text size={11} weight={500} color={ui.muted}>
            {status.layout}
          </Text>
        </Column>
      </Tile>
    );
  },
});
