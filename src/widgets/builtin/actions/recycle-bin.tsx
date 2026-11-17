import { Column, Image, Text, type ImageRgbaSource } from "@tarve/core";
import { shellIconPixels, systemScale } from "../../../native/shell-icon";
import { actions, emptyRecycle, formatBytes, recyclePoller } from "../../../services/actions-state";
import { launch } from "../../../services/windows";
import { devicePx, numeric, ui } from "../../../theme";
import { HoverTip } from "../../../menu/hover-tip";
import { Tile } from "../../ui";
import { defineWidget } from "../../types";
import { fluent, G, Glyph } from "./shared";

const FOLDER = "shell:RecycleBinFolder";
const icons = new Map<string, ImageRgbaSource | null>();

/** The Recycle Bin's own shell icon (empty or full, as the desktop shows it) at the drawn pixel size. */
function binIcon(size: number, full: boolean) {
  const px = Math.round(size * systemScale());
  const key = `${px}|${full}`;
  if (!icons.has(key)) {
    let pixels = null;
    try {
      pixels = shellIconPixels(FOLDER, px);
    } catch {
      pixels = null;
    }
    icons.set(key, pixels ? { ...pixels, cacheKey: `actions-recycle:${key}` } : null);
  }
  return icons.get(key) ?? null;
}

const count = (n: number) => (n === 1 ? "1 item" : `${n.toLocaleString("pt-BR")} itens`);

export default defineWidget({
  type: "actions-recycle-bin",
  name: "Lixeira",
  description: "Itens e espaço ocupados na Lixeira. Clique abre a Lixeira; o menu a esvazia.",
  category: "apps",
  defaultConfig: { showDetails: true },
  settings: [{ kind: "toggle", key: "showDetails", label: "Mostrar quantidade e tamanho" }],
  setup(ctx) {
    ctx.onDispose(recyclePoller.acquire());
    return {};
  },
  menu() {
    return [
      [{ label: "Abrir Lixeira", icon: fluent(G.recycle), onSelect: () => launch(FOLDER) }],
      actions.recycleItems > 0 ? [{ label: "Esvaziar Lixeira", icon: fluent(G.recycle), danger: true, onSelect: emptyRecycle }] : [],
    ].filter((section) => section.length > 0);
  },
  View({ ctx, preview }) {
    const demo = preview && actions.recycleItems === 0;
    const items = demo ? 12 : actions.recycleItems;
    const bytes = demo ? 48_300_000 : actions.recycleBytes;
    const size = devicePx(Math.min(28, ui.tile.height - 14), true);
    // The shell's icon reflects the bin's state itself; the key only forces a re-read when it flips.
    const icon = binIcon(size, items > 0);
    const lines = ui.tile.lines;
    return (
      <HoverTip id={`tip:${ctx.instanceId}:bin`} tip={() => ["Lixeira", actions.recycleItems ? `${count(actions.recycleItems)} · ${formatBytes(actions.recycleBytes)}` : "Vazia"]} disabled={preview}>
        <Tile padding={{ left: 8, right: ctx.config.showDetails ? 12 : 8 }} onClick={preview ? undefined : () => launch(FOLDER)}>
          {icon ? <Image src={icon} width={size} height={size} fit="contain" /> : <Glyph code={G.recycle} />}
          {ctx.config.showDetails ? (
            <Column style={{ gap: lines.gap }}>
              <Text size={lines.primary} weight={600} color={ui.text} style={{ ...numeric, lineHeight: lines.lineHeight }}>
                {items ? count(items) : "Vazia"}
              </Text>
              {items ? (
                <Text size={lines.secondary} color={ui.muted} style={{ ...numeric, lineHeight: lines.lineHeight }}>
                  {formatBytes(bytes)}
                </Text>
              ) : null}
            </Column>
          ) : null}
        </Tile>
      </HoverTip>
    );
  },
});
