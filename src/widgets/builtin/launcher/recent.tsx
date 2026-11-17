import { Column, Row, Text } from "@tarve/core";
import { showDockMenu, type DockMenuItem } from "../../../menu/dock-menu";
import { recentItems } from "../../../services/launcher-shortcuts";
import { launch, openFileLocation } from "../../../services/windows";
import { ui } from "../../../theme";
import { Tile } from "../../ui";
import { defineWidget } from "../../types";
import { Glyph, fluentGlyph, shellMenuIcon } from "./shared";

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
    title: "Abertos recentemente",
    subtitle: list.length ? "Clique para abrir · botão direito mostra na pasta" : "Nada aberto recentemente",
    sections: [list, [{ label: "Abrir pasta Recentes", icon: { fluent: fluentGlyph.openFolder }, onSelect: () => launch("shell:recent") }]],
  });
}

export default defineWidget({
  type: "launcher-recent",
  name: "Abertos recentemente",
  description: "Arquivos e pastas abertos por último (shell:recent), com os ícones do Windows.",
  category: "apps",
  defaultConfig: { showLabel: true },
  settings: [{ kind: "toggle", key: "showLabel", label: "Mostrar o nome", description: "Desligado, o bloco mostra só o ícone." }],
  setup() {
    return {};
  },
  menu() {
    return [items().slice(0, 6), [{ label: "Abrir pasta Recentes", icon: { fluent: fluentGlyph.openFolder }, onSelect: () => launch("shell:recent") }]];
  },
  View({ ctx, preview }) {
    const lines = ui.tile.lines;
    const label = ctx.config.showLabel;
    return (
      <Tile padding={{ left: 10, right: label ? 12 : 10 }} gap={8} onClick={preview ? undefined : openList}>
        <Glyph code={fluentGlyph.history} size={18} />
        {label ? (
          <Column style={{ gap: lines.gap }}>
            <Text size={lines.primary} weight={600} color={ui.text} style={{ lineHeight: lines.lineHeight }}>
              Recentes
            </Text>
            <Row>
              <Text size={lines.secondary} color={ui.muted} style={{ lineHeight: lines.lineHeight }}>
                {preview ? "12 itens" : "Arquivos e pastas"}
              </Text>
            </Row>
          </Column>
        ) : null}
      </Tile>
    );
  },
});
