import { Column, Text } from "@tarve/core";
import { nextKeyboardLayout } from "../../native/status";
import { foregroundApp, launch } from "../../services/windows";
import { languagePoller, refreshLanguage, status } from "../../services/status";
import { ui } from "../../theme";
import { Tile } from "../ui";
import { defineWidget } from "../types";

/**
 * Switches the app in front to the next input language, as Win+Space and the taskbar's language
 * button do: WM_INPUTLANGCHANGEREQUEST to its window (native/status.ts nextKeyboardLayout). The
 * indicator follows from HSHELL_LANGUAGE; the re-read is for a change the shell does not announce.
 */
function switchLanguage() {
  if (nextKeyboardLayout(foregroundApp())) setTimeout(refreshLanguage, 250);
}

/** The input language indicator ("POR / PTB2"); a click switches layouts like Win+Space. */
export default defineWidget({
  type: "tray-language",
  sideForm: "full",
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
        { label: "Trocar idioma do teclado", icon: "chevron-right", onSelect: switchLanguage },
        { label: "Configurações de idioma", icon: "settings", onSelect: () => launch("ms-settings:regionlanguage") },
      ],
    ];
  },
  View({ ctx, preview }) {
    const tip = () => [status.languageName || status.language, status.layout ? `Teclado ${status.layout}` : "", "Para alternar, pressione Windows + Espaço"];
    return (
      <Tile onClick={switchLanguage} preview={preview} side="full" tip={{ id: `tip:${ctx.instanceId}`, lines: tip }}>
        <Column style={{ align: "center", gap: ui.tile.lines.gap }}>
          <Text size={ui.tile.lines.primary} weight={600} color={ui.text} style={{ lineHeight: ui.tile.lines.lineHeight }}>
            {status.language || "–"}
          </Text>
          <Text size={ui.tile.lines.secondary} weight={500} color={ui.muted} style={{ lineHeight: ui.tile.lines.lineHeight }}>
            {status.layout}
          </Text>
        </Column>
      </Tile>
    );
  },
});
