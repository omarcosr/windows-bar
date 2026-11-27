import {
  dodoRevenue,
  gumroadRevenue,
  lemonRevenue,
  paddleRevenue,
  polarRevenue,
  shopifyRevenue,
  stripeRevenue,
} from "../../../services/finance-providers";
import { revenueWidget } from "./shared";

import { t } from "../../../i18n";
const label = (placeholder: string) => ({ kind: "text" as const, key: "label" as const, label: t("widgets.finance.providers.title"), placeholder });
const env = [
  { value: "live", label: t("widgets.finance.providers.production") },
  { value: "test", label: "Teste (sandbox)" },
] as const;

export const stripeChart = revenueWidget({
  type: "finance-stripe",
  name: t("widgets.finance.providers.stripeChart"),
  description: t("widgets.finance.providers.stripeRevenueInChosen"),
  brand: { color: "#635bff", letter: "S" },
  logo: "stripe",
  dashboard: "https://dashboard.stripe.com",
  cacheKey: "stripe:",
  defaultConfig: { label: "Stripe", key: "" },
  settings: [
    label("Stripe"),
    {
      kind: "text",
      key: "key",
      label: t("widgets.finance.providers.restrictedKey"),
      description: t("widgets.finance.providers.readPermissionOnBalance"),
      placeholder: "rk_live_…",
      secret: true,
    },
  ],
  gross: true,
  load: (c, days) => (c.key ? stripeRevenue(c.key, days) : null),
});

export const polar = revenueWidget({
  type: "finance-polar",
  name: "Polar",
  description: t("widgets.finance.providers.polarRevenueMetricsApi"),
  brand: { color: "#0062ff", letter: "P" },
  dashboard: "https://polar.sh/dashboard",
  cacheKey: "polar:",
  chart: "line",
  defaultConfig: { label: "Polar", key: "" },
  settings: [
    label("Polar"),
    {
      kind: "text",
      key: "key",
      label: t("widgets.finance.providers.organizationToken"),
      description: t("widgets.finance.providers.organizationAccessTokenWith"),
      placeholder: "polar_oat_…",
      secret: true,
    },
  ],
  gross: true,
  load: (c, days) => (c.key ? polarRevenue(c.key, days) : null),
});

export const lemon = revenueWidget({
  type: "finance-lemonsqueezy",
  name: "Lemon Squeezy",
  description: t("widgets.finance.providers.lemonSqueezyOrderRevenue"),
  brand: { color: "#ffc233", letter: "L" },
  logo: "lemonsqueezy",
  dashboard: "https://app.lemonsqueezy.com/dashboard",
  cacheKey: "lemon:",
  defaultConfig: { label: "Lemon Squeezy", key: "" },
  settings: [
    label("Lemon Squeezy"),
    {
      kind: "text",
      key: "key",
      label: t("widgets.finance.providers.apiKey"),
      description: t("widgets.finance.providers.settingsApiEmptyShows"),
      placeholder: "eyJ0eXAiOiJKV1Qi…",
      secret: true,
    },
  ],
  gross: true,
  load: (c, days) => (c.key ? lemonRevenue(c.key, days) : null),
});

export const paddle = revenueWidget({
  type: "finance-paddle",
  name: "Paddle Billing",
  description: t("widgets.finance.providers.paddleBillingEarningsIn"),
  brand: { color: "#1d1d1f", letter: "P" },
  logo: "paddle",
  dashboard: "https://vendors.paddle.com",
  cacheKey: "paddle:",
  defaultConfig: { label: "Paddle", key: "", env: "live" },
  settings: [
    label("Paddle"),
    {
      kind: "text",
      key: "key",
      label: t("widgets.finance.providers.apiKey"),
      description: t("widgets.finance.providers.developerToolsAuthenticationWith"),
      placeholder: "pdl_live_apikey_…",
      secret: true,
    },
    { kind: "choice", key: "env", label: t("widgets.finance.providers.environment"), options: env },
  ],
  gross: true,
  load: (c, days) => (c.key ? paddleRevenue(c.key, c.env === "test" || c.key.startsWith("pdl_sdbx"), days) : null),
});

export const gumroad = revenueWidget({
  type: "finance-gumroad",
  name: "Gumroad",
  description: t("widgets.finance.providers.gumroadSalesInPeriod"),
  brand: { color: "#ff90e8", letter: "G" },
  logo: "gumroad",
  dashboard: "https://app.gumroad.com/dashboard",
  cacheKey: "gumroad:",
  defaultConfig: { label: "Gumroad", key: "" },
  settings: [
    label("Gumroad"),
    {
      kind: "text",
      key: "key",
      label: "Access token",
      description: t("widgets.finance.providers.settingsAdvancedApplicationsView"),
      secret: true,
    },
  ],
  gross: true,
  load: (c, days) => (c.key ? gumroadRevenue(c.key, days) : null),
});

export const shopify = revenueWidget({
  type: "finance-shopify",
  name: "Shopify",
  description: t("widgets.finance.providers.shopifyStoreSalesIn"),
  brand: { color: "#5e8e3e", letter: "S" },
  logo: "shopify",
  dashboard: "https://admin.shopify.com",
  cacheKey: "shopify:",
  defaultConfig: { label: "Shopify", domain: "", key: "" },
  settings: [
    label("Shopify"),
    { kind: "text", key: "domain", label: t("widgets.finance.providers.storeDomain"), placeholder: t("widgets.finance.providers.mystoreMyshopifyCom") },
    {
      kind: "text",
      key: "key",
      label: t("widgets.finance.providers.adminApiToken"),
      description: t("widgets.finance.providers.customAppWithRead"),
      placeholder: "shpat_…",
      secret: true,
    },
  ],
  gross: true,
  load: (c, days) => (c.key && c.domain ? shopifyRevenue(c.domain, c.key, days) : null),
});

export const dodo = revenueWidget({
  type: "finance-dodo",
  name: "Dodo Payments",
  description: t("widgets.finance.providers.completedDodoPaymentsPayments"),
  brand: { color: "#111827", letter: "D" },
  dashboard: "https://app.dodopayments.com",
  cacheKey: "dodo:",
  defaultConfig: { label: "Dodo", key: "", env: "live" },
  settings: [
    label("Dodo"),
    { kind: "text", key: "key", label: t("widgets.finance.providers.apiKey"), description: t("widgets.finance.providers.emptyShowsSampleData"), secret: true },
    { kind: "choice", key: "env", label: t("widgets.finance.providers.environment"), options: env },
  ],
  load: (c, days) => (c.key ? dodoRevenue(c.key, c.env === "test", days) : null),
});
