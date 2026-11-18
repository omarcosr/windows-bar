import { store } from "@tarve/core";
import type { DockMenuItem } from "../menu/dock-menu";
import type { MountedWidget } from "./host";
import type { WidgetContext, WidgetSetting } from "./types";

type AnySetting = WidgetSetting<Record<string, unknown>>;

/** Which placed widget has its options open in the gallery. */
export const widgetSettings = store({ editing: null as string | null });

export function editWidgetSettings(id: string | null) {
  widgetSettings.editing = id;
}

/** The settings that apply to this config right now. */
export function activeSettings(settings: readonly AnySetting[] | undefined, config: Record<string, unknown>) {
  return (settings ?? []).filter((s) => !s.when || s.when(config));
}

export function setSetting(ctx: WidgetContext<Record<string, unknown>>, key: string, value: unknown) {
  ctx.config[key] = value;
  ctx.save();
}

/**
 * Menu sections for a widget's options: toggles together, then a section per short choice. Long
 * choices (currencies, cities, intervals), choices past the first few and text options are left to
 * the settings dialog, as Windows keeps context menus short: a currency list of twenty "De: …" and
 * twenty "Para: …" rows ran the menu off the screen. `more` reports whether anything was left out.
 */
export function settingsMenu(widget: MountedWidget): { sections: DockMenuItem[][]; more: boolean } {
  const { ctx } = widget;
  const settings = activeSettings(widget.definition.settings as AnySetting[] | undefined, ctx.config);
  const toggles: DockMenuItem[] = [];
  const sections: DockMenuItem[][] = [];
  let more = false;
  for (const s of settings) {
    if (s.kind === "toggle") {
      const on = ctx.config[s.key] === true;
      toggles.push({ label: s.label, icon: on ? "check" : undefined, onSelect: () => setSetting(ctx, s.key, !on) });
    } else if (s.kind === "choice" && s.options.length <= MENU_CHOICE_OPTIONS && sections.length < MENU_CHOICES) {
      sections.push(
        s.options.map((o) => ({
          label: `${s.label}: ${o.label}`,
          icon: ctx.config[s.key] === o.value ? "check" : undefined,
          onSelect: () => setSetting(ctx, s.key, o.value),
        })),
      );
    } else more = true;
  }
  if (toggles.length) sections.unshift(toggles);
  return { sections, more };
}
/** A choice goes in the menu only with this many options or fewer… */
const MENU_CHOICE_OPTIONS = 4;
/** …and only this many choices: the rest are in the settings dialog. */
const MENU_CHOICES = 2;
