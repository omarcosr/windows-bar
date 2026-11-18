import { Column, Row, Text, store, toRaw } from "@tarve/core";
import { launch } from "../../../services/windows";
import { onClock, type ClockSubscription } from "../../../services/clock";
import { aiUsage, opencodePoller, refreshOpencode, resetLabel, tokensLabel } from "../../../services/ai-usage";
import { gemini, geminiDemo, geminiPoller, refreshGemini } from "../../../services/providers2-gemini";
import { numeric, ui } from "../../../theme";
import { Meter, Tile } from "../../ui";
import { defineWidget, type WidgetContext } from "../../types";
import { Badge } from "../finance/shared";
import { StatusLine, demo, showsData, tone } from "../ai/shared";

// ---------------------------------------------------------------- Gemini CLI

/** Re-renders exactly when a shown "renova em" label changes (the shared clock, like ai/shared's ticker). */
function geminiTicker<C extends object>(ctx: WidgetContext<C>) {
  let sub: ClockSubscription | undefined;
  const state = store({
    count: 0,
    get tick(): number {
      sub?.update();
      return this.count;
    },
  });
  sub = onClock(
    (now, covered) => {
      if (covered) return null;
      let next = Infinity;
      for (const m of toRaw(gemini).usage.models) {
        if (!m.resetsAt || m.resetsAt <= now) continue;
        const minutes = Math.ceil((m.resetsAt - now) / 60_000);
        next = Math.min(next, m.resetsAt - (Math.min(minutes, 24 * 60) - 1) * 60_000);
      }
      return next === Infinity ? null : next;
    },
    () => state.count++,
  );
  ctx.onDispose(sub.cancel);
  return state;
}

const GEMINI_URL = "https://aistudio.google.com/usage";

const geminiWidget = defineWidget({
  type: "ai-gemini-cli",
  name: "Uso do Gemini CLI",
  description: "Cota diária restante por modelo no Gemini CLI (login Google), a mesma que o /stats mostra. Lê o login do Gemini CLI.",
  category: "productivity",
  defaultConfig: {},
  setup(ctx) {
    if (!ctx.instanceId.startsWith("preview:")) ctx.onDispose(geminiPoller.acquire());
    return geminiTicker(ctx);
  },
  hidden: () => gemini.usage.status === "missing",
  menu: () => [[{ label: "Atualizar agora", icon: "download", onSelect: () => void refreshGemini() }]],
  View({ state, preview }) {
    void state.tick;
    const u = preview ? geminiDemo() : gemini.usage;
    const rows = u.models.slice(0, 2);
    return (
      <Tile width={196} padding={{ left: 10, right: 10 }} onClick={() => launch(GEMINI_URL)}>
        <Column style={{ flex: 1, gap: 3 }}>
          {u.status === "ok" && rows.length ? (
            rows.map((m) => (
              <Row style={{ align: "center", gap: 6 }}>
                <Text size={10} weight={600} color={ui.muted} style={{ width: 52 }}>
                  {m.model.length > 10 ? `${m.model.slice(0, 9)}…` : m.model}
                </Text>
                <Meter value={m.used / 100} width={40} color={tone(m.used)} />
                <Text size={11} weight={700} color={ui.text} style={{ ...numeric, width: 30, textAlign: "right" }}>
                  {`${m.used}%`}
                </Text>
                <Text size={10} color={ui.muted} style={numeric}>
                  {resetLabel(m.resetsAt)}
                </Text>
              </Row>
            ))
          ) : (
            <>
              <Row style={{ align: "center", gap: 6 }}>
                <Badge color="#4285f4" letter="G" />
                <Text size={11} weight={600} color={ui.text}>
                  {"Gemini CLI"}
                </Text>
              </Row>
              {u.status === "ok" ? (
                <Text size={10} color={ui.muted}>
                  {"sem cota informada"}
                </Text>
              ) : (
                <Text size={10} color={u.status === "expired" ? "#ff9f0a" : ui.muted}>
                  {u.status === "loading" ? "carregando…" : u.note || "indisponível"}
                </Text>
              )}
            </>
          )}
        </Column>
      </Tile>
    );
  },
});

// ---------------------------------------------------------------- OpenCode plan (5 h + 7 days + top model)

function UsageLine(props: { label: string; tokens: number; cost: number }) {
  return (
    <Row style={{ align: "center", gap: 6 }}>
      <Text size={10} weight={600} color={ui.muted} style={{ width: 22 }}>
        {props.label}
      </Text>
      <Text size={11} weight={700} color={ui.text} style={{ ...numeric, flex: 1 }}>
        {tokensLabel(props.tokens)}
      </Text>
      <Text size={10} color={ui.muted} style={numeric}>
        {props.cost > 0 ? `US$ ${props.cost.toFixed(2)}` : ""}
      </Text>
    </Row>
  );
}

const opencodePlan = defineWidget({
  type: "ai-opencode-plan",
  name: "Plano do OpenCode",
  description: "Tokens e custo do OpenCode nas últimas 5 h (sessão) e nos últimos 7 dias, com o modelo mais usado. Lido do banco local.",
  category: "productivity",
  defaultConfig: {},
  setup(ctx) {
    if (!ctx.instanceId.startsWith("preview:")) ctx.onDispose(opencodePoller.acquire());
    return {};
  },
  hidden: () => aiUsage.opencode.status === "missing",
  menu: () => [[{ label: "Atualizar agora", icon: "download", onSelect: () => void refreshOpencode() }]],
  View({ preview }) {
    const u = preview ? demo.opencode() : aiUsage.opencode;
    const top = u.top[0];
    return (
      <Tile width={214} padding={{ left: 10, right: 10 }} gap={10}>
        <Column style={{ align: "center", gap: 3, width: 58 }}>
          <Badge color="#3b3b40" letter="▣" />
          <Text size={9} color={ui.muted} style={{ textAlign: "center" }}>
            {top ? `${top.model.length > 11 ? `${top.model.slice(0, 10)}…` : top.model}` : "OpenCode"}
          </Text>
          {top ? (
            <Text size={9} color={ui.faint} style={numeric}>
              {`${top.share}%`}
            </Text>
          ) : null}
        </Column>
        {showsData(u) ? (
          <Column style={{ flex: 1, gap: 4 }}>
            <UsageLine label="5h" tokens={u.tokens5h} cost={u.cost5h} />
            <UsageLine label="sem" tokens={u.tokens7d} cost={u.cost7d} />
          </Column>
        ) : (
          <StatusLine usage={u} />
        )}
      </Tile>
    );
  },
});

export default [geminiWidget, opencodePlan];
