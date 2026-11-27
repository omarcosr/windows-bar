import { Column, Row, Text, View, store, type Child } from "@tarve/core";
import { launch } from "../../../services/windows";
import { graphql } from "../../../services/online-http";
import { nextLinkOf, refreshWidget, remoteJson as getJson } from "../../../services/remote";
import { numeric, ui } from "../../../theme";
import { Tile, compactView, compactWidth } from "../../ui";
import { BrandIcon } from "../../brand-icons";
import { defineWidget } from "../../types";
import { Badge, Stat, Title, compact, errorText, refreshNow, registerRefresh, sourceLines } from "./common";

import { t, language } from "../../../i18n";
const API = "https://api.github.com";
const headers = (token: string) => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
});

const tokenSetting = {
  kind: "text" as const,
  key: "token" as const,
  label: t("widgets.online.github.githubToken"),
  description: t("widgets.online.github.personalAccessTokenClassic"),
  placeholder: t("widgets.online.github.ghpOrGithubPat"),
  secret: true,
};

/** Unread notifications (GET /notifications, all=false), counted across pages. */
async function unreadNotifications(token: string) {
  let url: string | null = `${API}/notifications?per_page=50`;
  let count = 0;
  for (let page = 0; url && page < 10; page++) {
    const { body, res } = await getJson<unknown[]>(url, headers(token), "GitHub");
    count += body.length;
    url = nextLinkOf(res);
  }
  return count;
}

function GithubMark(props: { size?: number }) {
  return <Badge color="#24292f" letter="G" size={props.size} />;
}

// ---------- GitHub: notificações ----------

const github = defineWidget({
  type: "online-github",
  name: "GitHub",
  description: t("widgets.online.github.unreadGithubNotificationsClick"),
  category: "productivity",
  defaultConfig: { token: "" },
  settings: [tokenSetting],
  setup(ctx) {
    const state = store({ unread: 7, demo: true, error: "" });
    const load = async () => {
      const token = String(ctx.config.token || "").trim();
      if (!token) {
        Object.assign(state, { unread: 7, demo: true, error: "" });
        return;
      }
      try {
        state.unread = await unreadNotifications(token);
        state.demo = false;
        state.error = "";
      } catch (error) {
        state.error = errorText(error);
      }
    };
    registerRefresh(state, load);
    refreshWidget(ctx, 2 * 60_000, load, () => !!state.error);
    return state;
  },
  menu({ state }) {
    return [
      [
        { label: t("widgets.online.github.openNotifications"), icon: "bell", onSelect: () => launch("https://github.com/notifications") },
        { label: t("widgets.online.github.refreshNow"), icon: "download", onSelect: () => refreshNow(state) },
      ],
    ];
  },
  View({ state, ctx, preview }) {
    const l = ui.tile.lines;
    const tip = () => [
      t("widgets.online.github.unreadNotifications", { unread: state.unread }),
      ...sourceLines(state, t("widgets.online.github.githubApiNotifications"), t("widgets.online.github.clickToOpenNotifications"), t("widgets.online.github.enterTokenInSettings")),
    ];
    return (
      <Tile icon={<BrandIcon brand="github" />} width={112} value={state.unread > 499 ? "500+" : String(state.unread)} valueColor={state.unread ? ui.text : ui.muted} onClick={() => launch("https://github.com/notifications")} tip={{ id: `tip:${ctx.instanceId}`, lines: tip }} preview={preview}>
        <GithubMark size={18} />
        <Column style={{ flex: 1, gap: l.gap }}>
          <Text size={l.primary} weight={700} color={state.unread ? ui.text : ui.muted} style={numeric}>
            {state.unread > 499 ? "500+" : String(state.unread)}
          </Text>
          <Text size={l.secondary - 2} color={state.error ? ui.danger : ui.muted}>
            {state.error ? t("widgets.online.github.error") : state.demo ? t("widgets.online.github.unreadDemo") : t("widgets.online.github.unread")}
          </Text>
        </Column>
      </Tile>
    );
  },
});

// ---------- GitHub: visão geral ----------

const overview = defineWidget({
  type: "online-github-overview",
  name: t("widgets.online.github.githubOverview"),
  description: t("widgets.online.github.unreadNotificationsYourOpen"),
  category: "productivity",
  defaultConfig: { token: "" },
  settings: [tokenSetting],
  setup(ctx) {
    const state = store({ login: "", unread: 7, prs: 3, stars: 1284, demo: true, error: "" });
    const load = async () => {
      const token = String(ctx.config.token || "").trim();
      if (!token) {
        Object.assign(state, { login: "", unread: 7, prs: 3, stars: 1284, demo: true, error: "" });
        return;
      }
      try {
        const h = headers(token);
        if (!state.login) state.login = (await getJson<{ login: string }>(`${API}/user`, h, "GitHub")).body.login;
        const q = encodeURIComponent(`is:pr is:open author:${state.login}`);
        const [unread, prs, stars] = await Promise.all([
          unreadNotifications(token),
          getJson<{ total_count: number }>(`${API}/search/issues?q=${q}&per_page=1`, h, "GitHub").then((r) => r.body.total_count),
          (async () => {
            let url: string | null = `${API}/user/repos?per_page=100&affiliation=owner`;
            let total = 0;
            for (let page = 0; url && page < 20; page++) {
              const { body, res } = await getJson<{ stargazers_count: number }[]>(url, h, "GitHub");
              for (const repo of body) total += repo.stargazers_count;
              url = nextLinkOf(res);
            }
            return total;
          })(),
        ]);
        Object.assign(state, { unread, prs, stars, demo: false, error: "" });
      } catch (error) {
        state.error = errorText(error);
      }
    };
    registerRefresh(state, load);
    refreshWidget(ctx, 5 * 60_000, load, () => !!state.error);
    return state;
  },
  menu({ state }) {
    return [
      [
        { label: t("widgets.online.github.openNotifications"), icon: "bell", onSelect: () => launch("https://github.com/notifications") },
        { label: t("widgets.online.github.myPullRequests"), icon: "chevron-right", onSelect: () => launch("https://github.com/pulls") },
        { label: t("widgets.online.github.refreshNow"), icon: "download", onSelect: () => refreshNow(state) },
      ],
    ];
  },
  View({ state, ctx, preview }) {
    const tip = () => [
      t("widgets.online.github.unreadNotifications2", { p0: state.login || "GitHub", unread: state.unread }),
      t("widgets.online.github.ofYourPullRequests", { p0: state.prs }),
      t("widgets.online.github.starsAcrossYourRepositories", { p0: state.stars.toLocaleString(language) }),
      ...sourceLines(state, t("widgets.online.github.githubApi"), t("widgets.online.github.clickToOpenNotifications"), t("widgets.online.github.enterTokenInSettings")),
    ];
    return (
      <Tile icon={<BrandIcon brand="github" />} width={176} value={String(state.unread)} valueColor={state.unread ? ui.blue : ui.muted} onClick={() => launch("https://github.com/notifications")} tip={{ id: `tip:${ctx.instanceId}`, lines: tip }} preview={preview}>
        <Column style={{ flex: 1, gap: 1 }}>
          <Row style={{ align: "center", gap: 6 }}>
            <GithubMark size={14} />
            <Title text={state.login || "GitHub"} demo={state.demo} error={state.error} />
          </Row>
          <Row style={{ align: "center", gap: 8 }}>
            <Stat label="notif." value={String(state.unread)} color={state.unread ? ui.blue : ui.text} />
            <Stat label="PRs" value={String(state.prs)} />
            <Stat label="★" value={compact(state.stars)} />
          </Row>
        </Column>
      </Tile>
    );
  },
});

// ---------- GitHub: atividade ----------

interface Day {
  count: number;
  date: string;
}

const LEVELS = ["#0e4429", "#006d32", "#26a641", "#39d353"];

function demoDays(): Day[] {
  const out: Day[] = [];
  const today = new Date();
  let seed = 7;
  for (let i = 7 * 26 - 1; i >= 0; i--) {
    seed = (seed * 9301 + 49297) % 233280;
    const r = seed / 233280;
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    out.push({ count: i < 9 ? 1 + Math.floor(r * 6) : r < 0.3 ? 0 : Math.floor(r * 10), date: isoDate(d) });
  }
  return out;
}

function isoDate(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Days in a row with contributions ending today (or yesterday, if today is still empty). */
export function currentStreak(days: readonly Day[]) {
  let i = days.length - 1;
  if (i >= 0 && days[i]!.count === 0) i--;
  let streak = 0;
  for (; i >= 0 && days[i]!.count > 0; i--) streak++;
  return streak;
}

const CALENDAR = `query { viewer { login contributionsCollection { contributionCalendar { totalContributions weeks { contributionDays { contributionCount date } } } } } }`;

/** The weeks side by side; its own component, so a compact tile keeps it a row (see compactTree). */
function WeekGrid(props: { gap: number; children: Child }) {
  return <Row style={{ gap: props.gap }}>{props.children}</Row>;
}

const activity = defineWidget({
  type: "online-github-activity",
  name: "GitHub: atividade",
  description: t("widgets.online.github.contributionGridForLast"),
  category: "productivity",
  defaultConfig: { token: "", weeks: "16" },
  settings: [
    tokenSetting,
    {
      kind: "choice",
      key: "weeks",
      label: t("widgets.online.github.weeksInGrid"),
      options: [
        { value: "8", label: "8" },
        { value: "16", label: "16" },
        { value: "26", label: "26" },
      ],
    },
  ],
  setup(ctx) {
    const state = store({ login: "", days: demoDays(), total: 1432, demo: true, error: "" });
    const load = async () => {
      const token = String(ctx.config.token || "").trim();
      if (!token) {
        Object.assign(state, { login: "", days: demoDays(), total: 1432, demo: true, error: "" });
        return;
      }
      try {
        const data = await graphql<{
          viewer: {
            login: string;
            contributionsCollection: {
              contributionCalendar: { totalContributions: number; weeks: { contributionDays: { contributionCount: number; date: string }[] }[] };
            };
          };
        }>(`${API}/graphql`, CALENDAR, {}, headers(token), "GitHub");
        const cal = data.viewer.contributionsCollection.contributionCalendar;
        const days = cal.weeks.flatMap((w) => w.contributionDays.map((d) => ({ count: d.contributionCount, date: d.date })));
        Object.assign(state, { login: data.viewer.login, days, total: cal.totalContributions, demo: false, error: "" });
      } catch (error) {
        state.error = errorText(error);
      }
    };
    registerRefresh(state, load);
    refreshWidget(ctx, 30 * 60_000, load, () => !!state.error);
    return state;
  },
  menu({ state }) {
    return [
      [
        { label: t("widgets.online.github.openProfile"), icon: "chevron-right", onSelect: () => launch(`https://github.com/${state.login}`) },
        { label: t("widgets.online.github.refreshNow"), icon: "download", onSelect: () => refreshNow(state) },
      ],
    ];
  },
  View({ state, ctx, preview }) {
    const gap = 1;
    const cell = Math.max(3, Math.floor((ui.tile.height - 8 - gap * 6) / 7));
    // Compact (side-edge column): the last weeks that fit the tile's width.
    const fit = compactView(preview) ? Math.max(1, Math.floor((compactWidth() + gap) / (cell + gap))) : Infinity;
    const weeks = Math.min(fit, Math.max(4, Math.min(26, Number(ctx.config.weeks) || 16)));
    // Align the grid on weeks (Sunday first, like GitHub): pad the last column after today.
    const days = state.days;
    const lastDow = days.length ? new Date(`${days[days.length - 1]!.date}T12:00:00`).getDay() : 6;
    const tail = 6 - lastDow;
    const shown = days.slice(Math.max(0, days.length - (weeks * 7 - tail)));
    const cells: (Day | null)[] = [...shown, ...new Array(tail).fill(null)];
    while (cells.length < weeks * 7) cells.unshift(null);
    const max = Math.max(1, ...shown.map((d) => d.count));
    const color = (d: Day | null) => {
      if (!d) return "transparent";
      if (d.count === 0) return ui.track;
      return LEVELS[Math.min(3, Math.floor((d.count / max) * 4 - 1e-9))]!;
    };
    const columns = [];
    for (let w = 0; w < weeks; w++) {
      columns.push(
        <Column style={{ gap }}>
          {cells.slice(w * 7, w * 7 + 7).map((d) => (
            <View style={{ width: cell, height: cell, radius: 1.5, background: color(d) }} />
          ))}
        </Column>,
      );
    }
    const streak = currentStreak(days);
    const l = ui.tile.lines;
    return (
      <Tile
        padding={{ left: 8, right: 10 }}
        onClick={() => launch(state.login ? `https://github.com/${state.login}` : "https://github.com")}
        tip={{
          id: `tip:${ctx.instanceId}`,
          lines: () => [
            t("widgets.online.github.currentStreakWithContributions", { count: streak }),
            t("widgets.online.github.contributionsInLast12", { p0: state.total.toLocaleString(language) }),
            t("widgets.online.github.gridLastWeeksStronger", { weeks }),
            ...sourceLines(state, t("widgets.online.github.githubApiContributionscollection"), t("widgets.online.github.clickToOpenYour"), t("widgets.online.github.enterTokenInSettings")),
          ],
        }}
        preview={preview}
      >
        <WeekGrid gap={gap}>{columns}</WeekGrid>
        <Column style={{ gap: l.gap }}>
          <Text size={l.primary} weight={700} color={streak ? ui.green : ui.muted} style={numeric}>
            {t("widgets.online.github.days", { count: streak })}
          </Text>
          <Text size={l.secondary - 2} color={state.error ? ui.danger : ui.muted}>
            {state.error ? t("widgets.online.github.error") : t("widgets.online.github.thisYear", { p0: compact(state.total), p1: state.demo ? " · demo" : "" })}
          </Text>
        </Column>
      </Tile>
    );
  },
});

export default [github, overview, activity];
