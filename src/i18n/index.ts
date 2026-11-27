import i18next from "i18next";
import { config } from "../config";
import { windowsDisplayIsPortuguese } from "../native/locale-format";
import enUS from "../locales/en-US/translation.json" with { type: "json" };
import ptBR from "../locales/pt-BR/translation.json" with { type: "json" };

/**
 * UI strings through i18next: one JSON resource per language under src/locales, keys namespaced by
 * module (`settings.appearance`), `{{name}}` interpolation and `count` plurals (`key_one` / `key_other`).
 * pt-BR is the default and the fallback for any key missing in another language.
 *
 * The language is fixed for the whole run (widget names, menus and option lists are built once at
 * load): a change in Settings applies on the next start.
 */
export type Language = "pt-BR" | "en-US";

function resolve(setting: typeof config.language): Language {
  if (setting === "en-US" || setting === "pt-BR") return setting;
  try {
    return windowsDisplayIsPortuguese() ? "pt-BR" : "en-US";
  } catch {
    return "pt-BR";
  }
}

/** The language of this run; also the BCP 47 tag for Intl formatters and toLocaleString. */
export const language: Language = resolve(config.language);

// Synchronous init: widget definitions call t() while their modules load.
void i18next.init({
  lng: language,
  fallbackLng: "pt-BR",
  supportedLngs: ["pt-BR", "en-US"],
  resources: { "pt-BR": { translation: ptBR }, "en-US": { translation: enUS } },
  initAsync: false,
  // Text is drawn by the renderer, not inserted as HTML.
  interpolation: { escapeValue: false },
});

export const t = i18next.t;

const decimalFormats = new Map<number, Intl.NumberFormat>();
/** A number with exactly `digits` decimals in the UI language ("12,5" / "12.5"); one formatter per digit count. */
export function formatDecimal(value: number, digits: number): string {
  let format = decimalFormats.get(digits);
  if (!format) decimalFormats.set(digits, (format = new Intl.NumberFormat(language, { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false })));
  return format.format(value);
}

/** The language the saved setting asks for differs from the running one: a restart applies it. */
export const languagePending = () => resolve(config.language) !== language;

let restarter: (() => void) | undefined;
/** main.tsx provides the restart (start a new dock, then close this one). */
export function setRestarter(fn: () => void) {
  restarter = fn;
}
export function restartApp() {
  restarter?.();
}
