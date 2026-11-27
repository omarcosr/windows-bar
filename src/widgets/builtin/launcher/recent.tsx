import { Column, Row, Text } from "@tarve/core";
import { showDockMenu, type DockMenuItem } from "../../../menu/dock-menu";
import { recentItems } from "../../../services/launcher-shortcuts";
import { launch, openFileLocation } from "../../../services/windows";
import { ui } from "../../../theme";
import { HoverTip } from "../../../menu/hover-tip";
import { Tile } from "../../ui";
import { defineWidget } from "../../types";
import { Glyph, fluentGlyph, shellMenuIcon } from "./shared";

import { t } from "../../../i18n";
const LIMIT = 12;

function items(): DockMenuItem[] {
  return recentItems(LIMIT).map((item) => ({
    label: item.name,
    // The item's own shell icon (the target's), as Explorer lists Recent.
    icon: shellMenuIcon(item.target || item.path, fluentGlyph.history),
    // The shortcut itself, as Explorer opens a Recent entry.
    onSelect: () => launch(item.path),
    onContextMenu: () => openFileLocation(item.target || item.path),
  }));
}

function openList() {
  const list = items();
  showDockMenu({
    title: t("widgets.launcher.recent.recentlyOpened"),
    subtitle: list.length ? t("widgets.launcher.recent.clickToOpenRight") : t("widgets.launcher.recent.nothingOpenedRecently"),
    sections: [list, [{ label: t("widgets.launcher.recent.openRecentFolder"), icon: { fluent: fluentGlyph.openFolder }, onSelect: () => launch("shell:recent") }]],
  });
}

export default defineWidget({
  type: "launcher-recent",
  name: t("widgets.launcher.recent.recentlyOpened"),
  description: t("widgets.launcher.recent.filesAndFoldersOpened"),
  category: "apps",
  defaultConfig: { showLabel: true },
  settings: [{ kind: "toggle", key: "showLabel", label: t("widgets.launcher.recent.showName"), description: t("widgets.launcher.recent.whenOffBlockShows") }],
  setup() {
    return {};
  },
  menu() {
    return [items().slice(0, 6), [{ label: t("widgets.launcher.recent.openRecentFolder"), icon: { fluent: fluentGlyph.openFolder }, onSelect: () => launch("shell:recent") }]];
  },
  View({ ctx, preview }) {
    const lines = ui.tile.lines;
    const label = ctx.config.showLabel;
    return (
      <HoverTip id={`tip:${ctx.instanceId}`} tip={() => [t("widgets.launcher.recent.recentlyOpened"), ...recentItems(3).map((i) => i.name), t("widgets.launcher.recent.clickToSeeList")]} disabled={preview}>
      <Tile padding={{ left: 10, right: label ? 12 : 10 }} gap={8} onClick={preview ? undefined : openList}>
        <Glyph code={fluentGlyph.history} size={18} />
        {label ? (
          <Column style={{ gap: lines.gap }}>
            <Text size={lines.primary} weight={600} color={ui.text} style={{ lineHeight: lines.lineHeight }}>
              {t("widgets.launcher.recent.recent")}
            </Text>
            <Row>
              <Text size={lines.secondary} color={ui.muted} style={{ lineHeight: lines.lineHeight }}>
                {preview ? "12 itens" : t("widgets.launcher.recent.filesAndFolders")}
              </Text>
            </Row>
          </Column>
        ) : null}
      </Tile>
      </HoverTip>
    );
  },
});
