import type { WidgetDefinition } from "./types";

const registry = new Map<string, WidgetDefinition>();

export function registerWidget(definition: WidgetDefinition) {
  if (registry.has(definition.type)) throw new Error(`widget type "${definition.type}" registered twice`);
  registry.set(definition.type, definition);
}

export function getWidget(type: string) {
  return registry.get(type);
}

export function allWidgets() {
  return [...registry.values()];
}
