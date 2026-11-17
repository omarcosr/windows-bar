import { Column, Row, Text } from "@tarve/core";
import { HoverTip } from "../../../menu/hover-tip";
import { openNotificationCenter } from "../../../native/desktop";
import { utcLabel, zoneTime, type ZoneTime } from "../../../native/clocks-zones";
import { clockTip } from "../../../services/clock-tooltip";
import { numeric, ui } from "../../../theme";
import { Tile } from "../../ui";
import { defineWidget } from "../../types";
import { AnalogFace, Caption, clockMenu, clockState, demoNow, hourFormatSetting, timeText, zoneChoices, type HourFormat } from "./shared";

/** A zone's time, or (gallery only) a demo one so the preview is never empty. */
function zoneOrDemo(value: string, now: Date, preview: boolean, demo: { label: string; offset: number }): ZoneTime | null {
  const z = zoneTime(value, now);
  if (z || !preview) return z;
  return { ...demo, wall: new Date(now.getTime() + demo.offset * 60_000) };
}

/** "amanhã"/"ontem" when the zone's date differs from the local one. */
function dayShift(z: ZoneTime, now: Date) {
  const there = Date.UTC(z.wall.getUTCFullYear(), z.wall.getUTCMonth(), z.wall.getUTCDate());
  const here = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return there > here ? "amanhã" : there < here ? "ontem" : "";
}

/** Hands and hour ticks on a dark face. */
export const analog = defineWidget({
  type: "clocks-analog",
  name: "Analógico minimalista",
  description: "Ponteiros e marcas das horas num mostrador escuro.",
  category: "clock",
  defaultConfig: { showSeconds: true, ticks: "all" },
  settings: [
    { kind: "toggle", key: "showSeconds", label: "Ponteiro dos segundos" },
    {
      kind: "choice",
      key: "ticks",
      label: "Marcas",
      options: [
        { value: "all", label: "Todas as horas" },
        { value: "quarters", label: "Só 12, 3, 6 e 9" },
      ],
    },
  ],
  setup(ctx) {
    return clockState(ctx, () => ctx.config.showSeconds);
  },
  menu: clockMenu,
  View({ state, ctx, preview }) {
    const size = Math.round(ui.tile.height - 6);
    return (
      <HoverTip id={`tip:${ctx.instanceId}`} tip={clockTip} disabled={preview}>
        <Tile padding={{ left: 3, right: 3 }} onClick={openNotificationCenter}>
          <AnalogFace size={size} now={preview ? demoNow() : state.now} seconds={ctx.config.showSeconds} ticks={ctx.config.ticks === "quarters" ? "quarters" : "all"} />
        </Tile>
      </HoverTip>
    );
  },
});

const demos = [
  { label: "Nova York", offset: -240 },
  { label: "Londres", offset: 60 },
  { label: "Tóquio", offset: 540 },
];

/** Three small analog faces for three zones. */
export const worldClocks = defineWidget({
  type: "clocks-world",
  name: "Relógios mundiais",
  description: "Três mostradores analógicos para fusos horários à sua escolha.",
  category: "clock",
  defaultConfig: { zone1: "America/New_York", zone2: "Europe/London", zone3: "Asia/Tokyo" },
  settings: [
    { kind: "choice", key: "zone1", label: "Fuso 1", options: zoneChoices },
    { kind: "choice", key: "zone2", label: "Fuso 2", options: zoneChoices },
    { kind: "choice", key: "zone3", label: "Fuso 3", options: zoneChoices },
  ],
  setup(ctx) {
    return clockState(ctx, () => false);
  },
  menu: clockMenu,
  View({ state, ctx, preview }) {
    const now = state.now;
    const size = Math.round(ui.tile.height - 17);
    const zones = [ctx.config.zone1, ctx.config.zone2, ctx.config.zone3].map((v, i) => zoneOrDemo(v, now, preview, demos[i]!));
    const tip = () => [
      ...zones.filter((z): z is ZoneTime => !!z).map((z) => {
        const shift = dayShift(z, now);
        return `${z.label}: ${timeText(z.wall, "system", { utc: true })} (${utcLabel(z.offset)})${shift ? ` · ${shift}` : ""}`;
      }),
    ];
    return (
      <HoverTip id={`tip:${ctx.instanceId}`} tip={tip} disabled={preview}>
        <Tile padding={{ left: 8, right: 8 }} gap={8} onClick={openNotificationCenter}>
          {zones.map((z) =>
            z ? (
              <Column style={{ align: "center", gap: 1, width: Math.max(size, 34) }}>
                <AnalogFace size={size} now={z.wall} utc ticks="quarters" />
                <Text size={8} weight={600} color={ui.muted} style={{ lineHeight: 1 }}>
                  {z.label.length > 9 ? z.label.slice(0, 8) + "…" : z.label}
                </Text>
              </Column>
            ) : (
              <Column style={{ align: "center", width: Math.max(size, 34) }}>
                <Caption>—</Caption>
              </Column>
            ),
          )}
        </Tile>
      </HoverTip>
    );
  },
});

/** One extra city in big digits with its UTC offset. */
export const worldTime = defineWidget({
  type: "clocks-world-time",
  name: "Hora mundial",
  description: "Uma cidade extra em dígitos grandes, com o deslocamento UTC.",
  category: "clock",
  defaultConfig: { zone: "windows:0", hourFormat: "system" },
  settings: [
    { kind: "choice", key: "zone", label: "Cidade", description: "Os relógios adicionais vêm de Configurações > Data e hora.", options: zoneChoices },
    hourFormatSetting,
  ],
  setup(ctx) {
    return clockState(ctx, () => false);
  },
  menu: clockMenu,
  hidden({ ctx }) {
    return !zoneTime(ctx.config.zone);
  },
  View({ state, ctx, preview }) {
    const now = state.now;
    const z = zoneOrDemo(ctx.config.zone, now, preview, demos[2]!);
    const shift = z ? dayShift(z, now) : "";
    return (
      <HoverTip id={`tip:${ctx.instanceId}`} tip={clockTip} disabled={preview}>
        <Tile padding={{ left: 12, right: 12 }} onClick={openNotificationCenter}>
          <Column style={{ gap: 0 }}>
            <Row style={{ gap: 5, align: "end" }}>
              <Text size={Math.round(ui.tile.height * 0.42)} weight={700} color={ui.text} style={{ ...numeric, lineHeight: 1.05 }}>
                {z ? timeText(z.wall, ctx.config.hourFormat as HourFormat, { utc: true }) : "--:--"}
              </Text>
              {shift ? <Caption color={ui.orange}>{shift}</Caption> : null}
            </Row>
            <Caption>{z ? `${z.label} · ${utcLabel(z.offset)}` : "Fuso indisponível"}</Caption>
          </Column>
        </Tile>
      </HoverTip>
    );
  },
});
