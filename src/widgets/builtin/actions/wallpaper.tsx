import { Image, Pressable } from "@tarve/core";
import { showDockMenu, type DockMenuItem } from "../../../menu/dock-menu";
import { actions, advanceWallpaper, applyWallpaper, wallpaperChoices, wallpaperPoller } from "../../../services/actions-state";
import { launch } from "../../../services/windows";
import { devicePx, ui } from "../../../theme";
import { HoverTip } from "../../../menu/hover-tip";
import { RoundButton, Tile } from "../../ui";
import { defineWidget } from "../../types";
import { fluent, G, Glyph } from "./shared";

import { t } from "../../../i18n";
const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

function pick(path: string): DockMenuItem {
  return { label: fileName(path), icon: { image: path }, onSelect: () => applyWallpaper(path) };
}

/** Windows' wallpapers and the user's Pictures, as a grid; a click sets one on every monitor. */
function openGallery() {
  const { system, user } = wallpaperChoices();
  const sections = [system.map(pick), user.map(pick)].filter((s) => s.length > 0);
  if (!sections.length) {
    launch("ms-settings:personalization-background");
    return;
  }
  showDockMenu({ title: t("widgets.actions.wallpaper.wallpaper"), sections, grid: true });
}

export default defineWidget({
  type: "actions-wallpaper",
  name: t("widgets.actions.wallpaper.wallpaper"),
  description: t("widgets.actions.wallpaper.showsCurrentWallpaperAnd"),
  category: "apps",
  defaultConfig: {},
  setup(ctx) {
    ctx.onDispose(wallpaperPoller.acquire());
    return {};
  },
  menu() {
    return [
      [
        { label: t("widgets.actions.wallpaper.chooseWallpaper"), icon: fluent(G.photo), onSelect: openGallery },
        ...(actions.slideshow ? [{ label: t("widgets.actions.wallpaper.nextWallpaper"), icon: fluent(G.next), onSelect: advanceWallpaper }] : []),
      ],
      [{ label: t("widgets.actions.wallpaper.personalizeWallpaper"), icon: fluent(G.settings), onSelect: () => launch("ms-settings:personalization-background") }],
    ];
  },
  View({ ctx, preview }) {
    const h = devicePx(ui.tile.height - 10, true);
    const w = devicePx(h * 1.6, true);
    return (
      <Tile padding={{ left: 5, right: actions.slideshow ? 6 : 5 }} gap={6}>
        <HoverTip id={`tip:${ctx.instanceId}:wallpaper`} tip={() => [t("widgets.actions.wallpaper.wallpaper"), fileName(actions.wallpaper) || t("widgets.actions.wallpaper.solidColor")]} disabled={preview}>
          <Pressable
            onClick={preview ? undefined : openGallery}
            style={{ width: w, height: h, radius: 8, overflow: "hidden", background: "#2a2a2e", cursor: preview ? "default" : "pointer" }}
          >
            {actions.wallpaper ? <Image src={actions.wallpaper} width={w} height={h} fit="cover" /> : null}
          </Pressable>
        </HoverTip>
        {actions.slideshow ? (
          <RoundButton size={ui.tile.control} onClick={() => !preview && advanceWallpaper()}>
            <Glyph code={G.next} size={13} />
          </RoundButton>
        ) : null}
      </Tile>
    );
  },
});
