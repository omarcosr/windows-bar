import { Column, Row, Text, store } from "@tarve/core";
import { launch } from "../../../services/windows";
import { graphql } from "../../../services/online-http";
import { numeric, ui } from "../../../theme";
import { Tile } from "../../ui";
import { defineWidget } from "../../types";
import { Badge, errorText, refreshNow, registerRefresh } from "./common";
import { refreshWidget } from "../../../services/remote";

const QUERY = `query userStats($username: String!) {
  matchedUser(username: $username) {
    submitStatsGlobal { acSubmissionNum { difficulty count } }
    userCalendar { streak totalActiveDays submissionCalendar }
  }
}`;

const DAY_S = 86_400;

/** Days in a row (UTC, as LeetCode counts them) with a submission, ending today or yesterday. */
function currentStreak(calendar: Record<string, number>) {
  const active = new Set(
    Object.entries(calendar)
      .filter(([, n]) => n > 0)
      .map(([t]) => Math.floor(Number(t) / DAY_S)),
  );
  let day = Math.floor(Date.now() / 1000 / DAY_S);
  if (!active.has(day)) day--;
  let streak = 0;
  while (active.has(day)) {
    streak++;
    day--;
  }
  return streak;
}

const DEMO = { solved: 312, easy: 140, medium: 142, hard: 30, streak: 12, best: 41 };

export default defineWidget({
  type: "online-leetcode",
  name: "LeetCode",
  description: "Problemas resolvidos (fácil/médio/difícil) e sequência atual de um perfil público.",
  category: "productivity",
  defaultConfig: { username: "" },
  settings: [{ kind: "text", key: "username", label: "Usuário do LeetCode", description: "Vazio mostra dados de exemplo.", placeholder: "seu-usuario" }],
  setup(ctx) {
    const state = store({ ...DEMO, demo: true, error: "" });
    const load = async () => {
      const username = String(ctx.config.username || "").trim();
      if (!username) {
        Object.assign(state, { ...DEMO, demo: true, error: "" });
        return;
      }
      try {
        const data = await graphql<{
          matchedUser: {
            submitStatsGlobal: { acSubmissionNum: { difficulty: string; count: number }[] };
            userCalendar: { streak: number; submissionCalendar: string };
          } | null;
        }>("https://leetcode.com/graphql", QUERY, { username }, { Referer: "https://leetcode.com" }, "LeetCode");
        const user = data.matchedUser;
        if (!user) throw new Error("usuário não encontrado");
        const n = (d: string) => user.submitStatsGlobal.acSubmissionNum.find((x) => x.difficulty === d)?.count ?? 0;
        let calendar: Record<string, number> = {};
        try {
          calendar = JSON.parse(user.userCalendar.submissionCalendar || "{}");
        } catch {}
        Object.assign(state, {
          solved: n("All"),
          easy: n("Easy"),
          medium: n("Medium"),
          hard: n("Hard"),
          streak: currentStreak(calendar),
          best: user.userCalendar.streak,
          demo: false,
          error: "",
        });
      } catch (error) {
        state.error = errorText(error);
      }
    };
    registerRefresh(state, load);
    refreshWidget(ctx, 30 * 60_000, load, () => !!state.error);
    return state;
  },
  menu({ state, ctx }) {
    const user = String(ctx.config.username || "").trim();
    return [
      [
        { label: `Fácil ${state.easy} · Médio ${state.medium} · Difícil ${state.hard}`, onSelect: () => {} },
        { label: `Maior sequência no ano: ${state.best} dias`, onSelect: () => {} },
      ],
      [
        { label: "Abrir perfil", icon: "chevron-right", onSelect: () => launch(user ? `https://leetcode.com/u/${user}/` : "https://leetcode.com") },
        { label: "Atualizar agora", icon: "download", onSelect: () => refreshNow(state) },
      ],
    ];
  },
  View({ state, ctx }) {
    const user = String(ctx.config.username || "").trim();
    return (
      <Tile width={168} padding={{ left: 10, right: 10 }} onClick={() => launch(user ? `https://leetcode.com/u/${user}/` : "https://leetcode.com")}>
        <Badge color="#ffa116" letter="L" fg="#1a1a1a" size={18} />
        <Column style={{ flex: 1, gap: 1 }}>
          <Row style={{ align: "center", gap: 4 }}>
            <Text size={12} weight={700} color={ui.text} style={numeric}>
              {String(state.solved)}
            </Text>
            <Text size={9} color={state.error ? ui.danger : ui.muted}>
              {state.error ? "erro" : state.demo ? "resolvidos · demo" : "resolvidos"}
            </Text>
          </Row>
          <Row style={{ align: "center", gap: 5 }}>
            <Text size={10} weight={600} color="#00b8a3" style={numeric}>{String(state.easy)}</Text>
            <Text size={10} weight={600} color="#ffc01e" style={numeric}>{String(state.medium)}</Text>
            <Text size={10} weight={600} color="#ef4743" style={numeric}>{String(state.hard)}</Text>
            <Text size={10} weight={700} color={state.streak ? ui.orange : ui.faint} style={{ ...numeric, flex: 1, textAlign: "right" }}>
              {`🔥 ${state.streak}`}
            </Text>
          </Row>
        </Column>
      </Tile>
    );
  },
});
