import { config } from "../config";
import { glyph, showDockMenu, type DockMenuItem } from "../menu/dock-menu";
import type { MountedWidget } from "../widgets/host";
import { moveWidget, removeWidget } from "./state";
import { editWidgetSettings, settingsMenu } from "../widgets/settings";

let openGallery: () => void = () => {};

/** main.tsx hands over how to open the widget gallery. */
export function setGalleryOpener(open: () => void) {
  openGallery = open;
}

/** Opens the gallery with this widget's settings popup. */
export function openWidgetSettings(id: string) {
  editWidgetSettings(id);
  openGallery();
}

/** Right-click on a widget: its own actions first, then moving and removing it. */
export function openWidgetMenu(widget: MountedWidget) {
    const { definition, instance } = widget;
      const own = definition.menu?.({ state: widget.state, ctx: widget.ctx }) ?? [];
      const options = settingsMenu(widget);
      const index = config.widgets.findIndex((w) => w.id === instance.id);
      const placement: DockMenuItem[] = [];
      if (index > 0) placement.push({ label: "Mover para a esquerda", icon: "chevron-left", onSelect: () => moveWidget(instance.id, -1) });
      if (index >= 0 && index < config.widgets.length - 1)
        placement.push({ label: "Mover para a direita", icon: "chevron-right", onSelect: () => moveWidget(instance.id, 1) });
      const configure: DockMenuItem = definition.settings?.length
        ? {
            label: options.more ? "Configurações do widget…" : "Todas as configurações do widget…",
            icon: glyph.settings,
            onSelect: () => openWidgetSettings(instance.id),
          }
        : { label: "Widgets e personalização…", icon: glyph.grid, onSelect: openGallery };
      showDockMenu({
        title: definition.name,
        subtitle: definition.description,
        sections: [
          ...own,
          ...options.sections,
          placement,
          [configure],
          [{ label: "Remover do dock", icon: "x", danger: true, onSelect: () => removeWidget(instance.id) }],
        ],
      });
}
