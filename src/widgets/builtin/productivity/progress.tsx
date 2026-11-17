import { Circle, Column, Row, Svg, Text, store } from "@tarve/core";
import { numeric, ui } from "../../../theme";
import { Meter, Tile } from "../../ui";
import { defineWidget } from "../../types";
import { launch } from "../../../services/windows";
import { every, onClock, type ClockUnit } from "../../../services/clock";

const MONTHS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const DAY_MS = 86_400_000;

/**
 * A store with `now`, moved by the shared clock only on the `unit` boundary the face shows (the
 * minute, the hour, the day): the year's ~365 dots are redrawn once a day, not on a 30 s check.
 */
function ticking(unit: ClockUnit) {
  return (ctx: { onDispose(fn: () => void): void }) => {
    const state = store({ now: Date.now() });
    ctx.onDispose(onClock(every(unit), (now) => (state.now = now)).cancel);
    return state;
  };
}

const percent = (v: number) => `${Math.floor(Math.max(0, Math.min(1, v)) * 100)}%`;

function Bar(props: { title: string; detail: string; value: number; color: string; width: number }) {
  const inner = props.width - 20;
  return (
    <Tile width={props.width} padding={{ left: 10, right: 10 }} onClick={() => launch("ms-actioncenter:")}>
      <Column style={{ flex: 1, gap: 5 }}>
        <Row style={{ align: "center", gap: 6 }}>
          <Text size={11} weight={600} color={ui.text} style={{ flex: 1 }}>
            {props.title}
          </Text>
          <Text size={11} weight={700} color={ui.text} style={numeric}>
            {percent(props.value)}
          </Text>
        </Row>
        <Meter value={props.value} width={inner} color={props.color} />
        <Text size={9} color={ui.muted} style={numeric}>
          {props.detail}
        </Text>
      </Column>
    </Tile>
  );
}

const WINDOWS: Record<string, [number, number]> = { full: [0, 24], work: [9, 18], "work8": [8, 17], "work10": [10, 19] };

export const dayProgress = defineWidget({
  type: "productivity-day",
  name: "Progresso do dia",
  description: "Quanto do dia (ou do expediente) já passou.",
  category: "productivity",
  defaultConfig: { range: "full" },
  settings: [
    {
      kind: "choice",
      key: "range",
      label: "Período",
      options: [
        { value: "full", label: "Dia inteiro" },
        { value: "work8", label: "8h–17h" },
        { value: "work", label: "9h–18h" },
        { value: "work10", label: "10h–19h" },
      ],
    },
  ],
  setup: ticking("minute"),
  View({ state, ctx }) {
    const [from, to] = WINDOWS[String(ctx.config.range)] ?? WINDOWS.full!;
    const d = new Date(state.now);
    const hours = d.getHours() + d.getMinutes() / 60;
    const value = (hours - from) / (to - from);
    const leftMin = Math.max(0, Math.round((to - hours) * 60));
    const detail = value >= 1 ? (from === 0 ? "Dia encerrado" : "Expediente encerrado") : value < 0 ? `Começa às ${from}h` : `Faltam ${Math.floor(leftMin / 60)}h${String(leftMin % 60).padStart(2, "0")}`;
    return <Bar title={from === 0 ? "Hoje" : "Expediente"} detail={detail} value={value} color={ui.blue} width={132} />;
  },
});

export const monthProgress = defineWidget({
  type: "productivity-month",
  name: "Progresso do mês",
  description: "Quanto do mês já passou.",
  category: "productivity",
  defaultConfig: {},
  // The month's bar moves under 1 px an hour (112 px for ~720 h).
  setup: ticking("hour"),
  View({ state }) {
    const d = new Date(state.now);
    const start = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    const end = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
    const days = Math.round((end - start) / DAY_MS);
    const value = (state.now - start) / (end - start);
    const left = days - d.getDate();
    return (
      <Bar
        title={`${MONTHS[d.getMonth()]![0]!.toUpperCase()}${MONTHS[d.getMonth()]!.slice(1)} ${d.getFullYear()}`}
        detail={`Dia ${d.getDate()} de ${days} · ${left === 0 ? "último dia" : `faltam ${left}`}`}
        value={value}
        color={ui.green}
        width={132}
      />
    );
  },
});

/** The year as GitHub-style columns of weeks (rows Sunday–Saturday), one dot per day. */
export const yearProgress = defineWidget({
  type: "productivity-year",
  name: "Progresso do ano",
  description: "O ano como uma grade de pontos, um por dia; os dias que já passaram acendem.",
  category: "productivity",
  defaultConfig: { color: "accent" },
  settings: [
    {
      kind: "choice",
      key: "color",
      label: "Cor",
      options: [
        { value: "accent", label: "Azul" },
        { value: "green", label: "Verde" },
        { value: "orange", label: "Laranja" },
      ],
    },
  ],
  setup: ticking("day"),
  View({ state, ctx }) {
    const d = new Date(state.now);
    const y = d.getFullYear();
    const jan1 = new Date(y, 0, 1);
    const days = Math.round((new Date(y + 1, 0, 1).getTime() - jan1.getTime()) / DAY_MS);
    const today = Math.floor((new Date(y, d.getMonth(), d.getDate()).getTime() - jan1.getTime()) / DAY_MS + 0.5);
    const offset = jan1.getDay();
    const cols = Math.ceil((days + offset) / 7);
    const cell = Math.max(3, Math.min(5, Math.floor((ui.tile.height - 10) / 7)));
    const r = cell * 0.36;
    const w = cols * cell;
    const h = 7 * cell;
    const color = ctx.config.color === "green" ? ui.green : ctx.config.color === "orange" ? "#ff9f0a" : ui.blue;
    const dots = [];
    for (let i = 0; i < days; i++) {
      const k = i + offset;
      const fill = i < today ? color : i === today ? "#ffffff" : "#38383d";
      dots.push(<Circle cx={Math.floor(k / 7) * cell + cell / 2} cy={(k % 7) * cell + cell / 2} r={r} fill={fill} stroke="none" />);
    }
    return (
      <Tile width={w + 62} padding={{ left: 10, right: 10 }} gap={8}>
        <Svg width={w} height={h} viewBox={[0, 0, w, h]}>
          {dots}
        </Svg>
        <Column style={{ gap: 0, align: "end", flex: 1 }}>
          <Text size={11} weight={700} color={ui.text} style={numeric}>
            {String(y)}
          </Text>
          <Text size={11} weight={700} color={color} style={numeric}>
            {percent(today / days)}
          </Text>
          <Text size={9} color={ui.muted} style={numeric}>
            {`${days - today - 1} d`}
          </Text>
        </Column>
      </Tile>
    );
  },
});
