import { Pressable, Text, View } from "@tarve/core";
import { openRunDialog, openStartMenu } from "../../../native/desktop";
import { launch } from "../../../services/windows";
import { ui } from "../../../theme";
import { Tile, iconHover } from "../../ui";
import { defineWidget } from "../../types";
import { SEARCH_TYPE, dockIndex, dockMetrics, inDockGroup, magnifyStyles, searchLook, searchSlots } from "../../magnify";
import { Glyph, fluentGlyph } from "./shared";

import { t } from "../../../i18n";
/** Standalone widths, when the box is not next to Start or Apps. */
const TILE_WIDTH = { label: 112, normal: 150, wide: 220 };

/**
 * A search box like the taskbar's. The dock takes no keyboard focus and its menu has no text field,
 * so typing happens in Windows Search itself: a click opens Start (whose search starts as you
 * type), the same SC_TASKLIST command start.tsx sends for "Pesquisar".
 *
 * Placed right next to Start or Apps it joins their group, as the taskbar's Search sits between
 * Start and the app buttons; "Seguir o Windows" draws it as Taskbar settings > Search says.
 */
export default defineWidget({
  type: SEARCH_TYPE,
  name: t("widgets.launcher.search.search"),
  description: t("widgets.launcher.search.searchBoxThatOpens"),
  category: "apps",
  defaultConfig: { width: "system" },
  settings: [
    {
      kind: "choice",
      key: "width",
      label: t("widgets.launcher.search.appearance"),
      options: [
        { value: "system", label: t("widgets.launcher.search.followWindows") },
        { value: "icon", label: t("widgets.launcher.search.iconOnly") },
        { value: "label", label: t("widgets.launcher.search.iconAndLabel") },
        { value: "normal", label: t("widgets.launcher.search.box") },
        { value: "wide", label: t("widgets.launcher.search.wideBox") },
      ],
    },
  ],
  setup() {
    return {};
  },
  hidden({ ctx }) {
    return searchLook(ctx.config.width) === "hidden";
  },
  menu() {
    return [
      [
        { label: t("widgets.launcher.search.searchWindows"), icon: "search", onSelect: openStartMenu },
        { label: t("widgets.launcher.search.searchFiles"), icon: "folder", onSelect: () => launch("search-ms:") },
        { label: t("widgets.launcher.search.run"), icon: { fluent: fluentGlyph.run }, onSelect: openRunDialog },
      ],
      [{ label: t("widgets.launcher.search.taskbarSettings"), icon: "settings", onSelect: () => launch("ms-settings:taskbar") }],
    ];
  },
  View({ ctx, preview }) {
    const look = searchLook(ctx.config.width);
    const shown = look === "hidden" ? "icon" : look;
    const onClick = preview ? undefined : openStartMenu;
    const grouped = !preview && inDockGroup(ctx.instanceId);

    if (grouped && shown === "icon") {
      // One app slot, magnified with the icons like the Start button.
      const magnify = magnifyStyles("dock", dockIndex(ctx.instanceId, 0), dockMetrics());
      return (
        <Pressable
          onClick={onClick}
          style={{
            position: "relative",
            width: ui.app.slot,
            height: ui.tile.height,
            radius: 10,
            align: "center",
            justify: "center",
            cursor: "pointer",
            shrink: 0,
            ...iconHover({ magnified: true }),
            ...magnify.slot,
          }}
        >
          <View style={magnify.box}>
            <View style={{ align: "center", justify: "center", ...magnify.icon }}>
              <Glyph code={fluentGlyph.search} size={Math.round((magnify.size * 18) / 32)} />
            </View>
          </View>
        </Pressable>
      );
    }

    if (grouped) {
      // A whole number of app slots, so the group's magnification keeps its spacing.
      const width = searchSlots(shown) * ui.app.slot;
      return (
        <View style={{ width, height: ui.tile.height, align: "center", justify: "center", shrink: 0 }}>
          <Tile width={width - 8} padding={{ left: 12, right: 12 }} gap={9} onClick={onClick} style={{ radius: ui.tile.height / 2 }}>
            <Glyph code={fluentGlyph.search} size={16} color={ui.muted} />
            <Text size={ui.tile.lines.primary} color={ui.muted} style={{ whiteSpace: "nowrap" }}>
              {t("widgets.launcher.search.search")}
            </Text>
          </Tile>
        </View>
      );
    }

    if (shown === "icon") {
      return (
        <Tile padding={{ left: 12, right: 12 }} onClick={onClick}>
          <Glyph code={fluentGlyph.search} size={18} />
        </Tile>
      );
    }
    return (
      <Tile width={TILE_WIDTH[shown]} padding={{ left: 12, right: 12 }} gap={9} onClick={onClick}>
        <Glyph code={fluentGlyph.search} size={16} color={ui.muted} />
        <Text size={ui.tile.lines.primary} color={ui.muted} style={{ whiteSpace: "nowrap" }}>
          {t("widgets.launcher.search.search")}
        </Text>
      </Tile>
    );
  },
});
