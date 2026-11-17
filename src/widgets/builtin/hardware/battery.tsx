import { Circle, Column, Line, Path, Row, Svg, Text, View, store } from "@tarve/core";
import { systemPoller } from "../../../services/system";
import { numeric, ui } from "../../../theme";
import { Tile } from "../../ui";
import { defineWidget } from "../../types";
import {
  Bolt,
  Metric,
  Ring,
  battery,
  batteryLabel,
  batteryMenu,
  batteryTone,
  noBattery,
  openBatteryFlyout,
  type BatteryReading,
} from "./shared";

/** Every battery tile polls the shared system service and hides itself on a desktop without a battery. */
function batterySetup(ctx: { onDispose(fn: () => void): void }) {
  ctx.onDispose(systemPoller.acquire());
  return {};
}

const base = {
  category: "system" as const,
  defaultConfig: {},
  hidden: noBattery,
  menu: batteryMenu,
};

function Percent(props: { b: BatteryReading; size?: number }) {
  return (
    <Text size={props.size ?? ui.tile.lines.primary} weight={700} color={ui.text} style={numeric}>
      {`${props.b.percent}%`}
    </Text>
  );
}

// ---------- Bateria: the battery outline filling up ----------

function BatteryShape(props: { b: BatteryReading; width: number; height: number }) {
  const { b, width, height } = props;
  const inner = width - 4;
  const fill = Math.max(2, Math.round((inner * Math.min(100, b.percent)) / 100));
  return (
    <Row style={{ align: "center", gap: 1, shrink: 0 }}>
      <View
        style={{
          width,
          height,
          radius: 4,
          borderWidth: 1.5,
          borderColor: "rgba(255,255,255,0.45)",
          padding: 1,
          direction: "row",
          align: "center",
        }}
      >
        <View
          style={{
            width: fill,
            height: height - 5,
            radius: 2,
            background: batteryTone(b),
            transition: { width: { duration: 500, easing: "easeOut" } },
          }}
        />
        {b.plugged ? (
          <View style={{ position: "absolute", left: 0, top: 0, width: width - 3, height: height - 3, align: "center", justify: "center" }}>
            <Bolt size={height - 3} color="#ffffff" />
          </View>
        ) : null}
      </View>
      <View style={{ width: 2, height: height / 2.4, radius: 1, background: "rgba(255,255,255,0.45)" }} />
    </Row>
  );
}

export const batteryFill = defineWidget({
  ...base,
  type: "hardware-battery",
  name: "Bateria",
  description: "Carga da bateria num ícone que enche, com raio quando está carregando.",
  setup: batterySetup,
  View({ preview }) {
    const b = battery(preview);
    return (
      <Tile width={112} padding={{ left: 10, right: 10 }} onClick={openBatteryFlyout}>
        <BatteryShape b={b} width={28} height={15} />
        <Metric label={batteryLabel(b)} value={`${b.percent}%`} />
      </Tile>
    );
  },
});

// ---------- Anel de bateria: ring with a spark while plugged ----------

export const batteryRing = defineWidget({
  ...base,
  type: "hardware-battery-ring",
  name: "Anel de bateria",
  description: "Carga num anel; uma faísca acende enquanto está na tomada.",
  setup(ctx) {
    ctx.onDispose(systemPoller.acquire());
    const state = store({ pulse: false });
    ctx.every(700, () => {
      state.pulse = !state.pulse;
    });
    return state;
  },
  View({ state, preview }) {
    const b = battery(preview);
    return (
      <Tile width={98} padding={{ left: 6, right: 10 }} onClick={openBatteryFlyout}>
        <Ring value={b.percent / 100} color={batteryTone(b)}>
          {b.plugged ? (
            <View style={{ opacity: state.pulse ? 1 : 0.45, transition: { opacity: { duration: 600, easing: "easeInOut" } } }}>
              <Bolt size={13} />
            </View>
          ) : (
            <Text size={9} weight={700} color={ui.text} style={numeric}>
              {String(b.percent)}
            </Text>
          )}
        </Ring>
        <Metric label={b.plugged ? "Na tomada" : "Bateria"} value={`${b.percent}%`} />
      </Tile>
    );
  },
});

// ---------- Núcleo: 12 cells ----------

const CELLS = 12;

export const batteryCore = defineWidget({
  ...base,
  type: "hardware-battery-core",
  name: "Núcleo de bateria",
  description: "Doze células acendem com a carga; a próxima pisca enquanto carrega.",
  setup(ctx) {
    ctx.onDispose(systemPoller.acquire());
    const state = store({ blink: false });
    ctx.every(600, () => {
      state.blink = !state.blink;
    });
    return state;
  },
  View({ state, preview }) {
    const b = battery(preview);
    const lit = Math.round((b.percent / 100) * CELLS);
    const tone = batteryTone(b);
    const h = Math.min(18, ui.tile.height - 16);
    return (
      <Tile width={128} padding={{ left: 10, right: 10 }} gap={8} onClick={openBatteryFlyout}>
        <Row style={{ gap: 2, align: "center" }}>
          {Array.from({ length: CELLS }, (_, i) => {
            const on = i < lit;
            const charging = b.plugged && i === lit && lit < CELLS;
            return (
              <View
                key={i}
                style={{
                  width: 4,
                  height: h,
                  radius: 1.5,
                  background: on ? tone : charging && state.blink ? tone : ui.track,
                  opacity: charging && state.blink ? 0.6 : 1,
                  transition: { background: { duration: 300, easing: "easeOut" } },
                }}
              />
            );
          })}
        </Row>
        <Column style={{ align: "end", gap: 0, flex: 1 }}>
          <Percent b={b} />
          {b.plugged ? <Bolt size={10} /> : null}
        </Column>
      </Tile>
    );
  },
});

// ---------- Pontos: dot-matrix ----------

const DOT_COLS = 10;
const DOT_ROWS = 3;

export const batteryDots = defineWidget({
  ...base,
  type: "hardware-battery-dots",
  name: "Bateria em pontos",
  description: "Matriz de pontos que se preenche da esquerda para a direita com a carga.",
  setup: batterySetup,
  View({ preview }) {
    const b = battery(preview);
    const total = DOT_COLS * DOT_ROWS;
    const lit = Math.round((b.percent / 100) * total);
    const tone = batteryTone(b);
    const dot = 4;
    const gap = 2.5;
    const w = DOT_COLS * dot + (DOT_COLS - 1) * gap;
    const h = DOT_ROWS * dot + (DOT_ROWS - 1) * gap;
    return (
      <Tile width={112} padding={{ left: 10, right: 10 }} onClick={openBatteryFlyout}>
        <Svg width={w} height={h} viewBox={[0, 0, w, h]}>
          {Array.from({ length: total }, (_, i) => {
            // Column by column, bottom to top, like a filling tank.
            const col = Math.floor(i / DOT_ROWS);
            const row = DOT_ROWS - 1 - (i % DOT_ROWS);
            return (
              <Circle
                key={i}
                cx={col * (dot + gap) + dot / 2}
                cy={row * (dot + gap) + dot / 2}
                r={dot / 2}
                fill={i < lit ? tone : ui.track}
                stroke="none"
              />
            );
          })}
        </Svg>
        <Column style={{ align: "end", gap: 0, flex: 1 }}>
          <Percent b={b} size={12} />
          {b.plugged ? <Bolt size={10} /> : null}
        </Column>
      </Tile>
    );
  },
});

// ---------- Medidor: E–F fuel gauge ----------

export const batteryGauge = defineWidget({
  ...base,
  type: "hardware-battery-gauge",
  name: "Medidor de bateria",
  description: "Ponteiro de combustível de E (vazia) a F (cheia).",
  setup: batterySetup,
  View({ preview }) {
    const b = battery(preview);
    const w = 44;
    const h = Math.min(26, ui.tile.height - 10);
    const cx = w / 2;
    const cy = h - 3;
    const r = Math.min(w / 2 - 4, h - 6);
    // 180° (E, left) to 0° (F, right).
    const angle = Math.PI * (1 - Math.max(0, Math.min(100, b.percent)) / 100);
    const nx = cx + (r - 2) * Math.cos(angle);
    const ny = cy - (r - 2) * Math.sin(angle);
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => {
      const a = Math.PI * (1 - t);
      return { x1: cx + r * Math.cos(a), y1: cy - r * Math.sin(a), x2: cx + (r - 4) * Math.cos(a), y2: cy - (r - 4) * Math.sin(a), t };
    });
    const low = `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${(cx + r * Math.cos(Math.PI * 0.8)).toFixed(2)} ${(cy - r * Math.sin(Math.PI * 0.8)).toFixed(2)}`;
    return (
      <Tile width={112} padding={{ left: 8, right: 10 }} gap={6} onClick={openBatteryFlyout}>
        <Text size={9} weight={700} color={ui.danger}>
          E
        </Text>
        <Svg width={w} height={h} viewBox={[0, 0, w, h]}>
          <Path d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`} fill="none" stroke={ui.track} stroke-width={3} stroke-linecap="round" />
          <Path d={low} fill="none" stroke={ui.danger} stroke-width={3} stroke-linecap="round" stroke-opacity={0.8} />
          {ticks.map((t) => (
            <Line key={t.t} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2} stroke={ui.muted} stroke-width={1} />
          ))}
          <Line x1={cx} y1={cy} x2={nx} y2={ny} stroke={batteryTone(b)} stroke-width={2} stroke-linecap="round" />
          <Circle cx={cx} cy={cy} r={2.5} fill={ui.text} stroke="none" />
        </Svg>
        <Text size={9} weight={700} color={ui.muted}>
          F
        </Text>
        <Column style={{ align: "end", gap: 0, flex: 1 }}>
          <Percent b={b} size={12} />
          {b.plugged ? <Bolt size={10} /> : null}
        </Column>
      </Tile>
    );
  },
});
