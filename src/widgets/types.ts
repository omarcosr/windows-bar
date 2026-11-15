import type { AppHandle, VNode } from "@tarve/core";
import type { DockMenuItem } from "../menu/dock-menu";

export type WidgetCategory = "clock" | "apps" | "system" | "media" | "finance" | "productivity";

export const categoryLabels: Record<WidgetCategory, string> = {
  clock: "Relógio e clima",
  apps: "Apps",
  system: "Sistema",
  media: "Mídia",
  finance: "Finanças",
  productivity: "Produtividade",
};

export interface WidgetContext<C extends object> {
  readonly instanceId: string;
  /** The instance's saved config (a store: edits re-render). Call save() after changing it. */
  readonly config: C;
  readonly app: AppHandle;
  save(): void;
  /** Runs fn now and then every ms while the widget is mounted. Errors are logged, not thrown. */
  every(ms: number, fn: () => unknown): void;
  onDispose(fn: () => void): void;
}

export interface WidgetViewProps<C extends object, S extends object> {
  state: S;
  ctx: WidgetContext<C>;
  /** Rendered inside the widget gallery rather than the dock. */
  preview: boolean;
}

/**
 * A widget type. `setup` runs once per placed instance and returns its state (make it a
 * `store` so changes re-render); `View` draws the tile from that state.
 */
export interface WidgetDefinition<C extends object = Record<string, unknown>, S extends object = object> {
  type: string;
  name: string;
  description: string;
  category: WidgetCategory;
  defaultConfig: C;
  setup(ctx: WidgetContext<C>): S;
  View(props: WidgetViewProps<C, S>): VNode;
  /**
   * The widget's own entries for its right-click menu, in sections. The dock appends the
   * common ones (move, widgets, remove).
   */
  menu?(props: { state: S; ctx: WidgetContext<C> }): DockMenuItem[][];
}

export function defineWidget<C extends object, S extends object>(definition: WidgetDefinition<C, S>) {
  return definition as unknown as WidgetDefinition;
}
