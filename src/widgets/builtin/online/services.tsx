import { Column, Row, Text, View, store } from "@tarve/core";
import { launch } from "../../../services/windows";
import { graphql, postJson } from "../../../services/online-http";
import { refreshWidget, remoteJson as getJson } from "../../../services/remote";
import { numeric, ui } from "../../../theme";
import { Sparkline, Tile } from "../../ui";
import { defineWidget } from "../../types";
import type { DockMenuItem } from "../../../menu/dock-menu";
import { Badge, Stat, Title, Trend, compact, errorText, percentChange, refreshNow, registerRefresh } from "./common";

const DAY_MS = 86_400_000;

function ymd(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function daysAgo(n: number) {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - n);
}

function localZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Shared tile: brand, title, big number, sparkline + trend. */
function MetricTile(props: {
  color: string;
  letter: string;
  fg?: string;
  title: string;
  value: string;
  series: readonly number[];
  change: number | null;
  demo: boolean;
  error: string;
  sparkColor?: string;
  onClick: () => void;
}) {
  return (
    <Tile width={176} padding={{ left: 10, right: 10, top: 5, bottom: 4 }} onClick={props.onClick}>
      <Column style={{ flex: 1, gap: 1 }}>
        <Row style={{ align: "center", gap: 6 }}>
          <Badge color={props.color} letter={props.letter} fg={props.fg} size={14} />
          <Title text={props.title} demo={props.demo} error={props.error} />
          <Text size={12} weight={700} color={ui.text} style={numeric}>
            {props.value}
          </Text>
        </Row>
        <Row style={{ align: "end", gap: 6 }}>
          <Sparkline values={props.series} width={112} height={16} color={props.sparkColor ?? ui.green} />
          <View style={{ flex: 1, align: "end" }}>{props.change === null ? null : <Trend change={props.change} />}</View>
        </Row>
      </Column>
    </Tile>
  );
}

// ---------- Linear ----------

interface LinearIssue {
  identifier: string;
  title: string;
  url: string;
  state: { type: string; name: string };
}

const DEMO_ISSUES: LinearIssue[] = [
  { identifier: "ENG-142", title: "Corrigir login com SSO", url: "https://linear.app", state: { type: "started", name: "Em andamento" } },
  { identifier: "ENG-139", title: "Cache das rotas da API", url: "https://linear.app", state: { type: "started", name: "Em andamento" } },
  { identifier: "ENG-131", title: "Revisar onboarding", url: "https://linear.app", state: { type: "unstarted", name: "Todo" } },
  { identifier: "ENG-120", title: "Atualizar dependências", url: "https://linear.app", state: { type: "backlog", name: "Backlog" } },
];

const LINEAR_QUERY = `query { viewer { assignedIssues(first: 100, filter: { state: { type: { nin: ["completed", "canceled"] } } }) { nodes { identifier title url state { type name } } } } }`;

const linear = defineWidget({
  type: "online-linear",
  name: "Linear",
  description: "Issues atribuídas a você e quantas estão em andamento.",
  category: "productivity",
  defaultConfig: { apiKey: "" },
  settings: [
    {
      kind: "text",
      key: "apiKey",
      label: "Chave de API pessoal do Linear",
      description: "Settings → Security & access → Personal API keys. Vazia mostra dados de exemplo.",
      placeholder: "lin_api_…",
      secret: true,
    },
  ],
  setup(ctx) {
    const state = store({ issues: DEMO_ISSUES, demo: true, error: "" });
    const load = async () => {
      const key = String(ctx.config.apiKey || "").trim();
      if (!key) {
        Object.assign(state, { issues: DEMO_ISSUES, demo: true, error: "" });
        return;
      }
      try {
        const data = await graphql<{ viewer: { assignedIssues: { nodes: LinearIssue[] } } }>(
          "https://api.linear.app/graphql",
          LINEAR_QUERY,
          {},
          { Authorization: key },
          "Linear",
        );
        Object.assign(state, { issues: data.viewer.assignedIssues.nodes, demo: false, error: "" });
      } catch (error) {
        state.error = errorText(error);
      }
    };
    registerRefresh(state, load);
    refreshWidget(ctx, 5 * 60_000, load, () => !!state.error);
    return state;
  },
  menu({ state }) {
    const started = state.issues.filter((i) => i.state.type === "started");
    const rest = state.issues.filter((i) => i.state.type !== "started");
    const item = (i: LinearIssue) => ({ label: `${i.identifier} · ${i.title}`, onSelect: () => launch(i.url) });
    return [
      [...started, ...rest].slice(0, 8).map(item),
      [
        { label: "Abrir Linear", icon: "chevron-right", onSelect: () => launch("https://linear.app") },
        { label: "Atualizar agora", icon: "download", onSelect: () => refreshNow(state) },
      ],
    ];
  },
  View({ state }) {
    const started = state.issues.filter((i) => i.state.type === "started").length;
    return (
      <Tile width={150} padding={{ left: 10, right: 10 }} onClick={() => launch("https://linear.app")}>
        <Column style={{ flex: 1, gap: 1 }}>
          <Row style={{ align: "center", gap: 6 }}>
            <Badge color="#5e6ad2" letter="L" size={14} />
            <Title text="Linear" demo={state.demo} error={state.error} />
          </Row>
          <Row style={{ align: "center", gap: 8 }}>
            <Stat label="minhas" value={String(state.issues.length)} />
            <Stat label="em andamento" value={String(started)} color={started ? "#f2c94c" : ui.text} />
          </Row>
        </Column>
      </Tile>
    );
  },
});

// ---------- Supabase ----------

const SUPABASE_SERVICES = ["auth", "db", "rest", "realtime", "storage"];

interface ApiCounts {
  timestamp: string;
  total_auth_requests?: number;
  total_rest_requests?: number;
  total_storage_requests?: number;
  total_realtime_requests?: number;
}

const supabase = defineWidget({
  type: "online-supabase",
  name: "Supabase",
  description: "Saúde dos serviços do projeto e requisições nas últimas 24 h (Management API).",
  category: "productivity",
  defaultConfig: { token: "", projectRef: "" },
  settings: [
    {
      kind: "text",
      key: "token",
      label: "Access token do Supabase",
      description: "Account → Access Tokens (sbp_…). Vazio mostra dados de exemplo.",
      placeholder: "sbp_…",
      secret: true,
    },
    { kind: "text", key: "projectRef", label: "Project ref", placeholder: "abcdefghijklmnop" },
  ],
  setup(ctx) {
    const demoSeries = [120, 180, 160, 240, 310, 280, 350, 420, 390, 460, 510, 480];
    const state = store({
      healthy: 5,
      services: 5,
      down: [] as string[],
      requests: 48_210,
      series: demoSeries,
      demo: true,
      error: "",
    });
    const load = async () => {
      const token = String(ctx.config.token || "").trim();
      const ref = String(ctx.config.projectRef || "").trim();
      if (!token || !ref) {
        Object.assign(state, { healthy: 5, services: 5, down: [], requests: 48_210, series: demoSeries, demo: true, error: "" });
        return;
      }
      try {
        const h = { Authorization: `Bearer ${token}` };
        const base = `https://api.supabase.com/v1/projects/${encodeURIComponent(ref)}`;
        const query = SUPABASE_SERVICES.map((s) => `services=${s}`).join("&");
        const [health, usage] = await Promise.all([
          getJson<{ name: string; healthy: boolean; status: string }[]>(`${base}/health?${query}`, h, "Supabase").then((r) => r.body),
          getJson<{ result?: ApiCounts[] }>(`${base}/analytics/endpoints/usage.api-counts?interval=1day`, h, "Supabase")
            .then((r) => r.body.result ?? [])
            .catch(() => null),
        ]);
        state.services = health.length;
        state.healthy = health.filter((s) => s.healthy).length;
        state.down = health.filter((s) => !s.healthy).map((s) => s.name);
        if (usage) {
          const sorted = [...usage].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
          const totals = sorted.map(
            (b) => (b.total_auth_requests ?? 0) + (b.total_rest_requests ?? 0) + (b.total_storage_requests ?? 0) + (b.total_realtime_requests ?? 0),
          );
          state.series = totals;
          state.requests = totals.reduce((a, b) => a + b, 0);
        }
        state.demo = false;
        state.error = "";
      } catch (error) {
        state.error = errorText(error);
      }
    };
    registerRefresh(state, load);
    refreshWidget(ctx, 5 * 60_000, load, () => !!state.error);
    return state;
  },
  menu({ state, ctx }) {
    const ref = String(ctx.config.projectRef || "").trim();
    const sections: DockMenuItem[][] = [
      state.down.length ? state.down.map((name) => ({ label: `${name}: com problema`, danger: true, onSelect: () => {} })) : [],
      [
        {
          label: "Abrir projeto",
          icon: "chevron-right",
          onSelect: () => launch(ref ? `https://supabase.com/dashboard/project/${ref}` : "https://supabase.com/dashboard"),
        },
        { label: "Atualizar agora", icon: "download", onSelect: () => refreshNow(state) },
      ],
    ];
    return sections.filter((s) => s.length);
  },
  View({ state, ctx }) {
    const ok = state.healthy === state.services;
    const ref = String(ctx.config.projectRef || "").trim();
    return (
      <MetricTile
        color="#1c1c1c"
        letter="S"
        fg="#3ecf8e"
        title={ok ? "Supabase" : `${state.services - state.healthy} com falha`}
        value={`${compact(state.requests)} req`}
        series={state.series}
        change={null}
        demo={state.demo}
        error={state.error}
        sparkColor={ok ? "#3ecf8e" : ui.danger}
        onClick={() => launch(ref ? `https://supabase.com/dashboard/project/${ref}` : "https://supabase.com/dashboard")}
      />
    );
  },
});

// ---------- Resend ----------

interface ResendEmail {
  id: string;
  created_at: string;
  last_event?: string;
}

const DELIVERED = new Set(["delivered", "opened", "clicked"]);

const resend = defineWidget({
  type: "online-resend",
  name: "Resend",
  description: "E-mails enviados nos últimos 7 dias e quantos foram entregues.",
  category: "productivity",
  defaultConfig: { apiKey: "" },
  settings: [
    {
      kind: "text",
      key: "apiKey",
      label: "Chave de API do Resend",
      description: "Precisa de permissão Full access para listar e-mails. Vazia mostra dados de exemplo.",
      placeholder: "re_…",
      secret: true,
    },
  ],
  setup(ctx) {
    const demoSeries = [180, 210, 160, 240, 260, 230, 300];
    const state = store({ sent: 1580, delivered: 1552, series: demoSeries, demo: true, error: "" });
    const load = async () => {
      const key = String(ctx.config.apiKey || "").trim();
      if (!key) {
        Object.assign(state, { sent: 1580, delivered: 1552, series: demoSeries, demo: true, error: "" });
        return;
      }
      try {
        const since = daysAgo(6).getTime();
        const days = new Array(7).fill(0);
        let sent = 0;
        let delivered = 0;
        let after = "";
        for (let page = 0; page < 20; page++) {
          const { body } = await getJson<{ data: ResendEmail[]; has_more?: boolean }>(
            `https://api.resend.com/emails?limit=100${after ? `&after=${after}` : ""}`,
            { Authorization: `Bearer ${key}` },
            "Resend",
          );
          let older = false;
          for (const email of body.data) {
            const t = Date.parse(email.created_at.replace(" ", "T"));
            if (!(t >= since)) {
              older = true;
              continue;
            }
            sent++;
            if (DELIVERED.has(email.last_event ?? "")) delivered++;
            days[Math.min(6, Math.floor((t - since) / DAY_MS))]++;
          }
          if (older || !body.has_more || body.data.length === 0) break;
          after = body.data[body.data.length - 1]!.id;
          // Resend allows 2 requests per second.
          await new Promise((r) => setTimeout(r, 600));
        }
        Object.assign(state, { sent, delivered, series: days, demo: false, error: "" });
      } catch (error) {
        state.error = errorText(error);
      }
    };
    registerRefresh(state, load);
    refreshWidget(ctx, 15 * 60_000, load, () => !!state.error);
    return state;
  },
  menu({ state }) {
    return [
      [
        { label: "Abrir e-mails no Resend", icon: "chevron-right", onSelect: () => launch("https://resend.com/emails") },
        { label: "Atualizar agora", icon: "download", onSelect: () => refreshNow(state) },
      ],
    ];
  },
  View({ state }) {
    const rate = state.sent ? Math.round((state.delivered / state.sent) * 100) : 0;
    return (
      <Tile width={196} padding={{ left: 10, right: 10, top: 5, bottom: 4 }} onClick={() => launch("https://resend.com/emails")}>
        <Column style={{ flex: 1, gap: 1 }}>
          <Row style={{ align: "center", gap: 6 }}>
            <Badge color="#000" letter="R" size={14} />
            <Title text="Resend · 7 dias" demo={state.demo} error={state.error} />
          </Row>
          <Row style={{ align: "end", gap: 8 }}>
            <Stat label="enviados" value={compact(state.sent)} />
            <Stat label={`entregues ${rate}%`} value={compact(state.delivered)} color={ui.green} />
          </Row>
        </Column>
      </Tile>
    );
  },
});

// ---------- Plausible ----------

interface PlausibleResult {
  results: { dimensions: string[]; metrics: number[] }[];
}

const plausible = defineWidget({
  type: "online-plausible",
  name: "Plausible",
  description: "Visitantes nos últimos 7 dias e a variação contra a semana anterior (Stats API v2).",
  category: "productivity",
  defaultConfig: { apiKey: "", siteId: "", host: "https://plausible.io" },
  settings: [
    {
      kind: "text",
      key: "apiKey",
      label: "Chave da Stats API",
      description: "Account settings → API Keys (tipo Stats API). Vazia mostra dados de exemplo.",
      secret: true,
    },
    { kind: "text", key: "siteId", label: "Site (domínio)", placeholder: "exemplo.com" },
    { kind: "text", key: "host", label: "Servidor", description: "Para Plausible auto-hospedado.", placeholder: "https://plausible.io" },
  ],
  setup(ctx) {
    const demoSeries = [410, 455, 390, 520, 610, 580, 640];
    const state = store({ visitors: 3605, change: 18, series: demoSeries, demo: true, error: "" });
    const load = async () => {
      const key = String(ctx.config.apiKey || "").trim();
      const site = String(ctx.config.siteId || "").trim();
      if (!key || !site) {
        Object.assign(state, { visitors: 3605, change: 18, series: demoSeries, demo: true, error: "" });
        return;
      }
      try {
        const host = (String(ctx.config.host || "").trim() || "https://plausible.io").replace(/\/+$/, "");
        const url = `${host}/api/v2/query`;
        const h = { Authorization: `Bearer ${key}` };
        const week = [ymd(daysAgo(6)), ymd(daysAgo(0))];
        const before = [ymd(daysAgo(13)), ymd(daysAgo(7))];
        const [current, previous, daily] = await Promise.all([
          postJson<PlausibleResult>(url, { site_id: site, metrics: ["visitors"], date_range: week }, h, "Plausible"),
          postJson<PlausibleResult>(url, { site_id: site, metrics: ["visitors"], date_range: before }, h, "Plausible"),
          postJson<PlausibleResult>(url, { site_id: site, metrics: ["visitors"], date_range: week, dimensions: ["time:day"] }, h, "Plausible"),
        ]);
        const visitors = current.results[0]?.metrics[0] ?? 0;
        const prev = previous.results[0]?.metrics[0] ?? 0;
        const byDay = new Map(daily.results.map((r) => [r.dimensions[0]!.slice(0, 10), r.metrics[0] ?? 0]));
        const series = Array.from({ length: 7 }, (_, i) => byDay.get(ymd(daysAgo(6 - i))) ?? 0);
        Object.assign(state, { visitors, change: percentChange(visitors, prev), series, demo: false, error: "" });
      } catch (error) {
        state.error = errorText(error);
      }
    };
    registerRefresh(state, load);
    refreshWidget(ctx, 10 * 60_000, load, () => !!state.error);
    return state;
  },
  menu({ state, ctx }) {
    return [
      [
        { label: "Abrir painel do Plausible", icon: "chevron-right", onSelect: () => launch(plausibleUrl(ctx.config)) },
        { label: "Atualizar agora", icon: "download", onSelect: () => refreshNow(state) },
      ],
    ];
  },
  View({ state, ctx }) {
    return (
      <MetricTile
        color="#5850ec"
        letter="P"
        title={String(ctx.config.siteId || "Plausible")}
        value={compact(state.visitors)}
        series={state.series}
        change={state.change}
        demo={state.demo}
        error={state.error}
        sparkColor="#818cf8"
        onClick={() => launch(plausibleUrl(ctx.config))}
      />
    );
  },
});

function plausibleUrl(config: { siteId: string; host: string }) {
  const host = (String(config.host || "").trim() || "https://plausible.io").replace(/\/+$/, "");
  const site = String(config.siteId || "").trim();
  return site ? `${host}/${encodeURIComponent(site)}` : host;
}

// ---------- Dub ----------

const dub = defineWidget({
  type: "online-dub",
  name: "Dub",
  description: "Cliques nos seus links nos últimos 7 dias e a variação contra a semana anterior.",
  category: "productivity",
  defaultConfig: { apiKey: "" },
  settings: [
    {
      kind: "text",
      key: "apiKey",
      label: "Chave de API do Dub",
      description: "Workspace → Settings → API Keys (leitura de analytics). Vazia mostra dados de exemplo.",
      placeholder: "dub_…",
      secret: true,
    },
  ],
  setup(ctx) {
    const demoSeries = [88, 120, 96, 140, 132, 170, 158];
    const state = store({ clicks: 904, change: 12, series: demoSeries, demo: true, error: "" });
    const load = async () => {
      const key = String(ctx.config.apiKey || "").trim();
      if (!key) {
        Object.assign(state, { clicks: 904, change: 12, series: demoSeries, demo: true, error: "" });
        return;
      }
      try {
        const tz = encodeURIComponent(localZone());
        const { body } = await getJson<{ start: string; clicks: number }[]>(
          `https://api.dub.co/analytics?event=clicks&groupBy=timeseries&interval=30d&timezone=${tz}`,
          { Authorization: `Bearer ${key}` },
          "Dub",
        );
        const days = [...body].sort((a, b) => a.start.localeCompare(b.start)).map((d) => d.clicks);
        const week = days.slice(-7);
        const prev = days.slice(-14, -7);
        const clicks = week.reduce((a, b) => a + b, 0);
        const before = prev.reduce((a, b) => a + b, 0);
        Object.assign(state, { clicks, change: percentChange(clicks, before), series: week, demo: false, error: "" });
      } catch (error) {
        state.error = errorText(error);
      }
    };
    registerRefresh(state, load);
    refreshWidget(ctx, 10 * 60_000, load, () => !!state.error);
    return state;
  },
  menu({ state }) {
    return [
      [
        { label: "Abrir Dub", icon: "chevron-right", onSelect: () => launch("https://app.dub.co") },
        { label: "Atualizar agora", icon: "download", onSelect: () => refreshNow(state) },
      ],
    ];
  },
  View({ state }) {
    return (
      <MetricTile
        color="#000"
        letter="D"
        title="Dub · cliques"
        value={compact(state.clicks)}
        series={state.series}
        change={state.change}
        demo={state.demo}
        error={state.error}
        sparkColor="#f97316"
        onClick={() => launch("https://app.dub.co")}
      />
    );
  },
});

export default [linear, supabase, resend, plausible, dub];
