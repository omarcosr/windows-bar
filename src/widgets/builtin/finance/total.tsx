import { Column, Row, Text, store, toRaw } from "@tarve/core";
import {
  asPeriod,
  dodoRevenue,
  errorText,
  fxRate,
  gumroadRevenue,
  historyDays,
  invalidate,
  lemonRevenue,
  money,
  monthToDate,
  paddleRevenue,
  periodSum,
  polarRevenue,
  shopifyRevenue,
  stripeRevenue,
  type Revenue,
} from "../../../services/finance-providers";
import { numeric, ui } from "../../../theme";
import { Meter, Tile } from "../../ui";
import { defineWidget, type WidgetSetting } from "../../types";
import { Badge, Status, Trend, demoDaily, poll, refreshItem, refreshers, revenueDefaults, revenueSettings, type RevenueOptions } from "./shared";

const defaults = {
  label: "Receita total",
  ...revenueDefaults,
  currency: "USD",
  goal: "",
  stripe: "",
  polar: "",
  lemon: "",
  paddle: "",
  gumroad: "",
  shopifyDomain: "",
  shopify: "",
  dodo: "",
  useStripe: true,
  usePolar: true,
  useLemon: true,
  usePaddle: true,
  useGumroad: true,
  useShopify: true,
  useDodo: true,
};
type Config = typeof defaults;

/** The providers with credentials that are switched on, each loading `days` of history. */
function sources(c: Config, days: number): [string, () => Promise<Revenue>][] {
  const out: [string, () => Promise<Revenue>][] = [];
  const on = (flag: boolean | undefined) => flag !== false;
  if (c.stripe && on(c.useStripe)) out.push(["Stripe", () => stripeRevenue(c.stripe, days)]);
  if (c.polar && on(c.usePolar)) out.push(["Polar", () => polarRevenue(c.polar, days)]);
  if (c.lemon && on(c.useLemon)) out.push(["Lemon Squeezy", () => lemonRevenue(c.lemon, days)]);
  if (c.paddle && on(c.usePaddle)) out.push(["Paddle", () => paddleRevenue(c.paddle, c.paddle.startsWith("pdl_sdbx"), days)]);
  if (c.gumroad && on(c.useGumroad)) out.push(["Gumroad", () => gumroadRevenue(c.gumroad, days)]);
  if (c.shopify && c.shopifyDomain && on(c.useShopify)) out.push(["Shopify", () => shopifyRevenue(c.shopifyDomain, c.shopify, days)]);
  if (c.dodo && on(c.useDodo)) out.push(["Dodo", () => dodoRevenue(c.dodo, false, days)]);
  return out;
}

const secret = (key: keyof Config & string, label: string, placeholder?: string) => ({
  kind: "text" as const,
  key: key as "stripe",
  label,
  placeholder,
  secret: true,
});

/** "Contar X", shown once X has a key. */
const count = (key: keyof Config & string, label: string, has: (c: Config) => boolean): WidgetSetting<Config> => ({
  kind: "toggle",
  key: key as "useStripe",
  label: `Contar ${label}`,
  when: has,
});

export default defineWidget<Config, { daily: number[]; demo: boolean; error: string; failed: string[] }>({
  type: "finance-total",
  name: "Receita total",
  description: "Soma a receita do período de todos os provedores escolhidos, na moeda escolhida, com meta mensal e ritmo.",
  category: "finance",
  defaultConfig: defaults,
  settings: [
    { kind: "text", key: "label", label: "Título", placeholder: "Receita total" },
    ...(revenueSettings({ original: false, gross: false }) as unknown as WidgetSetting<Config>[]),
    { kind: "text", key: "goal", label: "Meta mensal", description: "Valor na moeda de exibição. Vazia esconde a barra de ritmo.", placeholder: "10000" },
    secret("stripe", "Stripe: chave restrita", "rk_live_…"),
    secret("polar", "Polar: token da organização", "polar_oat_…"),
    secret("lemon", "Lemon Squeezy: chave de API"),
    secret("paddle", "Paddle: chave de API", "pdl_live_apikey_…"),
    secret("gumroad", "Gumroad: access token"),
    { kind: "text", key: "shopifyDomain", label: "Shopify: domínio", placeholder: "minhaloja.myshopify.com" },
    secret("shopify", "Shopify: token da Admin API", "shpat_…"),
    secret("dodo", "Dodo Payments: chave de API"),
    count("useStripe", "Stripe", (c) => !!c.stripe),
    count("usePolar", "Polar", (c) => !!c.polar),
    count("useLemon", "Lemon Squeezy", (c) => !!c.lemon),
    count("usePaddle", "Paddle", (c) => !!c.paddle),
    count("useGumroad", "Gumroad", (c) => !!c.gumroad),
    count("useShopify", "Shopify", (c) => !!(c.shopify && c.shopifyDomain)),
    count("useDodo", "Dodo Payments", (c) => !!c.dodo),
  ],
  setup(ctx) {
    const state = store({ daily: demoDaily(260, 3), demo: true, error: "", failed: [] as string[] });
    let seq = 0;
    const load = async () => {
      const id = ++seq;
      const c = ctx.config;
      const days = historyDays(asPeriod(c.period), c.compare !== false);
      const list = sources(c, days);
      if (list.length === 0) {
        Object.assign(state, { daily: demoDaily(260, 3), demo: true, error: "", failed: [] });
        return;
      }
      const target = displayCurrency(c);
      const results = await Promise.allSettled(
        list.map(async ([, fetch]) => {
          const r = await fetch();
          const rate = await fxRate(r.currency, target);
          return r.daily.map((v) => v * rate);
        }),
      );
      if (id !== seq) return;
      const daily = new Array<number>(days).fill(0);
      const failed: string[] = [];
      let firstError: unknown;
      results.forEach((r, i) => {
        if (r.status === "fulfilled") r.value.forEach((v, d) => (daily[d]! += v));
        else {
          failed.push(list[i]![0]);
          firstError ??= r.reason;
        }
      });
      if (failed.length === list.length) {
        state.error = errorText(firstError);
        state.failed = failed;
        return;
      }
      Object.assign(state, { daily, demo: false, error: failed.length ? `${failed.length} falhou` : "", failed });
    };
    refreshers.set(toRaw(state), () => {
      invalidate();
      return load();
    });
    poll(ctx, load, 15);
    return state;
  },
  menu({ state }) {
    const failed = state.failed.map((name) => ({ label: `${name}: falha ao ler`, danger: true, onSelect: () => {} }));
    return failed.length ? [[refreshItem(state)], failed] : [[refreshItem(state)]];
  },
  View({ state, ctx }) {
    const c = ctx.config;
    const currency = displayCurrency(c);
    const format = c.format === "full" ? "full" : "compact";
    const goal = state.demo && !c.goal ? 8000 : Number(String(c.goal).replace(/[^\d.]/g, "")) || 0;
    const mtd = monthToDate(state.daily);
    const now = new Date();
    const monthDays = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const expected = goal * ((now.getDate() - 1 + now.getHours() / 24) / monthDays);
    const ahead = mtd >= expected;
    return (
      <Tile width={196} padding={{ left: 10, right: 10, top: 6, bottom: 4 }}>
        <Column style={{ flex: 1, gap: 3 }}>
          <Row style={{ align: "center", gap: 6 }}>
            <Badge color={ui.green} letter="$" />
            <Text size={11} weight={600} color={ui.text} style={{ flex: 1 }}>
              {String(c.label || "Receita total")}
              <Status demo={state.demo} error={state.error} />
            </Text>
            <Text size={12} weight={700} color={ui.text} style={numeric}>
              {money(goal ? mtd : periodSum(state.daily, asPeriod(c.period)), currency, format)}
            </Text>
          </Row>
          {goal ? (
            <Row style={{ align: "center", gap: 6 }}>
              <Meter value={mtd / goal} width={112} color={ahead ? ui.green : ui.orange} />
              <Text size={10} weight={700} color={ahead ? ui.green : ui.orange} style={{ ...numeric, flex: 1, textAlign: "right" }}>
                {`${Math.round((mtd / goal) * 100)}% ${ahead ? "no ritmo" : "abaixo"}`}
              </Text>
            </Row>
          ) : (
            <Trend daily={state.daily} config={c} />
          )}
        </Column>
      </Tile>
    );
  },
});

/** The display (and goal) currency; old text configs may hold "original" or lowercase codes. */
function displayCurrency(c: Pick<RevenueOptions, "currency">) {
  const code = String(c.currency || "").toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : "USD";
}
