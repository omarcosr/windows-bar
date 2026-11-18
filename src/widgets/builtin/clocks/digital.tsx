import { Column, Row, Text, View } from "@tarve/core";
import { HoverTip } from "../../../menu/hover-tip";
import { openNotificationCenter } from "../../../native/desktop";
import { formatDate, formatDayMonth } from "../../../native/locale-format";
import { clockTip } from "../../../services/clock-tooltip";
import { numeric, ui } from "../../../theme";
import { Tile, compactView } from "../../ui";
import { defineWidget } from "../../types";
import { Colon, SegmentDigit, clockMenu, clockParts, clockState, hourFormatSetting, monthName, timeText, weekdayName, type HourFormat } from "./shared";

/** The clock's date line in the chosen style, from Windows' regional formats. */
function dateText(now: Date, style: string) {
  switch (style) {
    case "short":
      return formatDate(now, "short");
    case "long":
      return formatDate(now, "long");
    case "dayMonth":
      return `${weekdayName(now)}, ${now.getDate()} ${monthName(now).toLowerCase()}`;
    default:
      return `${weekdayName(now)}, ${formatDate(now, "short")}`;
  }
}

/** Large time with seconds over the short date. */
export const clock = defineWidget({
  type: "clocks-clock",
  name: "Relógio",
  description: "Hora grande com segundos e a data, no formato do Windows ou em 12/24 h.",
  category: "clock",
  defaultConfig: { hourFormat: "system", showSeconds: true, showDate: true, dateStyle: "weekday" },
  settings: [
    hourFormatSetting,
    { kind: "toggle", key: "showSeconds", label: "Mostrar segundos" },
    { kind: "toggle", key: "showDate", label: "Mostrar data" },
    {
      kind: "choice",
      key: "dateStyle",
      label: "Formato da data",
      description: "Datas no formato regional do Windows.",
      when: (c) => c.showDate,
      options: [
        { value: "weekday", label: "Dia da semana e data curta (Qua, 18/11/2026)" },
        { value: "short", label: "Data curta do Windows (18/11/2026)" },
        { value: "dayMonth", label: "Dia da semana, dia e mês (Qua, 18 nov)" },
        { value: "long", label: "Data longa do Windows" },
      ],
    },
  ],
  setup(ctx) {
    return clockState(ctx, () => (ctx.config.showSeconds ? "second" : "minute"));
  },
  menu: clockMenu,
  View({ state, ctx, preview }) {
    const now = state.now;
    // Compact (side-edge column): the time over day and month, as Windows' vertical taskbar clock.
    const compact = compactView(preview);
    const big = compact ? ui.tile.lines.primary : Math.round(ui.tile.height * (ctx.config.showDate ? 0.4 : 0.5));
    return (
      <HoverTip id={`tip:${ctx.instanceId}`} tip={clockTip} disabled={preview}>
        <Tile padding={{ left: 12, right: 12 }} onClick={openNotificationCenter}>
          <Column style={{ align: "center", gap: 0 }}>
            <Text size={big} weight={700} color={ui.text} style={{ ...numeric, lineHeight: 1.05 }}>
              {timeText(now, ctx.config.hourFormat as HourFormat, { seconds: ctx.config.showSeconds && !compact })}
            </Text>
            {ctx.config.showDate ? (
              <Text size={ui.tile.lines.secondary - 1} weight={500} color={ui.muted} style={{ ...numeric, lineHeight: 1.1 }}>
                {compact ? formatDayMonth(now) : dateText(now, String(ctx.config.dateStyle))}
              </Text>
            ) : null}
          </Column>
        </Tile>
      </HoverTip>
    );
  },
});

/** One split-flap card: dark halves split by a hairline, the digit across both. */
function Flap(props: { text: string; h: number }) {
  const w = Math.round(props.h * 0.68);
  return (
    <View style={{ width: w, height: props.h, radius: 4, background: "#2a2a2e", align: "center", justify: "center", overflow: "hidden" }}>
      <View style={{ position: "absolute", left: 0, right: 0, top: 0, height: props.h / 2, background: "#323237" }} />
      <Text size={Math.round(props.h * 0.78)} weight={700} color={ui.text} style={{ ...numeric, lineHeight: 1 }}>
        {props.text}
      </Text>
      <View style={{ position: "absolute", left: 0, right: 0, top: props.h / 2 - 0.5, height: 1, background: "#0c0c0e" }} />
    </View>
  );
}

/** Split-flap digits, as on an airport board. */
export const flip = defineWidget({
  type: "clocks-flip",
  name: "Relógio flip",
  description: "Dígitos de placas viradas, como um painel de aeroporto.",
  category: "clock",
  defaultConfig: { hourFormat: "system", showSeconds: false },
  settings: [hourFormatSetting, { kind: "toggle", key: "showSeconds", label: "Mostrar segundos" }],
  setup(ctx) {
    return clockState(ctx, () => (ctx.config.showSeconds ? "second" : "minute"));
  },
  menu: clockMenu,
  View({ state, ctx, preview }) {
    const p = clockParts(state.now, ctx.config.hourFormat as HourFormat);
    const h = Math.round(ui.tile.height - 12);
    const pair = (s: string, size = h) => (
      <Row style={{ gap: 2 }}>
        {s.padStart(2, " ").split("").map((c) => (
          <Flap text={c} h={size} />
        ))}
      </Row>
    );
    // Minimal (side-edge column): the hours over the minutes.
    const stacked = (
      <Column style={{ gap: 2, align: "center" }}>
        {pair(p.hh, 16)}
        {pair(p.mm, 16)}
      </Column>
    );
    return (
      <HoverTip id={`tip:${ctx.instanceId}`} tip={clockTip} disabled={preview}>
        <Tile icon={stacked} padding={{ left: 6, right: 6 }} gap={4} onClick={openNotificationCenter}>
          {pair(p.hh)}
          <Colon h={h} color={ui.muted} />
          {pair(p.mm)}
          {ctx.config.showSeconds ? <Colon h={h} color={ui.muted} /> : null}
          {ctx.config.showSeconds ? pair(p.ss) : null}
          {p.suffix ? (
            <Text size={9} weight={700} color={ui.muted}>
              {p.suffix}
            </Text>
          ) : null}
        </Tile>
      </HoverTip>
    );
  },
});

const segmentColors = { green: ui.green, red: ui.danger, blue: ui.blue, orange: "#ff9f0a" } as const;

/** Seven-segment digits with the weekday and the date beside them. */
export const segment = defineWidget({
  type: "clocks-segment",
  name: "Relógio de segmentos",
  description: "Dígitos de sete segmentos com dia da semana e data.",
  category: "clock",
  defaultConfig: { hourFormat: "system", color: "green", showSeconds: false },
  settings: [
    hourFormatSetting,
    { kind: "toggle", key: "showSeconds", label: "Piscar os dois-pontos a cada segundo" },
    {
      kind: "choice",
      key: "color",
      label: "Cor",
      options: [
        { value: "green", label: "Verde" },
        { value: "red", label: "Vermelho" },
        { value: "blue", label: "Azul" },
        { value: "orange", label: "Laranja" },
      ],
    },
  ],
  setup(ctx) {
    return clockState(ctx, () => (ctx.config.showSeconds ? "second" : "minute"));
  },
  menu: clockMenu,
  View({ state, ctx, preview }) {
    const now = state.now;
    const p = clockParts(now, ctx.config.hourFormat as HourFormat);
    const color = segmentColors[ctx.config.color as keyof typeof segmentColors] ?? ui.green;
    const h = Math.round(ui.tile.height * 0.56);
    const digits = (s: string, size = h) => s.padStart(2, " ").split("").map((c) => <SegmentDigit digit={c} h={size} color={color} />);
    // Minimal (side-edge column): the hours over the minutes.
    const stacked = (
      <Column style={{ gap: 3, align: "center" }}>
        <Row style={{ gap: 2 }}>{digits(p.hh, 15)}</Row>
        <Row style={{ gap: 2 }}>{digits(p.mm, 15)}</Row>
      </Column>
    );
    return (
      <HoverTip id={`tip:${ctx.instanceId}`} tip={clockTip} disabled={preview}>
        <Tile icon={stacked} padding={{ left: 10, right: 10 }} gap={8} background="#0a0a0c" onClick={openNotificationCenter}>
          <Row style={{ gap: 3, align: "center" }}>
            {digits(p.hh)}
            <Colon h={h} color={color} on={!ctx.config.showSeconds || now.getSeconds() % 2 === 0} />
            {digits(p.mm)}
          </Row>
          <Column style={{ gap: 0 }}>
            <Text size={9} weight={700} color={color} style={{ lineHeight: 1.15 }}>
              {weekdayName(now).toUpperCase()}
            </Text>
            <Text size={9} weight={600} color={ui.muted} style={{ ...numeric, lineHeight: 1.15 }}>
              {`${now.getDate()} ${monthName(now).toUpperCase()}`}
            </Text>
            {p.suffix ? (
              <Text size={9} weight={600} color={ui.muted} style={{ lineHeight: 1.15 }}>
                {p.suffix}
              </Text>
            ) : null}
          </Column>
        </Tile>
      </HoverTip>
    );
  },
});
