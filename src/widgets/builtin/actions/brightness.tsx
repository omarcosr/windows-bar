import { actions, brightnessPoller, changeBrightness } from "../../../services/actions-state";
import { launch } from "../../../services/windows";
import { ui } from "../../../theme";
import { HoverTip } from "../../../menu/hover-tip";
import { RoundButton, Tile } from "../../ui";
import { defineWidget } from "../../types";
import { fluent, G, Glyph, Percent } from "./shared";

const STEP = 10;

/** Laptop panel brightness (display IOCTL) or, on desktops, the primary monitor's over DDC/CI. */
export default defineWidget({
  type: "actions-brightness",
  name: "Brilho",
  description: "Brilho da tela do notebook ou do monitor (DDC/CI). Some quando a tela não permite ajuste.",
  category: "system",
  defaultConfig: {},
  setup(ctx) {
    ctx.onDispose(brightnessPoller.acquire());
    return {};
  },
  hidden: () => actions.brightnessSource === "none",
  menu() {
    return [
      [0, 25, 50, 75, 100].map((v) => ({ label: `Brilho ${v}%`, icon: fluent(G.brightness), onSelect: () => changeBrightness(v) })),
      [{ label: "Configurações de vídeo", icon: fluent(G.settings), onSelect: () => launch("ms-settings:display") }],
    ];
  },
  View({ ctx, preview }) {
    const demo = preview && actions.brightnessSource !== "panel" && actions.brightnessSource !== "ddc";
    const level = demo ? 70 : actions.brightness;
    const size = ui.tile.control;
    const step = (delta: number) => () => !preview && changeBrightness(actions.brightness + delta);
    const tip = () => [`Brilho: ${actions.brightness}%`, actions.brightnessSource === "ddc" ? "Monitor (DDC/CI)" : "Tela integrada"];
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
