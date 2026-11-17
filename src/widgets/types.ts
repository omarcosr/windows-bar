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

/** Keys of C whose value is a V. */
type KeysOf<C, V> = { [K in keyof C]-?: C[K] extends V ? K : never }[keyof C] & string;

interface SettingBase<C> {
  label: string;
  description?: string;
  /** Shown only when this returns true (e.g. depends on another option). */
  when?(config: C): boolean;
}

/** One option of a widget, stored in its instance config under `key`. */
export type WidgetSetting<C extends object> =
  | (SettingBase<C> & { kind: "toggle"; key: KeysOf<C, boolean> })
  | (SettingBase<C> & { kind: "choice"; key: KeysOf<C, string>; options: readonly { value: string; label: string }[] })
  | (SettingBase<C> & { kind: "text"; key: KeysOf<C, string>; placeholder?: string; secret?: boolean });

export interface Ticker {
  /** Starts ticking (no-op while running); the first tick comes after `ms`. */
  start(): void;
  stop(): void;
  readonly running: boolean;
}

export interface WidgetContext<C extends object> {
  readonly instanceId: string;
  /** The instance's saved config (a store: edits re-render). Call save() after changing it. */
  readonly config: C;
  readonly app: AppHandle;
  save(): void;
  /** Runs fn now and then every ms while the widget is mounted. Errors are logged, not thrown. */
  every(ms: number, fn: () => unknown): void;
  /**
   * A timer that runs only between start() and stop() (and never after the widget is removed):
   * for clocks that tick only while something counts, so an idle widget wakes nothing.
   */
  ticker(ms: number, fn: () => unknown): Ticker;
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
  /** True while the widget has nothing to show: the dock leaves it out (except in edit mode). */
  hidden?(props: { state: S; ctx: WidgetContext<C> }): boolean;
  /**
   * The widget's own options, drawn for it: toggles and choices in its right-click menu, all of
   * them in the gallery under "Seu dock". Each edits `config[key]` and saves.
   */
  settings?: WidgetSetting<C>[];
}

export function defineWidget<C extends object, S extends object>(definition: WidgetDefinition<C, S>) {
  return definition as unknown as WidgetDefinition;
}
