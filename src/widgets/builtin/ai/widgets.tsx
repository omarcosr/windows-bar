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

const CLAUDE_SOURCE = "API de uso da Anthropic, com o login do Claude Code";
const CODEX_SOURCE = "limites que o Codex CLI recebeu na última sessão";
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
  name: "Uso do Claude",
  description: "Limite da sessão de 5 h do Claude (Pro/Max) e quando ele renova. Lê o login do Claude Code.",
  category: "productivity",
  defaultConfig: {},
  setup(ctx) {
    ctx.onDispose(claudePoller.acquire());
    return ticker(ctx);
  },
  hidden: () => aiUsage.claude.status === "missing",
  menu: () => [
    [
      { label: "Atualizar agora", icon: "download", onSelect: () => void refreshClaude() },
      { label: "Abrir uso no claude.ai", icon: "star", onSelect: () => launch(CLAUDE_USAGE_URL) },
    ],
  ],
  View({ state, ctx, preview }) {
    void state.tick;
    const u = limitsOf("claude", preview);
    const tip = () => limitTip({ name: "Claude", usage: u, source: CLAUDE_SOURCE, preview, click: "Clique para abrir o uso no claude.ai" });
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
  name: "Plano do Claude",
  description: "Sessão de 5 h, limite semanal e o modelo mais usado nos últimos 7 dias no Claude Code.",
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
        label: "Atualizar agora",
        icon: "download",
        onSelect: () => {
          refreshClaudeModels();
          void refreshClaude();
        },
      },
      { label: "Abrir uso no claude.ai", icon: "star", onSelect: () => launch(CLAUDE_USAGE_URL) },
    ],
  ],
  View({ state, ctx, preview }) {
    void state.tick;
    const u = limitsOf("claude", preview);
    const top = (preview ? demo.claudeModels() : aiUsage.claudeModels)[0];
    const tip = () => {
      const lines = limitTip({ name: "Claude", usage: u, source: CLAUDE_SOURCE, preview, click: "Clique para abrir o uso no claude.ai" });
      if (top) lines.splice(lines.length - 2, 0, `Modelo mais usado nos últimos 7 dias: ${top.model} (${top.share}% dos tokens do Claude Code)`);
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
            <LimitRow label="sem" window={u.weekly} meter={36} />
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
  name: "Uso do ChatGPT (Codex)",
  description: "Limites de 5 h e semanal do plano ChatGPT, como o Codex CLI os recebeu na última sessão.",
  category: "productivity",
  defaultConfig: {},
  setup(ctx) {
    ctx.onDispose(codexPoller.acquire());
    return ticker(ctx);
  },
  hidden: () => aiUsage.codex.status === "missing",
  menu: () => [
    [
      { label: "Atualizar agora", icon: "download", onSelect: () => refreshCodex() },
      { label: "Abrir uso no ChatGPT", icon: "star", onSelect: () => launch(CODEX_USAGE_URL) },
    ],
  ],
  View({ state, ctx, preview }) {
    void state.tick;
    const u = limitsOf("codex", preview);
    const tip = () => limitTip({ name: "ChatGPT (Codex)", usage: u, source: CODEX_SOURCE, preview, click: "Clique para abrir o uso no ChatGPT" });
    return (
      <Tile icon={<Logo brand="codex" size={ui.app.icon} />} {...usedValue(u, u.session)} width={196} onClick={() => launch(CODEX_USAGE_URL)} tip={tipOf(ctx.instanceId, tip)} preview={preview}>
        <Column style={{ flex: 1, gap: rowGap(3) }}>
          {showsData(u) ? (
            <>
              <LimitRow label="5h" window={u.session} meter={44} />
              <LimitRow label="sem" window={u.weekly} meter={44} />
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
  name: "Uso do OpenCode",
  description: "Tokens e custo do OpenCode nas últimas 5 h e 7 dias, e o modelo mais usado. Lido do banco local.",
  category: "productivity",
  defaultConfig: { period: "5h" },
  settings: [
    {
      kind: "choice",
      key: "period",
      label: "Destaque",
      options: [
        { value: "5h", label: "Últimas 5 h" },
        { value: "7d", label: "Últimos 7 dias" },
      ],
    },
  ],
  setup(ctx) {
    ctx.onDispose(opencodePoller.acquire());
    return {};
  },
  hidden: () => aiUsage.opencode.status === "missing",
  menu: () => [[{ label: "Atualizar agora", icon: "download", onSelect: () => void refreshOpencode() }]],
  View({ ctx, preview }) {
    const u = preview ? demo.opencode() : aiUsage.opencode;
    const week = ctx.config.period === "7d";
    const tokens = week ? u.tokens7d : u.tokens5h;
    const cost = week ? u.cost7d : u.cost5h;
    const top = u.top[0];
    const tip = () => [
      `OpenCode, ${week ? "últimos 7 dias" : "últimas 5 h"}: ${tokens.toLocaleString("pt-BR")} tokens${cost > 0 ? ` · US$ ${cost.toFixed(2)} (custo que o OpenCode registrou)` : ""}`,
      `Últimas 5 h: ${tokensLabel(u.tokens5h)} · últimos 7 dias: ${tokensLabel(u.tokens7d)}, ${u.messages7d} mensagens`,
      ...(top ? [`Modelo mais usado: ${top.model} (${top.share}% dos tokens)`] : []),
      preview ? "Dados de exemplo" : `Fonte: banco local do OpenCode${u.updated ? `, lido ${whenLabel(u.updated)}` : ""}`,
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
                {cost > 0 ? `US$ ${cost.toFixed(2).replace(".", ",")}` : "tokens"}
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
  { value: "gemini", label: "Gemini CLI (cota diária)" },
] as const;
/** The session's share used, for a minimal tile's value: "37%" in the colour of its meter. */
function usedValue(u: Parameters<typeof showsData>[0], w: { used: number } | null | undefined) {
  if (!showsData(u) || !w) return {};
  return { value: `${w.used}%`, valueColor: tone(w.used) };
}

const asProvider = (value: string, fallback: Provider): Provider => (value === "claude" || value === "codex" || value === "gemini" ? value : fallback);
const windowOptions = [
  { value: "session", label: "Sessão de 5 h" },
  { value: "weekly", label: "Semanal" },
] as const;

function ProviderLine(props: { provider: Provider; window: string; preview: boolean }) {
  const u = props.provider === "gemini" ? geminiLimits(props.preview) : limitsOf(props.provider, props.preview);
  const daily = props.provider === "gemini";
  const w = props.window === "weekly" && !daily ? u.weekly : u.session;
  return (
    <Row style={{ align: "center", gap: 6 }}>
      <Logo brand={props.provider} size={12} />
      {showsData(u) ? <LimitRow label={daily ? "dia" : props.window === "weekly" ? "sem" : "5h"} window={w} meter={40} /> : <StatusLine usage={u} />}
    </Row>
  );
}

const limits = defineWidget({
  type: "ai-limits",
  name: "Limites de IA",
  description: "Dois provedores lado a lado (Claude e ChatGPT/Codex) com o quanto já foi usado e quando renova.",
  category: "productivity",
  defaultConfig: { first: "claude", firstWindow: "session", second: "codex", secondWindow: "session" },
  settings: [
    { kind: "choice", key: "first", label: "Primeira linha", options: providerOptions },
    { kind: "choice", key: "firstWindow", label: "Janela da primeira", options: windowOptions },
    { kind: "choice", key: "second", label: "Segunda linha", options: providerOptions },
    { kind: "choice", key: "secondWindow", label: "Janela da segunda", options: windowOptions },
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
        label: "Atualizar agora",
        icon: "download",
        onSelect: () => {
          refreshCodex();
          void refreshClaude();
        },
      },
      { label: "Abrir uso no claude.ai", icon: "star", onSelect: () => launch(CLAUDE_USAGE_URL) },
      { label: "Abrir uso no ChatGPT", icon: "star", onSelect: () => launch(CODEX_USAGE_URL) },
    ],
  ],
  View({ state, ctx, preview }) {
    void state.tick;
    const first = asProvider(ctx.config.first, "claude");
    const second = asProvider(ctx.config.second, "codex");
    const lines = (provider: Provider, window: string) => {
      const usage = provider === "gemini" ? geminiLimits(preview) : limitsOf(provider, preview);
      const name = provider === "gemini" ? "Gemini CLI (cota diária)" : brand[provider].name;
      const source = provider === "claude" ? CLAUDE_SOURCE : provider === "codex" ? CODEX_SOURCE : "cota do login Google do Gemini CLI";
      const all = limitTip({ name, usage, source, preview, windows: provider === "gemini" || window !== "weekly" ? ["session"] : ["weekly"] });
      return provider === "gemini" ? all.map((l) => l.replace("Sessão de 5 h", "Cota do dia")) : all;
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
