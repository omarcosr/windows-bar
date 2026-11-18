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

const label = (placeholder: string) => ({ kind: "text" as const, key: "label" as const, label: "Título", placeholder });
const env = [
  { value: "live", label: "Produção" },
  { value: "test", label: "Teste (sandbox)" },
] as const;

export const stripeChart = revenueWidget({
  type: "finance-stripe",
  name: "Stripe (gráfico)",
  description: "Receita do Stripe no período escolhido, com gráfico diário e variação.",
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
      label: "Chave restrita",
      description: "Permissão de leitura em Balance (rk_live_…). Vazia mostra dados de exemplo.",
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
  description: "Receita da Polar (API de métricas) no período escolhido, com gráfico diário.",
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
      label: "Token da organização",
      description: "Organization Access Token com escopo metrics:read. Vazio mostra dados de exemplo.",
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
  description: "Receita dos pedidos do Lemon Squeezy no período (líquida: sem impostos e reembolsos).",
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
      label: "Chave de API",
      description: "Settings › API. Vazia mostra dados de exemplo.",
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
  description: "Ganhos do Paddle Billing no período (líquido: após impostos e taxa), na moeda de repasse.",
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
      label: "Chave de API",
      description: "Developer tools › Authentication, com permissão transaction.read. Vazia mostra dados de exemplo.",
      placeholder: "pdl_live_apikey_…",
      secret: true,
    },
    { kind: "choice", key: "env", label: "Ambiente", options: env },
  ],
  gross: true,
  load: (c, days) => (c.key ? paddleRevenue(c.key, c.env === "test" || c.key.startsWith("pdl_sdbx"), days) : null),
});

export const gumroad = revenueWidget({
  type: "finance-gumroad",
  name: "Gumroad",
  description: "Vendas do Gumroad no período (líquido: descontada a taxa da plataforma).",
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
      description: "Settings › Advanced › Applications, escopo view_sales. Vazio mostra dados de exemplo.",
      secret: true,
    },
  ],
  gross: true,
  load: (c, days) => (c.key ? gumroadRevenue(c.key, days) : null),
});

export const shopify = revenueWidget({
  type: "finance-shopify",
  name: "Shopify",
  description: "Vendas da loja Shopify no período via Admin API (líquido: sem impostos, após reembolsos).",
  brand: { color: "#5e8e3e", letter: "S" },
  logo: "shopify",
  dashboard: "https://admin.shopify.com",
  cacheKey: "shopify:",
  defaultConfig: { label: "Shopify", domain: "", key: "" },
  settings: [
    label("Shopify"),
    { kind: "text", key: "domain", label: "Domínio da loja", placeholder: "minhaloja.myshopify.com" },
    {
      kind: "text",
      key: "key",
      label: "Token da Admin API",
      description: "App personalizado com escopo read_orders. Vazio mostra dados de exemplo.",
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
  description: "Pagamentos concluídos da Dodo Payments no período, com gráfico diário.",
  brand: { color: "#111827", letter: "D" },
  dashboard: "https://app.dodopayments.com",
  cacheKey: "dodo:",
  defaultConfig: { label: "Dodo", key: "", env: "live" },
  settings: [
    label("Dodo"),
    { kind: "text", key: "key", label: "Chave de API", description: "Vazia mostra dados de exemplo.", secret: true },
    { kind: "choice", key: "env", label: "Ambiente", options: env },
  ],
  load: (c, days) => (c.key ? dodoRevenue(c.key, c.env === "test", days) : null),
});
