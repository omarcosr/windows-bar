import { Column, Row, Text } from "@tarve/core";
import { launch } from "../../../services/windows";
import { numeric, ui } from "../../../theme";
import { Tile } from "../../ui";
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
import { LimitRow, Logo, StatusLine, brand, demo, showsData, ticker, type Brand } from "./shared";

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
  View({ state, preview }) {
    void state.tick;
    const u = limitsOf("claude", preview);
    return (
      <Tile width={164} padding={{ left: 10, right: 10 }} onClick={() => launch(CLAUDE_USAGE_URL)}>
        <Column style={{ flex: 1, gap: 4 }}>
          <Header brand="claude" plan={u.plan} right={showsData(u) ? resetLabel(u.session?.resetsAt ?? null) : ""} />
          {showsData(u) ? <LimitRow label="5h" window={u.session} meter={74} reset={false} /> : <StatusLine usage={u} />}
        </Column>
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
  View({ state, preview }) {
    void state.tick;
    const u = limitsOf("claude", preview);
    const top = (preview ? demo.claudeModels() : aiUsage.claudeModels)[0];
    return (
      <Tile width={214} padding={{ left: 10, right: 10 }} gap={10} onClick={() => launch(CLAUDE_USAGE_URL)}>
        <Column style={{ align: "center", gap: 3, width: 46 }}>
          <Logo brand="claude" size={16} />
          <Text size={9} color={ui.muted} style={{ textAlign: "center" }}>
            {top ? `${top.model}` : u.plan || "Claude"}
          </Text>
        </Column>
        {showsData(u) ? (
          <Column style={{ flex: 1, gap: 5 }}>
            <LimitRow label="5h" window={u.session} meter={40} />
            <LimitRow label="sem" window={u.weekly} meter={40} />
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
  View({ state, preview }) {
    void state.tick;
    const u = limitsOf("codex", preview);
    return (
      <Tile width={196} padding={{ left: 10, right: 10 }} onClick={() => launch(CODEX_USAGE_URL)}>
        <Column style={{ flex: 1, gap: 3 }}>
          {showsData(u) ? (
            <>
              <LimitRow label="5h" window={u.session} meter={44} />
              <LimitRow label="sem" window={u.weekly} meter={44} />
            </>
          ) : (
            <>
              <Header brand="codex" plan={u.plan} />
              <StatusLine usage={u} />
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
    return (
      <Tile width={168} padding={{ left: 10, right: 10 }}>
        <Column style={{ flex: 1, gap: 3 }}>
          <Header brand="opencode" right={showsData(u) ? (week ? "7 dias" : "5 h") : ""} />
          {showsData(u) ? (
            <Row style={{ align: "center", gap: 6 }}>
              <Text size={12} weight={700} color={ui.text} style={numeric}>
                {tokensLabel(tokens)}
              </Text>
              <Text size={10} color={ui.muted} style={{ ...numeric, flex: 1 }}>
                {cost > 0 ? `US$ ${cost.toFixed(2)}` : "tokens"}
              </Text>
              {top ? (
                <Text size={9} color={ui.faint}>
                  {top.model.length > 14 ? `${top.model.slice(0, 13)}…` : top.model}
                </Text>
              ) : null}
            </Row>
          ) : (
            <StatusLine usage={u} />
          )}
        </Column>
      </Tile>
    );
  },
});

// ---------------------------------------------------------------- AI limits (two providers)

type Provider = "claude" | "codex";
const providerOptions = [
  { value: "claude", label: "Claude" },
  { value: "codex", label: "ChatGPT (Codex)" },
] as const;
const windowOptions = [
  { value: "session", label: "Sessão de 5 h" },
  { value: "weekly", label: "Semanal" },
] as const;

function ProviderLine(props: { provider: Provider; window: string; preview: boolean }) {
  const u = limitsOf(props.provider, props.preview);
  const w = props.window === "weekly" ? u.weekly : u.session;
  return (
    <Row style={{ align: "center", gap: 6 }}>
      <Logo brand={props.provider} size={12} />
      {showsData(u) ? <LimitRow label={props.window === "weekly" ? "sem" : "5h"} window={w} meter={40} /> : <StatusLine usage={u} />}
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
    return ticker(ctx);
  },
  hidden: () => aiUsage.claude.status === "missing" && aiUsage.codex.status === "missing",
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
    const first = (ctx.config.first === "codex" ? "codex" : "claude") as Provider;
    const second = (ctx.config.second === "claude" ? "claude" : "codex") as Provider;
    return (
      <Tile width={206} padding={{ left: 10, right: 10 }}>
        <Column style={{ flex: 1, gap: 4 }}>
          <ProviderLine provider={first} window={ctx.config.firstWindow} preview={preview} />
          <ProviderLine provider={second} window={ctx.config.secondWindow} preview={preview} />
        </Column>
      </Tile>
    );
  },
});

export default [claude, claudePlan, codex, opencode, limits];
