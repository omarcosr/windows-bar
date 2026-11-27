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

import { t } from "../../../i18n";
const defaults = {
  label: t("widgets.finance.total.totalRevenue"),
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
    title: String(c.label || t("widgets.finance.total.totalRevenue")),
    brand: { color: ui.green, letter: "$" },
    source: sources(c, 31).length ? t("widgets.finance.total.sumOf", { p0: sources(c, 31).map(([n]) => n).join(", ") }) : t("widgets.finance.total.noProviderWithKey"),
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
  label: t("widgets.finance.total.count", { label }),
  when: has,
});

export default defineWidget<Config, { daily: number[]; demo: boolean; error: string; failed: string[] }>({
  type: "finance-total",
  name: t("widgets.finance.total.totalRevenue"),
  description: t("widgets.finance.total.sumsPeriodsRevenueFrom"),
  category: "finance",
  defaultConfig: defaults,
  settings: [
    { kind: "text", key: "label", label: t("widgets.finance.total.title"), placeholder: t("widgets.finance.total.totalRevenue") },
    ...(revenueSettings({ original: false, gross: false }) as unknown as WidgetSetting<Config>[]),
    { kind: "text", key: "goal", label: t("widgets.finance.total.monthlyGoal"), description: t("widgets.finance.total.amountInDisplayCurrency"), placeholder: "10000" },
    secret("stripe", t("widgets.finance.total.stripeRestrictedKey"), "rk_live_…"),
    secret("polar", t("widgets.finance.total.polarOrganizationToken"), "polar_oat_…"),
    secret("lemon", t("widgets.finance.total.lemonSqueezyApiKey")),
    secret("paddle", t("widgets.finance.total.paddleApiKey"), "pdl_live_apikey_…"),
    secret("gumroad", "Gumroad: access token"),
    { kind: "text", key: "shopifyDomain", label: t("widgets.finance.total.shopifyDomain"), placeholder: t("widgets.finance.total.mystoreMyshopifyCom") },
    secret("shopify", t("widgets.finance.total.shopifyAdminApiToken"), "shpat_…"),
    secret("dodo", t("widgets.finance.total.dodoPaymentsApiKey")),
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
    const failed = state.failed.map((name) => ({ label: t("widgets.finance.total.couldntRead", { name }), danger: true, onSelect: () => {} }));
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
    const label = String(c.label || t("widgets.finance.total.totalRevenue"));
    const tip = () => {
      const names = sources(c, 31).map(([name]) => name);
      const source = names.length ? t("widgets.finance.total.sumOfConvertedTo", { p0: names.join(", "), currency }) : t("widgets.finance.total.noProviderWithKey");
      if (!goal) return revenueTip({ label, daily: state.daily, currency, config: c, source, demo: state.demo, error: state.error, click: t("widgets.finance.total.clickToOpenChart") });
      return [
        t("widgets.finance.total.thisMonthSince1st", { label, p1: money(mtd, currency, format) }),
        t("widgets.finance.total.goalForMonthReached", { p0: money(goal, currency, format), p1: Math.round((mtd / goal) * 100) }),
        t("widgets.finance.total.soFarExpectedAmount", { p0: ahead ? t("widgets.finance.total.onPace") : t("widgets.finance.total.behindPace"), p1: money(expected, currency, format) }),
        ...(state.failed.length ? [t("widgets.finance.total.couldntRead2", { p0: state.failed.join(", ") })] : []),
        state.demo ? t("widgets.finance.total.sampleDataEnterKeys") : t("widgets.finance.total.source", { source }),
          t("widgets.finance.total.clickToOpenChart"),
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
                  {`${Math.round((mtd / goal) * 100)}% ${ahead ? t("widgets.finance.total.onPace2") : "abaixo"}`}
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
