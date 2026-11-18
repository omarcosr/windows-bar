import { Column, Row, Text, View, store, toRaw } from "@tarve/core";
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
import { FluentGlyph } from "../../../menu/dock-menu";
import { defineWidget, type WidgetSetting } from "../../types";
import {
  Badge,
  BadgeRows,
  TITLE_ROW,
  TileTitle,
  chartClick,
  chartMenu,
  chartRow,
  oneRow,
  Trend,
  demoDaily,
  poll,
  refreshItem,
  refreshers,
  revenueDefaults,
  revenueSettings,
  revenueSource,
  revenueTip,
  tileAnchor,
  type RevenueOptions,
} from "./shared";
import { asCompareTo } from "../../../services/finance-providers";

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

/** Every provider's `days` summed in the display currency; `failed` names the ones that could not be read. */
async function totalDaily(c: Config, days: number) {
  const list = sources(c, days);
  const target = displayCurrency(c);
  if (list.length === 0) return { daily: demoDaily(260, 3, days), currency: target, demo: true, failed: [] as string[], error: undefined as unknown, count: 0 };
  const results = await Promise.allSettled(
    list.map(async ([, fetch]) => {
      const r = await fetch();
      const rate = await fxRate(r.currency, target);
      return r.daily.map((v) => v * rate);
    }),
  );
  const daily = new Array<number>(days).fill(0);
  const failed: string[] = [];
  let error: unknown;
  results.forEach((r, i) => {
    if (r.status === "fulfilled") r.value.forEach((v, d) => (daily[d]! += v));
    else {
      failed.push(list[i]![0]);
      error ??= r.reason;
    }
  });
  return { daily, currency: target, demo: false, failed, error, count: list.length };
}

function totalSource(ctx: { instanceId: string; config: Config; save(): void }) {
  const c = ctx.config;
  return revenueSource({
    key: ctx.instanceId,
    anchor: tileAnchor(ctx),
    title: String(c.label || "Receita total"),
    brand: { color: ui.green, letter: "$" },
    source: sources(c, 31).length ? `soma de ${sources(c, 31).map(([n]) => n).join(", ")}` : "nenhum provedor com chave",
    config: c,
    save: () => ctx.save(),
    loadDaily: async (days) => {
      const r = await totalDaily(c, days);
      if (r.count && r.failed.length === r.count) throw r.error;
      return r;
    },
  });
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
    /** Every provider failed (one failing among others still shows the rest): the refresh backs off. */
    let allFailed = false;
    const load = async () => {
      const id = ++seq;
      const c = ctx.config;
      const r = await totalDaily(c, historyDays(asPeriod(c.period), c.compare !== false && asCompareTo(c.compareTo)));
      if (id !== seq) return;
      allFailed = r.count > 0 && r.failed.length === r.count;
      if (allFailed) {
        state.error = errorText(r.error);
        state.failed = r.failed;
          return;
      }
      Object.assign(state, { daily: r.daily, demo: r.demo, error: r.failed.length ? `${r.failed.length} falhou` : "", failed: r.failed });
      };
    refreshers.set(toRaw(state), () => {
      invalidate();
      return load();
    });
    poll(ctx, load, 15, { failed: () => allFailed });
    return state;
  },
  menu({ state, ctx }) {
    const failed = state.failed.map((name) => ({ label: `${name}: falha ao ler`, danger: true, onSelect: () => {} }));
    const first = [refreshItem(state), ...chartMenu(() => totalSource(ctx))];
      return failed.length ? [first, failed] : [first];
  },
  View({ state, ctx, preview }) {
    const c = ctx.config;
    const currency = displayCurrency(c);
    const format = c.format === "full" ? "full" : "compact";
    const goal = state.demo && !c.goal ? 8000 : Number(String(c.goal).replace(/[^\d.]/g, "")) || 0;
    const mtd = monthToDate(state.daily);
    const now = new Date();
    const monthDays = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const expected = goal * ((now.getDate() - 1 + now.getHours() / 24) / monthDays);
    const ahead = mtd >= expected;
    const label = String(c.label || "Receita total");
    const tip = () => {
      const names = sources(c, 31).map(([name]) => name);
      const source = names.length ? `soma de ${names.join(", ")}, convertida para ${currency} pelo câmbio do dia` : "nenhum provedor com chave";
      if (!goal) return revenueTip({ label, daily: state.daily, currency, config: c, source, demo: state.demo, error: state.error, click: "Clique para abrir o gráfico" });
      return [
        `${label}: ${money(mtd, currency, format)} no mês atual (desde o dia 1º)`,
        `Meta do mês: ${money(goal, currency, format)} · ${Math.round((mtd / goal) * 100)}% atingido`,
        `${ahead ? "No ritmo" : "Abaixo do ritmo"}: até agora o esperado era ${money(expected, currency, format)} (meta × fração do mês já passada)`,
        ...(state.failed.length ? [`Falha ao ler: ${state.failed.join(", ")}`] : []),
        state.demo ? "Dados de exemplo: informe as chaves nas configurações" : `Fonte: ${source}`,
          "Clique para abrir o gráfico",
      ];
    };
    return (
      <Tile
        icon={<FluentGlyph code={0xe8c7} size={ui.app.icon - 4} color={ui.green} />}
        value={money(goal ? mtd : periodSum(state.daily, asPeriod(c.period)), currency, "compact")}
        width={oneRow() ? 196 : 210}
        lead={oneRow() ? undefined : "round"}
        onClick={preview ? undefined : chartClick("panel", undefined, () => totalSource(ctx))}
        tip={{ id: tileAnchor(ctx), lines: tip }}
        preview={preview}
      >
        <BadgeRows color={ui.green} letter="$">
          <Row style={{ align: "center", gap: 6, height: TITLE_ROW }}>
            {oneRow() ? <Badge color={ui.green} letter="$" /> : null}
            <TileTitle text={label} demo={state.demo} error={state.error} />
            <Text size={12} weight={700} color={ui.text} style={numeric}>
              {money(goal ? mtd : periodSum(state.daily, asPeriod(c.period)), currency, format)}
            </Text>
          </Row>
          {oneRow() ? null : goal ? (
            <Row style={{ align: "center", gap: 6, height: chartRow() }}>
              <Meter value={mtd / goal} width={96} color={ahead ? ui.green : ui.orange} />
              <View style={{ flex: 1, align: "end" }}>
                <Text size={10} weight={700} color={ahead ? ui.green : ui.orange} style={numeric}>
                  {`${Math.round((mtd / goal) * 100)}% ${ahead ? "no ritmo" : "abaixo"}`}
                </Text>
              </View>
            </Row>
          ) : (
            <Trend daily={state.daily} config={c} width={112} />
          )}
        </BadgeRows>
      </Tile>
    );
  },
});

/** The display (and goal) currency; old text configs may hold "original" or lowercase codes. */
function displayCurrency(c: Pick<RevenueOptions, "currency">) {
  const code = String(c.currency || "").toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : "USD";
}
