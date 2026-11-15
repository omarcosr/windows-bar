import { Column, Row, Text, View, store, toRaw } from "@tarve/core";
import { launch } from "../../services/windows";
import { numeric, ui } from "../../theme";
import { Sparkline, Tile } from "../ui";
import { defineWidget } from "../types";

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
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: currency.toUpperCase(), maximumFractionDigits: 0 }).format(amount);
}

export default defineWidget({
  type: "revenue",
  name: "Receita (Stripe)",
  description: "Receita líquida dos últimos 30 dias com tendência. Sem chave mostra dados de exemplo.",
  category: "finance",
  defaultConfig: { stripeKey: "", label: "Receita" },
  setup(ctx) {
    const state = store({ total: 2980, change: 31, series: DEMO, currency: "usd", demo: true, error: "" });
    const load = async () => {
      const key = String(ctx.config.stripeKey || "");
      if (!key) return;
      try {
        const now = Math.floor(Date.now() / 1000);
        const txs = await stripeTransactions(key, now - 60 * DAY);
        const days = new Array(30).fill(0);
        let current = 0;
        let previous = 0;
        for (const tx of txs) {
          const age = Math.floor((now - tx.created) / DAY);
          if (age < 30) {
            current += tx.net;
            days[29 - age] += tx.net;
          } else previous += tx.net;
        }
        let running = 0;
        state.series = days.map((d) => (running += d) / 100);
        state.total = current / 100;
        state.change = previous ? Math.round(((current - previous) / Math.abs(previous)) * 100) : 0;
        state.currency = txs[0]?.currency ?? "usd";
        state.demo = false;
        state.error = "";
      } catch (error) {
        state.error = String(error);
      }
    };
    refreshers.set(toRaw(state), load);
    ctx.every(10 * 60_000, load);
    return state;
  },
  menu({ state }) {
    return [
      [
        { label: "Atualizar agora", icon: "download", onSelect: () => void refreshers.get(toRaw(state))?.() },
        { label: "Abrir painel do Stripe", icon: "star", onSelect: () => launch("https://dashboard.stripe.com") },
      ],
    ];
  },
  View({ state, ctx }) {
    const up = state.change >= 0;
    return (
      <Tile width={196} padding={{ left: 10, right: 10, top: 6, bottom: 4 }}>
        <Column style={{ flex: 1, gap: 2 }}>
          <Row style={{ align: "center", gap: 6 }}>
            <View style={{ width: 14, height: 14, radius: 7, background: "#635bff", align: "center", justify: "center" }}>
              <Text size={9} weight={800} color="#fff">
                S
              </Text>
            </View>
            <Text size={11} weight={600} color={ui.text} style={{ flex: 1 }}>
              {String(ctx.config.label)}
              {state.demo ? (
                <Text size={9} color={ui.faint}>
                  {" "}
                  demo
                </Text>
              ) : null}
            </Text>
            <Column style={{ align: "end", gap: 0 }}>
              <Text size={12} weight={700} color={ui.text} style={numeric}>
                {money(state.total, state.currency)}
              </Text>
            </Column>
          </Row>
          <Row style={{ align: "end", gap: 6 }}>
            <Sparkline values={state.series} width={128} height={20} color={ui.green} />
            <Text size={10} weight={700} color={up ? ui.green : ui.danger} style={{ ...numeric, flex: 1, textAlign: "right" }}>
              {`${up ? "▲" : "▼"} ${Math.abs(state.change)}%`}
            </Text>
          </Row>
        </Column>
      </Tile>
    );
  },
});
