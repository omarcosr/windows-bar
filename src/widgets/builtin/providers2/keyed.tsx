import { Column, Row, Text, store, toRaw } from "@tarve/core";
import { launch } from "../../../services/windows";
import { errorText } from "../../../services/finance-providers";
import { datafastVisitors, deepseekBalance, zaiQuota, type DeepseekBalance, type ZaiQuota } from "../../../services/providers2-keyed";
import { resetLabel } from "../../../services/ai-usage";
import { numeric, ui } from "../../../theme";
import { Meter, Tile } from "../../ui";
import { defineWidget, type WidgetContext } from "../../types";
import { Badge, Bars, Delta, Status, poll, refreshItem, refreshers } from "../finance/shared";

interface Keyed<T> {
  data: T;
  demo: boolean;
  error: string;
}

/**
 * The state of a keyed tile: demo data until a key is set (and always in the gallery), then the
 * provider's answer, refreshed every `minutes` through services/remote.ts's refreshLoop.
 */
function keyed<C extends object, T>(ctx: WidgetContext<C>, demo: () => T, load: (c: C) => Promise<T> | null, minutes: number) {
  const state = store<Keyed<T>>({ data: demo(), demo: true, error: "" });
  if (ctx.instanceId.startsWith("preview:")) return state;
  let seq = 0;
  const run = async () => {
    const id = ++seq;
    const pending = load(ctx.config);
    try {
      const data = pending ? await pending : demo();
      if (id === seq) Object.assign(state, { data, demo: !pending, error: "" });
    } catch (error) {
      if (id === seq) state.error = errorText(error);
    }
  };
  refreshers.set(toRaw(state), run);
  poll(ctx, run, minutes, { failed: () => !!state.error });
  return state;
}

const tone = (used: number) => (used >= 90 ? ui.danger : used >= 70 ? "#ff9f0a" : ui.green);

function Title(props: { color: string; letter: string; title: string; demo: boolean; error: string; right?: string }) {
  return (
    <Row style={{ align: "center", gap: 6 }}>
      <Badge color={props.color} letter={props.letter} />
      <Text size={11} weight={600} color={ui.text} style={{ flex: 1 }}>
        {props.title}
        <Status demo={props.demo} error={props.error} />
      </Text>
      {props.right ? (
        <Text size={10} color={ui.muted} style={numeric}>
          {props.right}
        </Text>
      ) : null}
    </Row>
  );
}

function money(value: number, currency: string) {
  try {
    return new Intl.NumberFormat("pt-BR", { style: "currency", currency, maximumFractionDigits: 2 }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}

// ---------------------------------------------------------------- DeepSeek

const DEEPSEEK_URL = "https://platform.deepseek.com/usage";

const deepseekDemo = (): DeepseekBalance => ({ available: true, currency: "USD", total: 18.42, granted: 0, toppedUp: 18.42 });

const deepseek = defineWidget({
  type: "ai-deepseek-balance",
  name: "Saldo do DeepSeek",
  description: "Saldo da conta da API do DeepSeek (recarregado e bônus), pela API oficial de saldo. A API não informa gasto por período.",
  category: "productivity",
  defaultConfig: { key: "", refresh: "15" },
  settings: [
    {
      kind: "text",
      key: "key",
      label: "Chave de API",
      description: "platform.deepseek.com › API keys. Enviada só para api.deepseek.com. Vazia mostra dados de exemplo.",
      placeholder: "sk-…",
      secret: true,
    },
  ],
  setup: (ctx) => keyed(ctx, deepseekDemo, (c) => (c.key ? deepseekBalance(c.key) : null), 15),
  menu: ({ state }) => [[refreshItem(state), { label: "Abrir uso no DeepSeek", icon: "star", onSelect: () => launch(DEEPSEEK_URL) }]],
  View({ state }) {
    const b = state.data;
    return (
      <Tile width={170} padding={{ left: 10, right: 10 }} onClick={() => launch(DEEPSEEK_URL)}>
        <Column style={{ flex: 1, gap: 2 }}>
          <Title color="#4d6bfe" letter="D" title="DeepSeek" demo={state.demo} error={state.error} />
          <Row style={{ align: "center", gap: 6 }}>
            <Text size={13} weight={700} color={b.available ? ui.text : ui.danger} style={numeric}>
              {money(b.total, b.currency)}
            </Text>
            <Text size={9} color={ui.faint} style={{ flex: 1 }}>
              {!b.available ? "sem saldo" : b.granted > 0 ? `bônus ${money(b.granted, b.currency)}` : "saldo"}
            </Text>
          </Row>
        </Column>
      </Tile>
    );
  },
});

// ---------------------------------------------------------------- Z.ai GLM Coding Plan

const zaiDemo = (): ZaiQuota => ({
  plan: "Pro",
  tokens: { used: 34, resetsAt: Date.now() + 2.6 * 3_600_000 },
  mcp: { used: 12, resetsAt: null, current: 120, total: 1000 },
});

const zaiUrl = (region: string) => (region === "cn" ? "https://bigmodel.cn/usercenter/glm-coding/usage" : "https://z.ai/manage-apikey/subscription");

function QuotaRow(props: { label: string; used: number | null; right?: string }) {
  const used = props.used ?? 0;
  return (
    <Row style={{ align: "center", gap: 6 }}>
      <Text size={10} weight={600} color={ui.muted} style={{ width: 26 }}>
        {props.label}
      </Text>
      <Meter value={used / 100} width={56} color={tone(used)} />
      <Text size={11} weight={700} color={props.used === null ? ui.faint : ui.text} style={{ ...numeric, width: 30, textAlign: "right" }}>
        {props.used === null ? "—" : `${used}%`}
      </Text>
      {props.right ? (
        <Text size={10} color={ui.muted} style={numeric}>
          {props.right}
        </Text>
      ) : null}
    </Row>
  );
}

const zai = defineWidget({
  type: "ai-zai-coding-plan",
  name: "GLM Coding Plan (Z.ai)",
  description: "Uso da janela de 5 h de tokens e das chamadas MCP do mês no GLM Coding Plan, pela mesma consulta do plugin oficial glm-plan-usage.",
  category: "productivity",
  defaultConfig: { key: "", region: "global", refresh: "5" },
  settings: [
    {
      kind: "text",
      key: "key",
      label: "Chave de API do plano",
      description: "A mesma chave usada no Claude Code/ferramentas com o Coding Plan. Enviada só para a Z.ai (ou Zhipu). Vazia mostra dados de exemplo.",
      secret: true,
    },
    {
      kind: "choice",
      key: "region",
      label: "Plataforma",
      options: [
        { value: "global", label: "Z.ai (api.z.ai)" },
        { value: "cn", label: "Zhipu (open.bigmodel.cn)" },
      ],
    },
  ],
  setup: (ctx) => keyed(ctx, zaiDemo, (c) => (c.key ? zaiQuota(c.key, c.region) : null), 5),
  menu: ({ state, ctx }) => [[refreshItem(state), { label: "Abrir assinatura", icon: "star", onSelect: () => launch(zaiUrl(ctx.config.region)) }]],
  View({ state, ctx }) {
    const q = state.data;
    // Three rows (title, 5h, MCP) need a 44 px tile; below it the title gives way to the badge on
      // the left and the reset time moves onto the 5h row.
      const compact = !!q.mcp && ui.tile.height < 44;
      const reset = resetLabel(q.tokens?.resetsAt ?? null);
      return (
        <Tile width={compact ? 228 : 196} padding={{ left: 10, right: 10 }} onClick={() => launch(zaiUrl(ctx.config.region))}>
          {compact ? <Badge color="#2d5bff" letter="Z" /> : null}
          <Column style={{ flex: 1, gap: 2 }}>
          {compact ? null : (
            <Title color="#2d5bff" letter="Z" title={`GLM${q.plan ? ` ${q.plan}` : ""}`} demo={state.demo} error={state.error} right={reset} />
          )}
          <QuotaRow label="5h" used={q.tokens?.used ?? null} right={compact ? reset : undefined} />
          {q.mcp ? <QuotaRow label="MCP" used={q.mcp.used} right={q.mcp.total ? `${q.mcp.current}/${q.mcp.total}` : ""} /> : null}
        </Column>
      </Tile>
    );
  },
});

// ---------------------------------------------------------------- DataFast

const datafastDemo = () => [212, 240, 198, 260, 301, 280, 190, 230, 275, 262, 318, 344, 296, 251];
const compact = new Intl.NumberFormat("pt-BR", { notation: "compact", maximumFractionDigits: 1 });

const datafast = defineWidget({
  type: "online-datafast",
  name: "DataFast (visitantes)",
  description: "Visitantes por dia nos últimos 14 dias, o total da semana e a variação contra a semana anterior, pela API do DataFast.",
  category: "productivity",
  defaultConfig: { label: "DataFast", key: "", websiteId: "", refresh: "15" },
  settings: [
    { kind: "text", key: "label", label: "Título", placeholder: "DataFast" },
    {
      kind: "text",
      key: "key",
      label: "Chave de API",
      description: "Chave do site (df_…) ou token da conta (dft_…, com analytics:read). Enviada só para datafa.st. Vazia mostra dados de exemplo.",
      placeholder: "df_…",
      secret: true,
    },
    { kind: "text", key: "websiteId", label: "ID do site", description: "Só com token da conta (dft_…).", when: (c) => c.key.startsWith("dft_") },
    {
      kind: "choice",
      key: "refresh",
      label: "Atualizar a cada",
      options: [
        { value: "5", label: "5 min" },
        { value: "15", label: "15 min" },
        { value: "30", label: "30 min" },
        { value: "60", label: "1 hora" },
      ],
    },
  ],
  setup: (ctx) => keyed(ctx, datafastDemo, (c) => (c.key ? datafastVisitors(c.key, c.websiteId, 14) : null), 15),
  menu: ({ state }) => [[refreshItem(state), { label: "Abrir DataFast", icon: "star", onSelect: () => launch("https://datafa.st/dashboard") }]],
  View({ state, ctx }) {
    const days = state.data;
    const week = days.slice(-7).reduce((a, b) => a + b, 0);
    const before = days.slice(-14, -7).reduce((a, b) => a + b, 0);
    return (
      <Tile width={196} padding={{ left: 10, right: 10, top: 6, bottom: 4 }} onClick={() => launch("https://datafa.st/dashboard")}>
        <Column style={{ flex: 1, gap: 2 }}>
          <Row style={{ align: "center", gap: 6 }}>
            <Badge color="#e7663b" letter="D" />
            <Text size={11} weight={600} color={ui.text} style={{ flex: 1 }}>
              {String(ctx.config.label || "DataFast")}
              <Status demo={state.demo} error={state.error} />
            </Text>
            <Text size={12} weight={700} color={ui.text} style={numeric}>
              {compact.format(week)}
            </Text>
          </Row>
          <Row style={{ align: "end", gap: 6 }}>
            <Bars values={days} width={112} height={16} color="#e7663b" />
            {before > 0 ? <Delta value={((week - before) / before) * 100} /> : <Text size={9} color={ui.faint}>{"7 dias"}</Text>}
          </Row>
        </Column>
      </Tile>
    );
  },
});

export default [deepseek, zai, datafast];
