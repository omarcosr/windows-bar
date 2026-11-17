import { Column, Row, Svg, Path, Text, store, toRaw } from "@tarve/core";
import { numeric, ui } from "../../../theme";
import { RoundButton, Tile, glyphs } from "../../ui";
import { defineWidget } from "../../types";
import { showDockMenu } from "../../../menu/dock-menu";
import { clockTenths } from "./shared";

const actions = new WeakMap<object, { toggle(): void; lap(): void; reset(): void; showLaps(): void }>();

const flag = (size: number, color = "#fff") => (
  <Svg width={size} height={size} viewBox="0 0 24 24">
    <Path d="M6 21V4M6 4h11l-2 4 2 4H6" fill="none" stroke={color} stroke-width={2.2} stroke-linecap="round" stroke-linejoin="round" />
  </Svg>
);
const resetGlyph = (size: number, color = "#fff") => (
  <Svg width={size} height={size} viewBox="0 0 24 24">
    <Path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v4h4" fill="none" stroke={color} stroke-width={2.2} stroke-linecap="round" stroke-linejoin="round" />
  </Svg>
);

export default defineWidget({
  type: "productivity-stopwatch",
  name: "Cronômetro",
  description: "Iniciar, pausar e marcar voltas. As voltas aparecem no menu.",
  category: "productivity",
  defaultConfig: {},
  setup(ctx) {
    const state = store({ running: false, startAt: 0, acc: 0, laps: [] as number[], now: Date.now() });
    const elapsed = () => state.acc + (state.running ? Date.now() - state.startAt : 0);
    // Tenths only move while it runs: the clock ticks only then.
    const tick = ctx.ticker(100, () => {
      if (state.running) state.now = Date.now();
      else tick.stop();
    });
    actions.set(toRaw(state), {
      toggle: () => {
        if (state.running) {
          state.acc = elapsed();
          state.running = false;
        } else {
          state.startAt = Date.now();
          state.running = true;
          tick.start();
        }
        state.now = Date.now();
      },
      lap: () => {
        if (state.running) state.laps = [...state.laps, elapsed()];
      },
      reset: () => {
        state.running = false;
        state.acc = 0;
        state.laps = [];
        state.now = Date.now();
      },
      showLaps: () => {
        const laps = state.laps;
        showDockMenu({
          title: "Voltas",
          subtitle: laps.length ? `${laps.length} volta${laps.length > 1 ? "s" : ""} · total ${clockTenths(elapsed())}` : "Nenhuma volta ainda",
          sections: [
            laps
              .map((t, i) => ({ label: `Volta ${i + 1}   ${clockTenths(t - (laps[i - 1] ?? 0))}   (${clockTenths(t)})`, onSelect: () => {} }))
              .reverse(),
          ].filter((s) => s.length),
        });
      },
    });
    return state;
  },
  menu({ state }) {
    const a = actions.get(toRaw(state))!;
    return [
      [
        { label: state.running ? "Pausar" : state.acc ? "Continuar" : "Iniciar", icon: state.running ? "pause" : "play", onSelect: a.toggle },
        ...(state.running ? [{ label: "Marcar volta", icon: "star" as const, onSelect: a.lap }] : []),
        { label: `Ver voltas (${state.laps.length})`, icon: "info", onSelect: () => setTimeout(a.showLaps, 0) },
        { label: "Zerar", icon: "x", onSelect: a.reset },
      ],
    ];
  },
  View({ state, preview }) {
    const a = actions.get(toRaw(state));
    const demo = preview && !state.running && !state.acc;
    const ms = demo ? 83_400 : state.acc + (state.running ? state.now - state.startAt : 0);
    const laps = demo ? 2 : state.laps.length;
    const lapTime = laps && !demo ? state.laps[laps - 1]! - (state.laps[laps - 2] ?? 0) : 41_200;
    return (
      <Tile width={156} onClick={a?.toggle}>
        <Column style={{ flex: 1, gap: 0 }}>
          <Text size={10} weight={600} color={ui.muted}>
            {laps ? `Volta ${laps} · ${clockTenths(lapTime)}` : state.running ? "Cronômetro" : ms ? "Pausado" : "Cronômetro"}
          </Text>
          <Text size={15} weight={700} color={ms || state.running ? ui.text : ui.muted} style={numeric}>
            {clockTenths(ms)}
          </Text>
        </Column>
        <Row style={{ gap: 4 }}>
          {state.running || demo ? (
            <RoundButton size={22} onClick={() => a?.lap()}>
              {flag(11)}
            </RoundButton>
          ) : ms ? (
            <RoundButton size={22} onClick={() => a?.reset()}>
              {resetGlyph(11)}
            </RoundButton>
          ) : null}
          <RoundButton size={22} background={state.running ? "#2a2a2e" : ui.green} onClick={() => a?.toggle()}>
            {state.running ? glyphs.pause(10) : glyphs.play(10)}
          </RoundButton>
        </Row>
      </Tile>
    );
  },
});
