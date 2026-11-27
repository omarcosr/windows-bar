import { Text, View, store, toRaw } from "@tarve/core";
import { launch } from "../../services/windows";
import { numeric, ui } from "../../theme";
import { Lines, Sparkline, Tile } from "../ui";
import { defineWidget } from "../types";
import { refreshWidget } from "../../services/remote";

import { t, language } from "../../i18n";
const DAY = 86_400;
const refreshers = new WeakMap<object, () => Promise<void>>();
const DEMO = [62, 70, 66, 74, 71, 80, 77, 84, 82, 90, 86, 95, 99, 94, 104, 101, 110, 108, 118, 115, 124, 131, 127, 138];

interface StripeTx {
  id: string;
  net: number;
  created: number;
  currency: string;
}

async function stripeTransactions(key: string, since: number) {
  const out: StripeTx[] = [];
  let after = "";
  for (let page = 0; page < 20; page++) {
    const url = `https://api.stripe.com/v1/balance_transactions?limit=100&created[gte]=${since}${after ? `&starting_after=${after}` : ""}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok) throw new Error(`Stripe ${res.status}`);
    const body = (await res.json()) as { data: StripeTx[]; has_more: boolean };
    out.push(...body.data);
    if (!body.has_more || body.data.length === 0) break;
    after = body.data[body.data.length - 1]!.id;
  }
  return out;
}

function money(amount: number, currency: string) {
  return new Intl.NumberFormat(language, { style: "currency", currency: currency.toUpperCase(), maximumFractionDigits: 0 }).format(amount);
}

export default defineWidget({
  type: "revenue",
  name: "Receita (Stripe)",
  description: t("widgets.revenue.netRevenueForLast"),
  category: "finance",
  defaultConfig: { stripeKey: "", label: t("widgets.revenue.revenue"), period: "30", change: "percent" },
  settings: [
    { kind: "text", key: "label", label: t("widgets.revenue.title"), placeholder: t("widgets.revenue.revenue") },
    {
      kind: "text",
      key: "stripeKey",
      label: t("widgets.revenue.stripeRestrictedKey"),
      description: t("widgets.revenue.balanceReadOnlyRk"),
      placeholder: "rk_live_…",
      secret: true,
    },
    {
      kind: "choice",
      key: "period",
      label: t("widgets.revenue.period"),
      description: t("widgets.revenue.revenueAddsUpThis"),
      options: [
        { value: "7", label: t("widgets.revenue.last7Days") },
        { value: "30", label: t("widgets.revenue.last30Days") },
        { value: "90", label: t("widgets.revenue.last90Days") },
      ],
    },
    {
      kind: "choice",
      key: "change",
      label: t("widgets.revenue.change"),
      options: [
        { value: "percent", label: t("widgets.revenue.inVsPreviousPeriod") },
        { value: "amount", label: t("widgets.revenue.inAmountVsPrevious") },
        { value: "none", label: t("widgets.revenue.dontShow") },
      ],
    },
  ],
  setup(ctx) {
    const state = store({ total: 2980, previous: 2275, change: 31, series: DEMO, currency: "usd", demo: true, error: "" });
    const load = async () => {
      const key = String(ctx.config.stripeKey || "");
      if (!key) return;
      try {
        const now = Math.floor(Date.now() / 1000);
        const span = Math.max(1, Number(ctx.config.period) || 30);
        const txs = await stripeTransactions(key, now - 2 * span * DAY);
        const days = new Array(span).fill(0);
        let current = 0;
        let previous = 0;
        for (const tx of txs) {
          const age = Math.floor((now - tx.created) / DAY);
          if (age < span) {
            current += tx.net;
            days[span - 1 - age] += tx.net;
          } else previous += tx.net;
        }
        let running = 0;
        state.series = days.map((d) => (running += d) / 100);
        state.total = current / 100;
        state.previous = previous / 100;
        state.change = previous ? Math.round(((current - previous) / Math.abs(previous)) * 100) : 0;
        state.currency = txs[0]?.currency ?? "usd";
        state.demo = false;
        state.error = "";
      } catch (error) {
        state.error = String(error);
      }
    };
    refreshers.set(toRaw(state), load);
    refreshWidget(ctx, 10 * 60_000, load, () => !!state.error);
    return state;
  },
  menu({ state }) {
    return [
      [
        { label: t("widgets.revenue.refreshNow"), icon: "download", onSelect: () => void refreshers.get(toRaw(state))?.() },
        { label: t("widgets.revenue.openStripeDashboard"), icon: "star", onSelect: () => launch("https://dashboard.stripe.com") },
      ],
    ];
  },
  View({ state, ctx, preview }) {
    const up = state.change >= 0;
    const span = Number(ctx.config.period) || 30;
    const mode = String(ctx.config.change || "percent");
    const delta = mode === "amount" ? money(Math.abs(state.total - state.previous), state.currency) : `${Math.abs(state.change)}%`;
    const spark = Math.max(14, Math.round(ui.tile.height - 16));
    return (
      <Tile
        lead="round"
        preview={preview}
        onClick={() => launch("https://dashboard.stripe.com")}
        tip={{
          id: `tip:${ctx.instanceId}`,
          lines: () => [
            t("widgets.revenue.netRevenueForLastDays", { p0: String(ctx.config.label), span, p2: state.demo ? t("widgets.revenue.sample") : "" }),
            t("widgets.revenue.nowDaysBefore", { p0: money(state.total, state.currency), span, p2: money(state.previous, state.currency) }),
            t("widgets.revenue.change2", { p0: up ? "+" : "−", p1: Math.abs(state.change), p2: money(Math.abs(state.total - state.previous), state.currency) }),
            state.error ? t("widgets.revenue.error", { error: state.error }) : t("widgets.revenue.clickOpenStripeDashboard"),
          ],
        }}
      >
        <View style={{ width: 16, height: 16, radius: 8, background: "#635bff", align: "center", justify: "center", shrink: 0 }}>
          <Text size={10} weight={800} color="#fff" style={{ lineHeight: 1 }}>
            S
          </Text>
        </View>
        <Lines
          label={state.demo ? `${String(ctx.config.label)} · demo` : `${String(ctx.config.label)} · ${span} d`}
          value={money(state.total, state.currency)}
        />
        <Sparkline values={state.series} width={52} height={spark} color={up ? ui.green : ui.danger} />
        {mode === "none" ? null : (
          <Lines align="end" valueFirst value={`${up ? "▲" : "▼"} ${delta}`} valueColor={up ? ui.green : ui.danger} label={t("widgets.revenue.vsPrevD", { span })} />
        )}
      </Tile>
    );
  },
});
