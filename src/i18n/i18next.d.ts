import "i18next";
import type ptBR from "../locales/pt-BR/translation.json";

// Typed keys: t("settings.missing") is a compile error.
declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "translation";
    resources: { translation: typeof ptBR };
  }
}
