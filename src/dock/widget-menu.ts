import { config } from "../config";
import { glyph, showDockMenu, type DockMenuItem } from "../menu/dock-menu";
import type { MountedWidget } from "../widgets/host";
import { moveWidget, removeWidget } from "./state";

let openGallery: () => void = () => {};

/** main.tsx hands over how to open the widget gallery. */
export function setGalleryOpener(open: () => void) {
  openGallery = open;
}

/** Right-click on a widget: its own actions first, then moving and removing it. */
export function openWidgetMenu(widget: MountedWidget) {
  const { definition, instance } = widget;
  const own = definition.menu?.({ state: widget.state, ctx: widget.ctx }) ?? [];
  const index = config.widgets.findIndex((w) => w.id === instance.id);
  const placement: DockMenuItem[] = [];
  if (index > 0) placement.push({ label: "Mover para a esquerda", icon: "chevron-left", onSelect: () => moveWidget(instance.id, -1) });
  if (index >= 0 && index < config.widgets.length - 1)
    placement.push({ label: "Mover para a direita", icon: "chevron-right", onSelect: () => moveWidget(instance.id, 1) });
  showDockMenu({
    title: definition.name,
    subtitle: definition.description,
    sections: [
      ...own,
      placement,
      [{ label: "Widgets e personalização…", icon: glyph.grid, onSelect: openGallery }],
      [{ label: "Remover do dock", icon: "x", danger: true, onSelect: () => removeWidget(instance.id) }],
    ],
  });
}
