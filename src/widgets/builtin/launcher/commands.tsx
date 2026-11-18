import { Text } from "@tarve/core";
import type { DockMenuItem } from "../../../menu/dock-menu";
import { openRunDialog } from "../../../native/desktop";
import { acquireScreenTime, topApps } from "../../../services/launcher-screen-time";
import { shortcutFor } from "../../../services/launcher-shortcuts";
import { launch } from "../../../services/windows";
import { ui } from "../../../theme";
import { HoverTip } from "../../../menu/hover-tip";
import { Tile } from "../../ui";
import { defineWidget } from "../../types";
import { Glyph, fluentGlyph, shellMenuIcon } from "./shared";

/**
 * Type a command to start an app: the dock takes no keyboard focus and its menu has no text field,
 * so typing goes to Windows' own command box, the Run dialog (Explorer's File > Run, as the
 * Win+X menu opens it). The right-click menu lists the apps used most this week, started through
 * their Start menu shortcut when there is one, as Start starts them.
 */

function frequent(): DockMenuItem[] {
  return topApps(7, 8).map((app) => {
    const isPath = /^[a-z]:\\/i.test(app.exe);
    const link = isPath ? shortcutFor(app.exe) : undefined;
    const path = link?.path ?? app.exe;
    return { label: link?.name ?? app.name, icon: shellMenuIcon(path, fluentGlyph.apps), onSelect: () => launch(path) };
  });
}

export default defineWidget({
  type: "launcher-commands",
  name: "Comandos",
  description: "Digite um comando ou app para abrir (caixa Executar do Windows) e atalhos dos apps mais usados.",
  category: "productivity",
  defaultConfig: { showLabel: true },
  settings: [{ kind: "toggle", key: "showLabel", label: "Mostrar o nome" }],
  setup(ctx) {
    ctx.onDispose(acquireScreenTime());
    return {};
  },
  menu() {
    const apps = frequent();
    return [
      [{ label: "Executar…", icon: { fluent: fluentGlyph.run }, onSelect: openRunDialog }],
      apps,
      [{ label: "Todos os apps", icon: { fluent: fluentGlyph.apps }, onSelect: () => launch("shell:AppsFolder") }],
    ];
  },
  View({ ctx, preview }) {
    return (
      <HoverTip id={`tip:${ctx.instanceId}`} tip={() => ["Executar (Win+R)", "Digite um programa, pasta ou endereço", "Apps mais usados no botão direito"]} disabled={preview}>
      <Tile padding={{ left: 10, right: ctx.config.showLabel ? 12 : 10 }} onClick={preview ? undefined : openRunDialog}>
        <Glyph code={fluentGlyph.command} size={18} />
        {ctx.config.showLabel ? (
          <Text size={ui.tile.lines.primary} weight={600} color={ui.text} style={{ whiteSpace: "nowrap" }}>
            Executar
          </Text>
        ) : null}
      </Tile>
      </HoverTip>
    );
  },
});
