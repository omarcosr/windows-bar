import { actions, brightnessPoller, changeBrightness } from "../../../services/actions-state";
import { launch } from "../../../services/windows";
import { ui } from "../../../theme";
import { HoverTip } from "../../../menu/hover-tip";
import { RoundButton, Tile } from "../../ui";
import { defineWidget } from "../../types";
import { fluent, G, Glyph, Percent } from "./shared";

import { t } from "../../../i18n";
const STEP = 10;

/** Laptop panel brightness (display IOCTL) or, on desktops, the primary monitor's over DDC/CI. */
export default defineWidget({
  type: "actions-brightness",
  name: t("widgets.actions.brightness.brightness"),
  description: t("widgets.actions.brightness.brightnessOfLaptopScreen"),
  category: "system",
  defaultConfig: {},
  setup(ctx) {
    ctx.onDispose(brightnessPoller.acquire());
    return {};
  },
  hidden: () => actions.brightnessSource === "none",
  menu() {
    return [
      [0, 25, 50, 75, 100].map((v) => ({ label: t("widgets.actions.brightness.brightness2", { v }), icon: fluent(G.brightness), onSelect: () => changeBrightness(v) })),
      [{ label: t("widgets.actions.brightness.displaySettings"), icon: fluent(G.settings), onSelect: () => launch("ms-settings:display") }],
    ];
  },
  View({ ctx, preview }) {
    const demo = preview && actions.brightnessSource !== "panel" && actions.brightnessSource !== "ddc";
    const level = demo ? 70 : actions.brightness;
    const size = ui.tile.control;
    const step = (delta: number) => () => !preview && changeBrightness(actions.brightness + delta);
    const tip = () => [t("widgets.actions.brightness.brightness3", { p0: actions.brightness }), actions.brightnessSource === "ddc" ? "Monitor (DDC/CI)" : t("widgets.actions.brightness.builtInDisplay")];
    return (
      <HoverTip id={`tip:${ctx.instanceId}:brightness`} tip={tip} disabled={preview}>
        <Tile padding={{ left: 6, right: 6 }} gap={6}>
          <RoundButton size={size} onClick={step(-STEP)}>
            <Glyph code={G.minus} size={12} />
          </RoundButton>
          <Glyph code={G.brightness} size={15} />
          <Percent value={level} />
          <RoundButton size={size} onClick={step(STEP)}>
            <Glyph code={G.plus} size={12} />
          </RoundButton>
        </Tile>
      </HoverTip>
    );
  },
});
