import { store } from "@tarve/core";
import { config, newInstanceId, saveConfig } from "../config";
import { pruneWidgets } from "../widgets/host";
import { getWidget } from "../widgets/registry";
import { inDockGroup } from "../widgets/magnify";
import { DockWindow } from "../native/dock-window";

/** UI-only state shared by the dock and the gallery window. */
export const dockUi = store({
  editing: false,
  /** The dock has settled after starting (main.tsx): its first appearance fades and rises in. */
  shown: false,
  /** Auto-hide has put the dock away (dock/auto-hide.ts): it animates out, then its window is cloaked. */
  autoHidden: false,
});

/**
 * A widget being dragged to a new place (dock or gallery list), and the widget under it. `tile`:
 * the drag started on a clickable tile inside the widget (tileDragProps), whose node id is not the
 * widget's: drops then take the widget from `source`.
 */
export const widgetDrag = store({ source: "", over: "", tile: false });
export const WIDGET_DRAG = "widget:";

/** The widget a drag carries: from its own node's id, or the tile drag in progress. */
function draggedWidget(source: string, prefix: string): string | null {
  // First: a tile's node may be unnamed, and then its id derives from the slot's ("widget:<id>/children/0").
  if (prefix === WIDGET_DRAG && widgetDrag.tile && widgetDrag.source) return widgetDrag.source;
  if (!source.startsWith(prefix)) return null;
  const id = source.slice(prefix.length);
  return config.widgets.some((w) => w.id === id) ? id : null;
}

/**
 * Drag props for a clickable tile in the dock (widgets/ui.tsx Tile): a drag only starts from the
 * pressed node, and a widget's tile takes the press, so without these the widget moved only while
 * the widgets window covered it (edit mode). The widget is the one whose slot is under the pointer.
 * A plain click stays a click: a press becomes a drag only past 4 px.
 */
export function tileDragProps() {
  return {
    draggable: true,
    onDragStart: (at: { x: number; y: number }) => {
      const node = DockWindow.nodeAt(config.widgets.map((w) => WIDGET_DRAG + w.id), at.x, at.y);
      const hit = node ? node.slice(WIDGET_DRAG.length) : null;
      if (!hit || inDockGroup(hit)) return;
      widgetDrag.source = hit;
      widgetDrag.tile = true;
    },
    onDragEnd: () => {
      widgetDrag.source = "";
      widgetDrag.over = "";
      widgetDrag.tile = false;
    },
  };
}

/** Puts widget `id` where `targetId` is: after it when moving right, before it when moving left. */
export function moveWidgetTo(id: string, targetId: string) {
  if (id === targetId) return;
  const from = config.widgets.findIndex((w) => w.id === id);
  const to = config.widgets.findIndex((w) => w.id === targetId);
  if (from < 0 || to < 0) return;
  const [item] = config.widgets.splice(from, 1);
  config.widgets.splice(to, 0, item!);
  saveConfig();
}

/** Drag-and-drop props for one widget in a reorderable list (the dock, or the gallery's with its own prefix). */
export function widgetDragProps(id: string, prefix = WIDGET_DRAG) {
  return {
    id: prefix + id,
    draggable: true,
    dropTarget: true,
    onDragStart: () => {
      widgetDrag.source = id;
    },
    onDragEnter: (source: string) => {
      if (draggedWidget(source, prefix)) widgetDrag.over = id;
    },
    onDragLeave: () => {
      if (widgetDrag.over === id) widgetDrag.over = "";
    },
    onDrop: (event: { source: string }) => {
      const dragged = draggedWidget(event.source, prefix);
      if (dragged) moveWidgetTo(dragged, id);
    },
    onDragEnd: () => {
      widgetDrag.source = "";
      widgetDrag.over = "";
    },
  };
}

/** Which side of widget `id` the dragged one will land on, or null when it is not the drop target. */
export function dropSide(id: string): "left" | "right" | null {
  if (!widgetDrag.source || widgetDrag.over !== id || widgetDrag.source === id) return null;
  const from = config.widgets.findIndex((w) => w.id === widgetDrag.source);
  const to = config.widgets.findIndex((w) => w.id === id);
  return from < to ? "right" : "left";
}

export function addWidget(type: string) {
  const definition = getWidget(type);
  if (!definition) return;
  config.widgets.push({ id: newInstanceId(type), type, config: structuredClone(definition.defaultConfig) as Record<string, unknown> });
  saveConfig();
}

export function removeWidget(id: string) {
  const index = config.widgets.findIndex((w) => w.id === id);
  if (index < 0) return;
  config.widgets.splice(index, 1);
  pruneWidgets(config.widgets.map((w) => w.id));
  saveConfig();
}

export function moveWidget(id: string, delta: number) {
  const index = config.widgets.findIndex((w) => w.id === id);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= config.widgets.length) return;
  const [item] = config.widgets.splice(index, 1);
  config.widgets.splice(target, 0, item!);
  saveConfig();
}
/**
 * Puts widget `id` on one side of the Start + Apps group, right beside it: dropped on the empty
 * part of a side of the full bar, where no widget is there to drop it on. With no group, at the end.
 */
export function moveWidgetToSide(id: string, side: "before" | "after") {
  const from = config.widgets.findIndex((w) => w.id === id);
  if (from < 0) return;
  const [item] = config.widgets.splice(from, 1);
  const group = config.widgets.flatMap((w, i) => (inDockGroup(w.id, config.widgets) ? [i] : []));
  const at = !group.length ? config.widgets.length : side === "before" ? group[0]! : group[group.length - 1]! + 1;
  config.widgets.splice(at, 0, item!);
  if (at !== from) saveConfig();
}
/** Drop-target props for an empty side of the full bar (`side:before` / `side:after` in widgetDrag.over). */
export function sideDropProps(side: "before" | "after") {
  const key = `side:${side}`;
  return {
    dropTarget: true,
    onDragEnter: (source: string) => {
      if (draggedWidget(source, WIDGET_DRAG)) widgetDrag.over = key;
    },
    onDragLeave: () => {
      if (widgetDrag.over === key) widgetDrag.over = "";
    },
    onDrop: (event: { source: string }) => {
      if (widgetDrag.over === key) widgetDrag.over = "";
      const dragged = draggedWidget(event.source, WIDGET_DRAG);
      if (dragged) moveWidgetToSide(dragged, side);
    },
  };
}
