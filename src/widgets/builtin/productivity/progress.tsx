import { Circle, Column, Row, Svg, Text, store } from "@tarve/core";
import { numeric, ui } from "../../../theme";
import { Meter, Tile } from "../../ui";
import { HoverTip } from "../../../menu/hover-tip";
import { Ring, Stack } from "./shared";
import { defineWidget } from "../../types";
import { launch } from "../../../services/windows";
import { every, onClock, type ClockUnit } from "../../../services/clock";

import { t, formatDecimal } from "../../../i18n";
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

const exact = (v: number) => `${formatDecimal((Math.max(0, Math.min(1, v)) * 100), 1)}%`;

const styleSetting = {
  kind: "choice" as const,
  key: "style" as const,
  label: t("widgets.productivity.progress.style"),
  options: [
    { value: "bar", label: t("widgets.productivity.progress.bar") },
    { value: "ring", label: t("widgets.productivity.progress.ring") },
  ],
};

/**
 * Title and share over a meter, the detail line under it when the tile has room (a 36 px tile or
 * taller; on the 40 px bar it moves to the tooltip). "ring" draws the share as a ring beside two
 * lines. A click opens the calendar flyout, as the taskbar clock does.
 */
function Bar(props: { id: string; preview: boolean; title: string; detail: string; tip: string[]; value: number; color: string; width: number; style?: string }) {
  const inner = props.width - 20;
  const tall = ui.tile.height >= 34;
  const tip = () => [`${props.title}: ${exact(props.value)}`, ...props.tip, t("widgets.productivity.progress.clickToOpenCalendar")];
  const open = props.preview ? undefined : () => launch("ms-actioncenter:");
  if (props.style === "ring") {
    return (
      <HoverTip id={props.id} tip={tip} disabled={props.preview}>
        <Tile padding={{ left: 8, right: 12 }} onClick={open}>
          <Ring value={props.value} size={Math.min(30, ui.tile.control)} color={props.color} label={String(Math.floor(Math.max(0, Math.min(1, props.value)) * 100))} />
          <Stack label={props.title} value={props.detail} valueSize={ui.tile.height < 32 ? 11 : 12} valueWeight={600} />
        </Tile>
      </HoverTip>
    );
  }
  return (
    <HoverTip id={props.id} tip={tip} disabled={props.preview}>
      <Tile width={props.width} padding={{ left: 10, right: 10 }} onClick={open}>
        <Column style={{ flex: 1, gap: tall ? 4 : 3, justify: "center" }}>
          <Row style={{ align: "center", gap: 6 }}>
            <Text size={11} weight={600} color={ui.text} style={{ flex: 1, lineHeight: 1.15 }}>
              {props.title}
            </Text>
            <Text size={11} weight={700} color={ui.text} style={{ ...numeric, lineHeight: 1.15 }}>
              {percent(props.value)}
            </Text>
          </Row>
          <Meter value={props.value} width={inner} color={props.color} />
          {tall ? (
            <Text size={9} color={ui.muted} style={{ ...numeric, lineHeight: 1.15 }}>
              {props.detail}
            </Text>
          ) : null}
        </Column>
      </Tile>
    </HoverTip>
  );
}

const WINDOWS: Record<string, [number, number]> = { full: [0, 24], work: [9, 18], "work8": [8, 17], "work10": [10, 19] };

export const dayProgress = defineWidget({
  type: "productivity-day",
  name: t("widgets.productivity.progress.dayProgress"),
  description: t("widgets.productivity.progress.howMuchOfDay"),
  category: "productivity",
  defaultConfig: { range: "full", style: "bar" },
  settings: [
    styleSetting,
    {
      kind: "choice",
      key: "range",
      label: t("widgets.productivity.progress.period"),
      options: [
        { value: "full", label: t("widgets.productivity.progress.wholeDay") },
        { value: "work8", label: "8h–17h" },
        { value: "work", label: "9h–18h" },
        { value: "work10", label: "10h–19h" },
      ],
    },
  ],
  setup: ticking("minute"),
  View({ state, ctx, preview }) {
    const [from, to] = WINDOWS[String(ctx.config.range)] ?? WINDOWS.full!;
    const d = new Date(state.now);
    const hours = d.getHours() + d.getMinutes() / 60;
    const value = (hours - from) / (to - from);
    const leftMin = Math.max(0, Math.round((to - hours) * 60));
    const detail = value >= 1 ? (from === 0 ? t("widgets.productivity.progress.dayOver") : t("widgets.productivity.progress.workdayOver")) : value < 0 ? t("widgets.productivity.progress.startsAtH", { from }) : t("widgets.productivity.progress.hLeft", { p0: Math.floor(leftMin / 60), p1: String(leftMin % 60).padStart(2, "0") });
    const span = `${String(from).padStart(2, "0")}:00–${String(to % 24).padStart(2, "0")}:00`;
    const tip = [t("widgets.productivity.progress.period2", { p0: from === 0 ? t("widgets.productivity.progress.wholeDay0000") : span }), value >= 1 || value < 0 ? detail : t("widgets.productivity.progress.hMinLeftUntil", { p0: Math.floor(leftMin / 60), p1: leftMin % 60, p2: String(to % 24).padStart(2, "0") })];
    return <Bar id={`tip:${ctx.instanceId}`} preview={preview} style={String(ctx.config.style)} title={from === 0 ? t("widgets.productivity.progress.today") : t("widgets.productivity.progress.workday")} detail={detail} tip={tip} value={value} color={ui.blue} width={132} />;
  },
});

export const monthProgress = defineWidget({
  type: "productivity-month",
  name: t("widgets.productivity.progress.monthProgress"),
  description: t("widgets.productivity.progress.howMuchOfMonth"),
  category: "productivity",
  defaultConfig: { style: "bar" },
  settings: [styleSetting],
  // The month's bar moves under 1 px an hour (112 px for ~720 h).
  setup: ticking("hour"),
  View({ state, ctx, preview }) {
    const d = new Date(state.now);
    const start = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    const end = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
    const days = Math.round((end - start) / DAY_MS);
    const value = (state.now - start) / (end - start);
    const left = days - d.getDate();
    return (
      <Bar
        id={`tip:${ctx.instanceId}`}
        preview={preview}
        style={String(ctx.config.style)}
        tip={[t("widgets.productivity.progress.dayOf", { p0: d.getDate(), days }), left === 0 ? t("widgets.productivity.progress.lastDayOfMonth") : t("widgets.productivity.progress.dayLeft", { count: left })]}
        title={`${MONTHS[d.getMonth()]![0]!.toUpperCase()}${MONTHS[d.getMonth()]!.slice(1)} ${d.getFullYear()}`}
        detail={t("widgets.productivity.progress.dayOf2", { p0: d.getDate(), days, p2: left === 0 ? t("widgets.productivity.progress.lastDay") : t("widgets.productivity.progress.left", { left }) })}
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
  name: t("widgets.productivity.progress.yearProgress"),
  description: t("widgets.productivity.progress.yearAsGridOf"),
  category: "productivity",
  defaultConfig: { color: "accent" },
  settings: [
    {
      kind: "choice",
      key: "color",
      label: t("widgets.productivity.progress.color"),
      options: [
        { value: "accent", label: t("widgets.productivity.progress.blue") },
        { value: "green", label: t("widgets.productivity.progress.green") },
        { value: "orange", label: t("widgets.productivity.progress.orange") },
      ],
    },
  ],
  setup: ticking("day"),
  View({ state, ctx, preview }) {
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
    const left = days - today - 1;
    // Three lines from a 44 px tile; from 34 px the year and the share share a line over the days
    // left; below that (the 40 px bar) only the first line fits and the rest is in the tooltip.
    const stacked = ui.tile.height >= 44;
    const showLeft = ui.tile.height >= 34;
    const tip = () => [t("widgets.productivity.progress.ofYear", { y, p1: exact(today / days) }), t("widgets.productivity.progress.dayOf", { p0: today + 1, days }), left === 0 ? t("widgets.productivity.progress.lastDayOfYear") : t("widgets.productivity.progress.daysLeft", { left })];
    return (
      <HoverTip id={`tip:${ctx.instanceId}`} tip={tip} disabled={preview}>
        <Tile padding={{ left: 10, right: 10 }} gap={8} onClick={preview ? undefined : () => launch("ms-actioncenter:")}>
          <Svg width={w} height={h} viewBox={[0, 0, w, h]}>
            {dots}
          </Svg>
          <Column style={{ gap: 0, align: "end", justify: "center" }}>
            <Row style={{ gap: stacked ? 0 : 4, align: "baseline", direction: stacked ? "column" : "row", alignSelf: "end" }}>
              <Text size={11} weight={700} color={ui.text} style={{ ...numeric, lineHeight: 1.2, alignSelf: "end" }}>
                {String(y)}
              </Text>
              <Text size={11} weight={700} color={color} style={{ ...numeric, lineHeight: 1.2, alignSelf: "end" }}>
                {percent(today / days)}
              </Text>
            </Row>
            {showLeft ? (
              <Text size={9} color={ui.muted} style={{ ...numeric, lineHeight: 1.2 }}>
                {t("widgets.productivity.progress.dLeft", { left })}
              </Text>
            ) : null}
          </Column>
        </Tile>
      </HoverTip>
    );
  },
});
