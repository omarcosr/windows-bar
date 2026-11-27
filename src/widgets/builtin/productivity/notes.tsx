import { HoverTip } from "../../../menu/hover-tip";
import { Stack } from "./shared";
import { ui } from "../../../theme";
import { Tile } from "../../ui";
import { FluentGlyph } from "../../../menu/dock-menu";
import { defineWidget } from "../../types";
import { openWidgetSettings } from "../../../dock/widget-menu";
import type { DockMenuItem } from "../../../menu/dock-menu";
import { parseNotes } from "./tasks";

import { t } from "../../../i18n";
interface Config {
  notes: string;
}

export default defineWidget<Config, object>({
  type: "productivity-notes",
  name: t("widgets.productivity.notes.notes"),
  description: t("widgets.productivity.notes.showsMostRecentNote"),
  category: "productivity",
  defaultConfig: { notes: "" },
  settings: [
    {
      kind: "text",
      key: "notes",
      label: t("widgets.productivity.notes.notes"),
      description: t("widgets.productivity.notes.separateNotesWithDock"),
      placeholder: t("widgets.productivity.notes.buyCoffeeCallAna"),
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
        .map((n, i) => ({ label: t("widgets.productivity.notes.delete", { n }), icon: "x" as const, onSelect: () => drop(i) }))
        .reverse()
        .slice(0, 8),
      [{ label: notes.length ? t("widgets.productivity.notes.editNotes") : t("widgets.productivity.notes.newNote"), icon: "plus", onSelect: () => openWidgetSettings(ctx.instanceId) }],
    ];
    return sections.filter((s) => s.length);
  },
  View({ ctx, preview }) {
    const notes = parseNotes(String(ctx.config.notes ?? ""));
    const demo = preview && !notes.length;
    const last = demo ? t("widgets.productivity.notes.callAnaAt3") : notes[notes.length - 1];
    const count = demo ? 3 : notes.length;
    return (
      <HoverTip id={`tip:${ctx.instanceId}`} tip={() => (notes.length ? [...notes.slice(-5).reverse(), t("widgets.productivity.notes.clickToEdit")] : [t("widgets.productivity.notes.clickToWriteNote")])} disabled={preview}>
        <Tile icon={<FluentGlyph code={0xe70b} size={ui.app.icon - 4} color={"#ffd60a"} />} value={count ? String(count) : undefined} width={168} background="#2a2614" onClick={preview ? undefined : () => openWidgetSettings(ctx.instanceId)}>
          <Stack label={count > 1 ? t("widgets.productivity.notes.note", { count }) : t("widgets.productivity.notes.note2")} labelColor="#c9b458" value={last ?? t("widgets.productivity.notes.clickToWrite")} valueColor={last ? ui.text : ui.muted} valueWeight={600} valueSize={ui.tile.height < 32 ? 11 : ui.tile.height >= 46 ? 13 : 12} numericValue={false} />
          </Tile>
        </HoverTip>
    );
  },
});
