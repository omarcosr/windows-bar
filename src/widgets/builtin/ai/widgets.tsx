import { Column, Row, Text, View } from "@tarve/core";
import { launch } from "../../../services/windows";
import { numeric, ui } from "../../../theme";
import { Tile } from "../../ui";
import { BrandIcon } from "../../brand-icons";
import { FluentGlyph } from "../../../menu/dock-menu";
import { defineWidget } from "../../types";
import {
  aiUsage,
  claudeModelsPoller,
  claudePoller,
  codexPoller,
  opencodePoller,
  refreshClaude,
  refreshClaudeModels,
  refreshCodex,
  refreshOpencode,
  resetLabel,
  tokensLabel,
  type LimitUsage,
} from "../../../services/ai-usage";
import { gemini, geminiLimits, geminiPoller } from "../../../services/providers2-gemini";
import { LimitRow, Logo, StatusLine, brand, demo, limitTip, rowGap, short, showsData, ticker, tone, whenLabel, type Brand } from "./shared";

import { t, language, formatDecimal } from "../../../i18n";
const CLAUDE_SOURCE = t("widgets.ai.widgets.anthropicUsageApiWith");
const CODEX_SOURCE = t("widgets.ai.widgets.limitsCodexCliReceived");
const tipOf = (id: string, lines: () => string[]) => ({ id: `tip:${id}`, lines });

const CLAUDE_USAGE_URL = "https://claude.ai/settings/usage";
const CODEX_USAGE_URL = "https://chatgpt.com/codex/settings/usage";

function Header(props: { brand: Brand; title?: string; plan?: string; right?: string }) {
  return (
    <Row style={{ align: "center", gap: 6 }}>
      <Logo brand={props.brand} />
      <Text size={11} weight={600} color={ui.text} style={{ flex: 1 }}>
        {props.title ?? brand[props.brand].name}
        {props.plan ? (
          <Text size={9} color={ui.faint}>
            {` ${props.plan}`}
          </Text>
        ) : null}
      </Text>
      {props.right ? (
        <Text size={10} color={ui.muted} style={numeric}>
          {props.right}
        </Text>
      ) : null}
    </Row>
  );
}

const limitsOf = (which: "claude" | "codex", preview: boolean): LimitUsage => (preview ? demo[which]() : aiUsage[which]);

// ---------------------------------------------------------------- Claude (5 h)

const claude = defineWidget({
  type: "ai-claude",
  name: t("widgets.ai.widgets.claudeUsage"),
  description: t("widgets.ai.widgets.claudes5HourSession"),
  category: "productivity",
  defaultConfig: {},
  setup(ctx) {
    ctx.onDispose(claudePoller.acquire());
    return ticker(ctx);
  },
  hidden: () => aiUsage.claude.status === "missing",
  menu: () => [
    [
      { label: t("widgets.ai.widgets.refreshNow"), icon: "download", onSelect: () => void refreshClaude() },
      { label: t("widgets.ai.widgets.openUsageOnClaude"), icon: "star", onSelect: () => launch(CLAUDE_USAGE_URL) },
    ],
  ],
  View({ state, ctx, preview }) {
    void state.tick;
    const u = limitsOf("claude", preview);
    const tip = () => limitTip({ name: "Claude", usage: u, source: CLAUDE_SOURCE, preview, click: t("widgets.ai.widgets.clickToOpenUsage") });
    return (
      <Tile icon={<BrandIcon brand="claude" />} {...usedValue(u, u.session)} width={164} lead={short() ? "round" : undefined} onClick={() => launch(CLAUDE_USAGE_URL)} tip={tipOf(ctx.instanceId, tip)} preview={preview}>
        {short() ? (
          // One row on a 28 px tile: the brand, the 5 h meter and its share; the plan and the reset are in the tip.
          <>
            <Logo brand="claude" />
            {showsData(u) ? (
              <View style={{ flex: 1, minWidth: 0 }}>
                <LimitRow label="5h" window={u.session} meter={60} reset={false} />
              </View>
            ) : (
              <StatusLine usage={u} />
            )}
          </>
        ) : (
        <Column style={{ flex: 1, gap: 4 }}>
          <Header brand="claude" plan={u.plan} right={showsData(u) ? resetLabel(u.session?.resetsAt ?? null) : ""} />
          {showsData(u) ? <LimitRow label="5h" window={u.session} meter={74} reset={false} /> : <StatusLine usage={u} />}
        </Column>
          )}
      </Tile>
    );
  },
});

// ---------------------------------------------------------------- Claude plan (5 h + weekly + model)

const claudePlan = defineWidget({
  type: "ai-claude-plan",
  name: t("widgets.ai.widgets.claudePlan"),
  description: t("widgets.ai.widgets.n5HourSessionWeekly"),
  category: "productivity",
  defaultConfig: {},
  setup(ctx) {
    ctx.onDispose(claudePoller.acquire());
    ctx.onDispose(claudeModelsPoller.acquire());
    return ticker(ctx);
  },
  hidden: () => aiUsage.claude.status === "missing",
  menu: () => [
    [
      {
        label: t("widgets.ai.widgets.refreshNow"),
        icon: "download",
        onSelect: () => {
          refreshClaudeModels();
          void refreshClaude();
        },
      },
      { label: t("widgets.ai.widgets.openUsageOnClaude"), icon: "star", onSelect: () => launch(CLAUDE_USAGE_URL) },
    ],
  ],
  View({ state, ctx, preview }) {
    void state.tick;
    const u = limitsOf("claude", preview);
    const top = (preview ? demo.claudeModels() : aiUsage.claudeModels)[0];
    const tip = () => {
      const lines = limitTip({ name: "Claude", usage: u, source: CLAUDE_SOURCE, preview, click: t("widgets.ai.widgets.clickToOpenUsage") });
      if (top) lines.splice(lines.length - 2, 0, t("widgets.ai.widgets.mostUsedModelIn", { model: top.model, share: top.share }));
      return lines;
    };
    return (
      <Tile icon={<BrandIcon brand="claude" />} {...usedValue(u, u.session)} width={short() ? 204 : 226} gap={10} lead={short() ? "round" : undefined} onClick={() => launch(CLAUDE_USAGE_URL)} tip={tipOf(ctx.instanceId, tip)} preview={preview}>
        {short() ? (
          // The logo and the model under it are 30 px tall: on a 28 px tile the model is in the tip.
          <Logo brand="claude" />
          ) : (
          <Column style={{ align: "center", gap: 3, width: 46 }}>
              <Logo brand="claude" size={16} />
              <Text size={9} color={ui.muted} style={{ textAlign: "center" }}>
                {top ? `${top.model}` : u.plan || "Claude"}
            </Text>
          </Column>
          )}
          {showsData(u) ? (
          <Column style={{ flex: 1, gap: rowGap(5) }}>
            <LimitRow label="5h" window={u.session} meter={36} />
            <LimitRow label={t("widgets.ai.widgets.wk")} window={u.weekly} meter={36} />
          </Column>
        ) : (
          <StatusLine usage={u} />
        )}
      </Tile>
    );
  },
});

// ---------------------------------------------------------------- ChatGPT / Codex

const codex = defineWidget({
  type: "ai-codex",
  name: t("widgets.ai.widgets.chatgptUsageCodex"),
  description: t("widgets.ai.widgets.n5HourAndWeekly"),
  category: "productivity",
  defaultConfig: {},
  setup(ctx) {
    ctx.onDispose(codexPoller.acquire());
    return ticker(ctx);
  },
  hidden: () => aiUsage.codex.status === "missing",
  menu: () => [
    [
      { label: t("widgets.ai.widgets.refreshNow"), icon: "download", onSelect: () => refreshCodex() },
      { label: t("widgets.ai.widgets.openUsageOnChatgpt"), icon: "star", onSelect: () => launch(CODEX_USAGE_URL) },
    ],
  ],
  View({ state, ctx, preview }) {
    void state.tick;
    const u = limitsOf("codex", preview);
    const tip = () => limitTip({ name: "ChatGPT (Codex)", usage: u, source: CODEX_SOURCE, preview, click: t("widgets.ai.widgets.clickToOpenUsageOn") });
    return (
      <Tile icon={<Logo brand="codex" size={ui.app.icon} />} {...usedValue(u, u.session)} width={196} onClick={() => launch(CODEX_USAGE_URL)} tip={tipOf(ctx.instanceId, tip)} preview={preview}>
        <Column style={{ flex: 1, gap: rowGap(3) }}>
          {showsData(u) ? (
            <>
              <LimitRow label="5h" window={u.session} meter={44} />
              <LimitRow label={t("widgets.ai.widgets.wk")} window={u.weekly} meter={44} />
            </>
          ) : (
            <>
              {short() ? (
                  <Row style={{ align: "center", gap: 6 }}>
                  <Logo brand="codex" />
                  <StatusLine usage={u} />
                </Row>
              ) : (
                <>
                  <Header brand="codex" plan={u.plan} />
                  <StatusLine usage={u} />
                </>
              )}
            </>
          )}
        </Column>
      </Tile>
    );
  },
});

// ---------------------------------------------------------------- OpenCode

const opencode = defineWidget({
  type: "ai-opencode",
  name: t("widgets.ai.widgets.opencodeUsage"),
  description: t("widgets.ai.widgets.opencodeTokensAndCost"),
  category: "productivity",
  defaultConfig: { period: "5h" },
  settings: [
    {
      kind: "choice",
      key: "period",
      label: t("widgets.ai.widgets.highlight"),
      options: [
        { value: "5h", label: t("widgets.ai.widgets.last5H") },
        { value: "7d", label: t("widgets.ai.widgets.last7Days") },
      ],
    },
  ],
  setup(ctx) {
    ctx.onDispose(opencodePoller.acquire());
    return {};
  },
  hidden: () => aiUsage.opencode.status === "missing",
  menu: () => [[{ label: t("widgets.ai.widgets.refreshNow"), icon: "download", onSelect: () => void refreshOpencode() }]],
  View({ ctx, preview }) {
    const u = preview ? demo.opencode() : aiUsage.opencode;
    const week = ctx.config.period === "7d";
    const tokens = week ? u.tokens7d : u.tokens5h;
    const cost = week ? u.cost7d : u.cost5h;
    const top = u.top[0];
    const tip = () => [
      `OpenCode, ${week ? t("widgets.ai.widgets.last7Days2") : t("widgets.ai.widgets.last5H2")}: ${tokens.toLocaleString(language)} tokens${cost > 0 ? t("widgets.ai.widgets.usCostRecordedBy", { p0: cost.toFixed(2) }) : ""}`,
      t("widgets.ai.widgets.last5HLast", { p0: tokensLabel(u.tokens5h), p1: tokensLabel(u.tokens7d), messages7d: u.messages7d }),
      ...(top ? [t("widgets.ai.widgets.mostUsedModelOf", { model: top.model, share: top.share })] : []),
      preview ? t("widgets.ai.widgets.sampleData") : t("widgets.ai.widgets.sourceOpencodeLocalDatabase", { p0: u.updated ? t("widgets.ai.widgets.read", { p0: whenLabel(u.updated) }) : "" }),
    ];
    return (
      <Tile icon={<BrandIcon brand="opencode" />} value={showsData(u) ? tokensLabel(tokens) : undefined} width={168} lead={short() ? "round" : undefined} tip={tipOf(ctx.instanceId, tip)} preview={preview}>
        {short() ? (
          // One row on a 28 px tile (finance's oneRow): the brand and the tokens; the cost and the period are in the tip.
          <>
            <Logo brand="opencode" />
            <Text size={11} weight={600} color={ui.text} style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
              {"OpenCode"}
            </Text>
            {showsData(u) ? (
              <Text size={12} weight={700} color={ui.text} style={numeric}>
                {tokensLabel(tokens)}
              </Text>
            ) : (
              <StatusLine usage={u} />
            )}
          </>
        ) : (
        <Column style={{ flex: 1, gap: 2 }}>
          <Header brand="opencode" right={showsData(u) ? (week ? "7 dias" : "5 h") : ""} />
          {showsData(u) ? (
            <Row style={{ align: "end", gap: 6 }}>
              <Text size={12} weight={700} color={ui.text} style={numeric}>
                {tokensLabel(tokens)}
              </Text>
              <View style={{ flex: 1 }} />
              <Text size={10} color={ui.muted} style={numeric}>
                {cost > 0 ? `US$ ${formatDecimal(cost, 2)}` : "tokens"}
              </Text>
            </Row>
          ) : (
            <StatusLine usage={u} />
          )}
        </Column>
        )}
      </Tile>
    );
  },
});

// ---------------------------------------------------------------- AI limits (two providers)

type Provider = "claude" | "codex" | "gemini";
const providerOptions = [
  { value: "claude", label: "Claude" },
  { value: "codex", label: "ChatGPT (Codex)" },
  { value: "gemini", label: t("widgets.ai.widgets.geminiCliDailyQuota") },
] as const;
/** The session's share used, for a minimal tile's value: "37%" in the colour of its meter. */
function usedValue(u: Parameters<typeof showsData>[0], w: { used: number } | null | undefined) {
  if (!showsData(u) || !w) return {};
  return { value: `${w.used}%`, valueColor: tone(w.used) };
}

const asProvider = (value: string, fallback: Provider): Provider => (value === "claude" || value === "codex" || value === "gemini" ? value : fallback);
const windowOptions = [
  { value: "session", label: t("widgets.ai.widgets.n5HourSession") },
  { value: "weekly", label: t("widgets.ai.widgets.weekly") },
] as const;

function ProviderLine(props: { provider: Provider; window: string; preview: boolean }) {
  const u = props.provider === "gemini" ? geminiLimits(props.preview) : limitsOf(props.provider, props.preview);
  const daily = props.provider === "gemini";
  const w = props.window === "weekly" && !daily ? u.weekly : u.session;
  return (
    <Row style={{ align: "center", gap: 6 }}>
      <Logo brand={props.provider} size={12} />
      {showsData(u) ? <LimitRow label={daily ? t("widgets.ai.widgets.day") : props.window === "weekly" ? t("widgets.ai.widgets.wk") : "5h"} window={w} meter={40} /> : <StatusLine usage={u} />}
    </Row>
  );
}

const limits = defineWidget({
  type: "ai-limits",
  name: t("widgets.ai.widgets.aiLimits"),
  description: t("widgets.ai.widgets.twoProvidersSideBy"),
  category: "productivity",
  defaultConfig: { first: "claude", firstWindow: "session", second: "codex", secondWindow: "session" },
  settings: [
    { kind: "choice", key: "first", label: t("widgets.ai.widgets.firstLine"), options: providerOptions },
    { kind: "choice", key: "firstWindow", label: t("widgets.ai.widgets.firstLineWindow"), options: windowOptions },
    { kind: "choice", key: "second", label: t("widgets.ai.widgets.secondLine"), options: providerOptions },
    { kind: "choice", key: "secondWindow", label: t("widgets.ai.widgets.secondLineWindow"), options: windowOptions },
  ],
  setup(ctx) {
    ctx.onDispose(claudePoller.acquire());
    ctx.onDispose(codexPoller.acquire());
    if (ctx.config.first === "gemini" || ctx.config.second === "gemini") ctx.onDispose(geminiPoller.acquire());
    return ticker(ctx);
  },
  hidden: ({ ctx }) =>
    aiUsage.claude.status === "missing" &&
    aiUsage.codex.status === "missing" &&
    !((ctx.config.first === "gemini" || ctx.config.second === "gemini") && gemini.usage.status !== "missing"),
  menu: () => [
    [
      {
        label: t("widgets.ai.widgets.refreshNow"),
        icon: "download",
        onSelect: () => {
          refreshCodex();
          void refreshClaude();
        },
      },
      { label: t("widgets.ai.widgets.openUsageOnClaude"), icon: "star", onSelect: () => launch(CLAUDE_USAGE_URL) },
      { label: t("widgets.ai.widgets.openUsageOnChatgpt"), icon: "star", onSelect: () => launch(CODEX_USAGE_URL) },
    ],
  ],
  View({ state, ctx, preview }) {
    void state.tick;
    const first = asProvider(ctx.config.first, "claude");
    const second = asProvider(ctx.config.second, "codex");
    const lines = (provider: Provider, window: string) => {
      const usage = provider === "gemini" ? geminiLimits(preview) : limitsOf(provider, preview);
      const name = provider === "gemini" ? t("widgets.ai.widgets.geminiCliDailyQuota") : brand[provider].name;
      const source = provider === "claude" ? CLAUDE_SOURCE : provider === "codex" ? CODEX_SOURCE : t("widgets.ai.widgets.geminiCliGoogleLogin");
      const all = limitTip({ name, usage, source, preview, windows: provider === "gemini" || window !== "weekly" ? ["session"] : ["weekly"] });
      return provider === "gemini" ? all.map((l) => l.replace(t("widgets.ai.widgets.n5HourSession"), t("widgets.ai.widgets.todaysQuota"))) : all;
    };
    const tip = () => [...lines(first, ctx.config.firstWindow), "", ...lines(second, ctx.config.secondWindow)];
    // Minimal tile: the first line's share.
    const fu = first === "gemini" ? geminiLimits(preview) : limitsOf(first, preview);
    const fw = ctx.config.firstWindow === "weekly" && first !== "gemini" ? fu.weekly : fu.session;
    return (
      <Tile icon={<FluentGlyph code={0xec4a} size={ui.app.icon - 4} color={ui.text} />} {...usedValue(fu, fw)} width={206} lead="round" tip={tipOf(ctx.instanceId, tip)} preview={preview}>
        <Column style={{ flex: 1, gap: rowGap(4) }}>
          <ProviderLine provider={first} window={ctx.config.firstWindow} preview={preview} />
          <ProviderLine provider={second} window={ctx.config.secondWindow} preview={preview} />
        </Column>
      </Tile>
    );
  },
});

export default [claude, claudePlan, codex, opencode, limits];
