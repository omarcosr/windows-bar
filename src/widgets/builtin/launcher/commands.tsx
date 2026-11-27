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

import { t } from "../../../i18n";
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
  name: t("widgets.launcher.commands.commands"),
  description: t("widgets.launcher.commands.typeCommandOrApp"),
  category: "productivity",
  defaultConfig: { showLabel: true },
  settings: [{ kind: "toggle", key: "showLabel", label: t("widgets.launcher.commands.showName") }],
  setup(ctx) {
    ctx.onDispose(acquireScreenTime());
    return {};
  },
  menu() {
    const apps = frequent();
    return [
      [{ label: t("widgets.launcher.commands.run"), icon: { fluent: fluentGlyph.run }, onSelect: openRunDialog }],
      apps,
      [{ label: t("widgets.launcher.commands.allApps"), icon: { fluent: fluentGlyph.apps }, onSelect: () => launch("shell:AppsFolder") }],
    ];
  },
  View({ ctx, preview }) {
    return (
      <HoverTip id={`tip:${ctx.instanceId}`} tip={() => ["Executar (Win+R)", t("widgets.launcher.commands.typeProgramFolderOr"), t("widgets.launcher.commands.mostUsedAppsOn")]} disabled={preview}>
      <Tile padding={{ left: 10, right: ctx.config.showLabel ? 12 : 10 }} onClick={preview ? undefined : openRunDialog}>
        <Glyph code={fluentGlyph.command} size={18} />
        {ctx.config.showLabel ? (
          <Text size={ui.tile.lines.primary} weight={600} color={ui.text} style={{ whiteSpace: "nowrap" }}>
            {t("widgets.launcher.commands.run2")}
          </Text>
        ) : null}
      </Tile>
      </HoverTip>
    );
  },
});
