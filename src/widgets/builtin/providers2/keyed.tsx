import { Column, Row, Text, View, store, toRaw } from "@tarve/core";
import { launch } from "../../../services/windows";
import { errorText } from "../../../services/finance-providers";
import { datafastVisitors, deepseekBalance, zaiQuota, type DeepseekBalance, type ZaiQuota } from "../../../services/providers2-keyed";
import { resetLabel } from "../../../services/ai-usage";
import { rowGap, tight } from "../ai/shared";
import { numeric, ui } from "../../../theme";
import { Meter, Tile } from "../../ui";
import { BrandIcon } from "../../brand-icons";
import { defineWidget, type WidgetContext } from "../../types";
import { Badge, Bars, Delta, TileTitle, oneRow, changeText, momentLabel, poll, refreshItem, refreshers } from "../finance/shared";

import { t, language } from "../../../i18n";
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

function Title(props: { color: string; letter: string; title: string; demo: boolean; error: string; right?: string; value?: { text: string; color: string } }) {
  return (
    <Row style={{ align: "center", gap: 6 }}>
      <Badge color={props.color} letter={props.letter} />
      <TileTitle text={props.title} demo={props.demo} error={props.error} />
      {props.right ? (
        <Text size={10} color={ui.muted} style={numeric}>
          {props.right}
        </Text>
      ) : null}
      {props.value ? (
        <Text size={12} weight={700} color={props.value.color} style={numeric}>
          {props.value.text}
        </Text>
      ) : null}
    </Row>
  );
}

function money(value: number, currency: string) {
  try {
    return new Intl.NumberFormat(language, { style: "currency", currency, maximumFractionDigits: 2 }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}

// ---------------------------------------------------------------- DeepSeek

const DEEPSEEK_URL = "https://platform.deepseek.com/usage";

const deepseekDemo = (): DeepseekBalance => ({ available: true, currency: "USD", total: 18.42, granted: 0, toppedUp: 18.42 });

const deepseek = defineWidget({
  type: "ai-deepseek-balance",
  name: t("widgets.providers2.keyed.deepseekBalance"),
  description: t("widgets.providers2.keyed.deepseekApiAccountBalance"),
  category: "productivity",
  defaultConfig: { key: "", refresh: "15" },
  settings: [
    {
      kind: "text",
      key: "key",
      label: t("widgets.providers2.keyed.apiKey"),
      description: t("widgets.providers2.keyed.platformDeepseekComApi"),
      placeholder: "sk-…",
      secret: true,
    },
  ],
  setup: (ctx) => keyed(ctx, deepseekDemo, (c) => (c.key ? deepseekBalance(c.key) : null), 15),
  menu: ({ state }) => [[refreshItem(state), { label: t("widgets.providers2.keyed.openUsageOnDeepseek"), icon: "star", onSelect: () => launch(DEEPSEEK_URL) }]],
  View({ state, ctx, preview }) {
    const b = state.data;
    const tip = () => [
      t("widgets.providers2.keyed.deepseekApiBalance", { p0: money(b.total, b.currency), p1: b.available ? "" : t("widgets.providers2.keyed.notEnoughForCalls") }),
      t("widgets.providers2.keyed.toppedUpBonus", { p0: money(b.toppedUp, b.currency), p1: money(b.granted, b.currency) }),
      t("widgets.providers2.keyed.apiReportsOnlyCurrent"),
      state.demo ? t("widgets.providers2.keyed.sampleDataEnterKey") : state.error ? `DeepSeek: ${state.error}` : t("widgets.providers2.keyed.sourceDeepseekBalanceApi"),
      t("widgets.providers2.keyed.clickToOpenUsage"),
    ];
    return (
      <Tile icon={<BrandIcon brand="deepseek" />} value={money(b.total, b.currency)} valueColor={b.available ? ui.text : ui.danger} width={oneRow() ? 196 : 170} onClick={() => launch(DEEPSEEK_URL)} tip={{ id: `tip:${ctx.instanceId}`, lines: tip }} preview={preview}>
        <Column style={{ flex: 1, gap: 2 }}>
          <Title
            color="#4d6bfe"
            letter="D"
            title="DeepSeek"
            demo={state.demo}
            error={state.error}
            // One row on a 28 px tile (oneRow): the balance beside the title; the bonus is in the tip.
            value={oneRow() ? { text: money(b.total, b.currency), color: b.available ? ui.text : ui.danger } : undefined}
          />
          <Row style={{ align: "center", gap: 6, display: oneRow() ? "none" : "flex" }}>
            <Text size={13} weight={700} color={b.available ? ui.text : ui.danger} style={numeric}>
              {money(b.total, b.currency)}
            </Text>
            <Text size={9} color={ui.faint} style={{ flex: 1 }}>
              {!b.available ? t("widgets.providers2.keyed.noBalance") : b.granted > 0 ? t("widgets.providers2.keyed.bonus", { p0: money(b.granted, b.currency) }) : "saldo"}
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
      <Text size={10} weight={600} color={ui.muted} style={{ ...tight(), width: 26 }}>
        {props.label}
      </Text>
      <Meter value={used / 100} width={56} color={tone(used)} />
      <Text size={11} weight={700} color={props.used === null ? ui.faint : ui.text} style={{ ...numeric, ...tight(), width: 30, textAlign: "right" }}>
        {props.used === null ? "—" : `${used}%`}
      </Text>
      {props.right ? (
        <Text size={10} color={ui.muted} style={{ ...numeric, ...tight() }}>
          {props.right}
        </Text>
      ) : null}
    </Row>
  );
}

const zai = defineWidget({
  type: "ai-zai-coding-plan",
  name: "GLM Coding Plan (Z.ai)",
  description: t("widgets.providers2.keyed.usageOf5Hour"),
  category: "productivity",
  defaultConfig: { key: "", region: "global", refresh: "5" },
  settings: [
    {
      kind: "text",
      key: "key",
      label: t("widgets.providers2.keyed.planApiKey"),
      description: t("widgets.providers2.keyed.sameKeyUsedIn"),
      secret: true,
    },
    {
      kind: "choice",
      key: "region",
      label: t("widgets.providers2.keyed.platform"),
      options: [
        { value: "global", label: "Z.ai (api.z.ai)" },
        { value: "cn", label: "Zhipu (open.bigmodel.cn)" },
      ],
    },
  ],
  setup: (ctx) => keyed(ctx, zaiDemo, (c) => (c.key ? zaiQuota(c.key, c.region) : null), 5),
  menu: ({ state, ctx }) => [[refreshItem(state), { label: t("widgets.providers2.keyed.openSubscription"), icon: "star", onSelect: () => launch(zaiUrl(ctx.config.region)) }]],
  View({ state, ctx, preview }) {
    const q = state.data;
    const tip = () => [
      `GLM Coding Plan${q.plan ? ` ${q.plan}` : ""}`,
      q.tokens ? t("widgets.providers2.keyed.tokensIn5Hour", { used: q.tokens.used, p1: q.tokens.resetsAt ? t("widgets.providers2.keyed.resets", { p0: momentLabel(q.tokens.resetsAt) }) : "" }) : t("widgets.providers2.keyed.tokensNoData"),
      ...(q.mcp ? [t("widgets.providers2.keyed.mcpCallsThisMonth", { used: q.mcp.used, p1: q.mcp.total ? ` (${q.mcp.current} de ${q.mcp.total})` : "" })] : []),
      state.demo ? t("widgets.providers2.keyed.sampleDataEnterKey") : state.error ? `Z.ai: ${state.error}` : t("widgets.providers2.keyed.sourceQuotaQueryFrom"),
      t("widgets.providers2.keyed.clickToOpenSubscription"),
    ];
      // Three rows (title, 5h, MCP) need a 44 px tile; below it the title gives way to the badge on
      // the left and the reset time moves onto the 5h row.
      const compact = !!q.mcp && ui.tile.height < 44;
      const reset = resetLabel(q.tokens?.resetsAt ?? null);
      return (
        <Tile icon={<Badge color="#2d5bff" letter="Z" size={ui.app.icon} />} value={q.tokens ? `${q.tokens.used}%` : undefined} width={compact ? 228 : 196} lead={compact ? "round" : undefined} onClick={() => launch(zaiUrl(ctx.config.region))} tip={{ id: `tip:${ctx.instanceId}`, lines: tip }} preview={preview}>
          {compact ? <Badge color="#2d5bff" letter="Z" /> : null}
          <Column style={{ flex: 1, gap: compact ? rowGap(2) : 2 }}>
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
const compact = new Intl.NumberFormat(language, { notation: "compact", maximumFractionDigits: 1 });

const datafast = defineWidget({
  type: "online-datafast",
  name: t("widgets.providers2.keyed.datafastVisitors"),
  description: t("widgets.providers2.keyed.visitorsPerDayIn"),
  category: "productivity",
  defaultConfig: { label: "DataFast", key: "", websiteId: "", refresh: "15" },
  settings: [
    { kind: "text", key: "label", label: t("widgets.providers2.keyed.title"), placeholder: "DataFast" },
    {
      kind: "text",
      key: "key",
      label: t("widgets.providers2.keyed.apiKey"),
      description: t("widgets.providers2.keyed.siteKeyDfOr"),
      placeholder: "df_…",
      secret: true,
    },
    { kind: "text", key: "websiteId", label: t("widgets.providers2.keyed.siteId"), description: t("widgets.providers2.keyed.onlyWithAccountToken"), when: (c) => c.key.startsWith("dft_") },
    {
      kind: "choice",
      key: "refresh",
      label: t("widgets.providers2.keyed.refreshEvery"),
      options: [
        { value: "5", label: "5 min" },
        { value: "15", label: "15 min" },
        { value: "30", label: "30 min" },
        { value: "60", label: "1 hora" },
      ],
    },
  ],
  setup: (ctx) => keyed(ctx, datafastDemo, (c) => (c.key ? datafastVisitors(c.key, c.websiteId, 14) : null), 15),
  menu: ({ state }) => [[refreshItem(state), { label: t("widgets.providers2.keyed.openDatafast"), icon: "star", onSelect: () => launch("https://datafa.st/dashboard") }]],
  View({ state, ctx, preview }) {
    const days = state.data;
    const week = days.slice(-7).reduce((a, b) => a + b, 0);
    const before = days.slice(-14, -7).reduce((a, b) => a + b, 0);
    const tip = () => [
      t("widgets.providers2.keyed.visitorsInLast7", { p0: String(ctx.config.label || "DataFast"), p1: week.toLocaleString(language) }),
      before > 0 ? t("widgets.providers2.keyed.againstPrevious7Days", { p0: changeText(((week - before) / before) * 100, 1), p1: before.toLocaleString(language) }) : t("widgets.providers2.keyed.noDataFromPrevious"),
      t("widgets.providers2.keyed.barsVisitorsPerDay"),
      state.demo ? t("widgets.providers2.keyed.sampleDataEnterKey") : state.error ? `DataFast: ${state.error}` : t("widgets.providers2.keyed.sourceDatafastApi"),
      t("widgets.providers2.keyed.clickToOpenDatafast"),
    ];
    return (
      <Tile icon={<Badge color="#e7663b" letter="D" size={ui.app.icon} />} value={compact.format(week)} width={196} onClick={() => launch("https://datafa.st/dashboard")} tip={{ id: `tip:${ctx.instanceId}`, lines: tip }} preview={preview}>
        <Column style={{ flex: 1, gap: 2 }}>
          <Row style={{ align: "center", gap: 6 }}>
            <Badge color="#e7663b" letter="D" />
            <TileTitle text={String(ctx.config.label || "DataFast")} demo={state.demo} error={state.error} />
            <Text size={12} weight={700} color={ui.text} style={numeric}>
              {compact.format(week)}
            </Text>
          </Row>
          <Row style={{ align: "center", gap: 6, height: 18, display: oneRow() ? "none" : "flex" }}>
            <Bars values={days} width={112} height={16} color="#e7663b" />
            {before > 0 ? <Delta value={((week - before) / before) * 100} /> : <View style={{ flex: 1, align: "end" }}><Text size={10} color={ui.faint}>{"7 dias"}</Text></View>}
          </Row>
        </Column>
      </Tile>
    );
  },
});

export default [deepseek, zai, datafast];
