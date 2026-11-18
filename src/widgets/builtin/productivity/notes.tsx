import { HoverTip } from "../../../menu/hover-tip";
import { Stack } from "./shared";
import { ui } from "../../../theme";
import { Tile } from "../../ui";
import { defineWidget } from "../../types";
import { openWidgetSettings } from "../../../dock/widget-menu";
import type { DockMenuItem } from "../../../menu/dock-menu";
import { parseNotes } from "./tasks";

interface Config {
  notes: string;
}

export default defineWidget<Config, object>({
  type: "productivity-notes",
  name: "Notas",
  description: "Mostra a nota mais recente. Clique para editar.",
  category: "productivity",
  defaultConfig: { notes: "" },
  settings: [
    {
      kind: "text",
      key: "notes",
      label: "Notas",
      description: 'Separe as notas com ";". O dock mostra a última.',
      placeholder: "Comprar café; Ligar para a Ana às 15h",
    },
  ],
  setup() {
    return {};
  },
  menu({ ctx }) {
    const notes = parseNotes(String(ctx.config.notes ?? ""));
    const drop = (i: number) => {
      ctx.config.notes = notes.filter((_, j) => j !== i).join("; ");
      ctx.save();
    };
    const sections: DockMenuItem[][] = [
      notes
        .map((n, i) => ({ label: `Apagar: ${n}`, icon: "x" as const, onSelect: () => drop(i) }))
        .reverse()
        .slice(0, 8),
      [{ label: notes.length ? "Editar notas…" : "Nova nota…", icon: "plus", onSelect: () => openWidgetSettings(ctx.instanceId) }],
    ];
    return sections.filter((s) => s.length);
  },
  View({ ctx, preview }) {
    const notes = parseNotes(String(ctx.config.notes ?? ""));
    const demo = preview && !notes.length;
    const last = demo ? "Ligar para a Ana às 15h" : notes[notes.length - 1];
    const count = demo ? 3 : notes.length;
    return (
      <HoverTip id={`tip:${ctx.instanceId}`} tip={() => (notes.length ? [...notes.slice(-5).reverse(), "Clique para editar"] : ["Clique para escrever uma nota"])} disabled={preview}>
        <Tile width={168} background="#2a2614" onClick={preview ? undefined : () => openWidgetSettings(ctx.instanceId)}>
          <Stack label={count > 1 ? `Nota · ${count}` : "Nota"} labelColor="#c9b458" value={last ?? "Clique para escrever"} valueColor={last ? ui.text : ui.muted} valueWeight={600} valueSize={ui.tile.height < 32 ? 11 : ui.tile.height >= 46 ? 13 : 12} numericValue={false} />
          </Tile>
        </HoverTip>
    );
  },
});
