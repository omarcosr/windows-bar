import { store } from "@tarve/core";
import { config, newInstanceId, saveConfig } from "../config";
import { pruneWidgets } from "../widgets/host";
import { getWidget } from "../widgets/registry";

/** UI-only state shared by the dock and the gallery window. */
export const dockUi = store({
  editing: false,
});

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
