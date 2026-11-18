import { Circle, Column, Line, Path, Pressable, Row, Svg, Text, View, store } from "@tarve/core";
import { batteryWatch, system } from "../../../services/system";
import { onShellEvent } from "../../../native/shell-events";
import { numeric, ui } from "../../../theme";
import { Tile } from "../../ui";
import { hideTip, hoverTip } from "../../../menu/hover-tip";
import { defineWidget, type WidgetContext } from "../../types";
import {
  Bolt,
  Metric,
  Ring,
  battery,
  batteryLabel,
  batteryMenu,
  batteryTip,
  batteryTone,
  noBattery,
  openBatteryFlyout,
  type BatteryReading,
} from "./shared";

/** Every battery tile follows Windows' power notifications and hides itself on a desktop without a battery. */
function batterySetup(ctx: { onDispose(fn: () => void): void }) {
  ctx.onDispose(batteryWatch.acquire());
  return {};
}

/**
 * Blinks `state[key]` every `ms` only while the battery charges: the ticker starts on a power
 * notification and stops itself once unplugged, so an idle tile wakes nothing.
 */
function chargeBlink<K extends string>(ctx: WidgetContext<object>, state: Record<K, boolean>, key: K, ms: number) {
  ctx.onDispose(batteryWatch.acquire());
  const tick = ctx.ticker(ms, () => {
    if (system.battery.charging) state[key] = !state[key];
    else {
      state[key] = false;
      tick.stop();
    }
  });
  const sync = () => {
    if (system.battery.charging) tick.start();
  };
  sync();
  ctx.onDispose(onShellEvent((event) => event.type === "power" && sync()));
}

const base = {
  category: "system" as const,
  defaultConfig: {},
  hidden: noBattery,
  menu: batteryMenu,
};

/** "⚡ 100%": the charge, with the bolt beside it (on one line, centred) while plugged in. */
function Percent(props: { b: BatteryReading; size?: number }) {
  const size = props.size ?? ui.tile.lines.primary;
  return (
    <Row style={{ align: "center", gap: 2, shrink: 0 }}>
      {props.b.plugged ? <Bolt size={size - 2} /> : null}
      <Text size={size} weight={700} color={ui.text} style={{ ...numeric, lineHeight: 1 }}>
        {`${props.b.percent}%`}
      </Text>
    </Row>
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
  View({ ctx, preview }) {
    const b = battery(preview);
    return (
      <Tile onClick={openBatteryFlyout} preview={preview} tip={batteryTip(`tip:${ctx.instanceId}`, preview)}>
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
    const state = store({ pulse: false });
    chargeBlink(ctx, state, "pulse", 700);
    return state;
  },
  View({ state, ctx, preview }) {
    const b = battery(preview);
    return (
      <Tile lead="round" onClick={openBatteryFlyout} preview={preview} tip={batteryTip(`tip:${ctx.instanceId}`, preview)}>
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

// ---------- Líquido: a square tank whose water level is the charge ----------

/** Water colours: blue normally, amber when low, red when critical (charging keeps it blue). */
function waterColors(b: BatteryReading) {
  if (!b.plugged && b.percent <= 10) return { water: "#ff453a", deep: "#d92d22", air: "#ff8a80" };
  if (!b.plugged && b.percent <= 20) return { water: "#ff9f0a", deep: "#e07f00", air: "#ffc46b" };
  return { water: "#3d8cff", deep: "#2a6fe0", air: "#6aaeff" };
}

/** Top edge of the water: two gentle wave crests across the tank, as one closed shape down to the floor. */
function waterPath(size: number, level: number) {
  const y = size * (1 - level);
  const amp = Math.min(2.6, size * 0.05);
  const q = size / 4;
  return `M 0 ${y.toFixed(2)} C ${(q * 0.5).toFixed(2)} ${(y - amp).toFixed(2)} ${(q * 1.5).toFixed(2)} ${(y - amp).toFixed(2)} ${(q * 2).toFixed(2)} ${y.toFixed(2)} S ${(q * 3.5).toFixed(2)} ${(y + amp).toFixed(2)} ${size} ${y.toFixed(2)} L ${size} ${size} L 0 ${size} Z`;
}

export const batteryLiquid = defineWidget({
  ...base,
  type: "hardware-battery-liquid",
  name: "Bateria líquida",
  description: "Um quadrado que se enche de água até a carga, com o número e um raio quando está na tomada.",
  setup: batterySetup,
  View({ ctx, preview }) {
    const b = battery(preview);
    const size = ui.tile.height;
    const c = waterColors(b);
    // Kept a little below the top at 100 % so the wave still shows, and visible at 0 %.
    const level = 0.06 + 0.82 * (Math.max(0, Math.min(100, b.percent)) / 100);
    const text = Math.round(size * 0.36);
    return (
      <Pressable
        onClick={openBatteryFlyout}
        style={{
          width: size,
          height: size,
          radius: Math.round(size * 0.24),
          overflow: "hidden",
          background: c.air,
          shrink: 0,
          cursor: "pointer",
          // Its own colours fill the whole tile: the hover only dims it a little.
          opacity: 1,
          hover: { opacity: 0.9 },
          active: { transform: "scale(0.96)" },
          transition: { opacity: { duration: 140, easing: "easeOut" } },
        }}
      >
        <Svg width={size} height={size} viewBox={[0, 0, size, size]}>
          <Path d={waterPath(size, level)} fill={c.water} stroke="none" />
        </Svg>
        <View style={{ position: "absolute", left: 0, top: 0, width: size, height: size, direction: "row", align: "center", justify: "center", gap: 2 }}>
          {b.plugged ? <Bolt size={Math.round(text * 0.85)} color="#ffffff" /> : null}
          <Text size={text} weight={800} color="#ffffff" style={{ ...numeric, lineHeight: 1 }}>
            {String(b.percent)}
          </Text>
        </View>
      </Pressable>
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
    const state = store({ blink: false });
    chargeBlink(ctx, state, "blink", 600);
    return state;
  },
  View({ state, ctx, preview }) {
    const b = battery(preview);
    const lit = Math.round((b.percent / 100) * CELLS);
    const tone = batteryTone(b);
    const h = Math.min(18, ui.tile.height - 16);
    return (
      <Tile gap={8} onClick={openBatteryFlyout} preview={preview} tip={batteryTip(`tip:${ctx.instanceId}`, preview)}>
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
        <Percent b={b} />
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
  View({ ctx, preview }) {
    const b = battery(preview);
    const total = DOT_COLS * DOT_ROWS;
    const lit = Math.round((b.percent / 100) * total);
    const tone = batteryTone(b);
    const dot = 4;
    const gap = 2.5;
    const w = DOT_COLS * dot + (DOT_COLS - 1) * gap;
    const h = DOT_ROWS * dot + (DOT_ROWS - 1) * gap;
    return (
      <Tile gap={8} onClick={openBatteryFlyout} preview={preview} tip={batteryTip(`tip:${ctx.instanceId}`, preview)}>
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
        <Percent b={b} />
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
  View({ ctx, preview }) {
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
      <Tile gap={6} onClick={openBatteryFlyout} preview={preview} tip={batteryTip(`tip:${ctx.instanceId}`, preview)}>
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
        <Percent b={b} />
      </Tile>
    );
  },
});
