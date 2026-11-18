import { Row, Text, store, toRaw } from "@tarve/core";
import { ui } from "../../../theme";
import { HoverTip } from "../../../menu/hover-tip";
import { RoundButton, Tile, glyphs } from "../../ui";
import { FluentGlyph } from "../../../menu/dock-menu";
import { defineWidget } from "../../types";
import { showDockMenu } from "../../../menu/dock-menu";
import { Stack, buttonSize, clockTenths } from "./shared";
import { onClock } from "../../../services/clock";

const actions = new WeakMap<object, { toggle(): void; lap(): void; reset(): void; showLaps(): void }>();

/** Segoe Fluent Icons glyphs, as the Windows Clock app's stopwatch draws its lap and reset buttons. */
const fluent = (code: number) => (size: number, color = "#fff") => (
  <Text size={size} color={color} style={{ fontFamily: "Segoe Fluent Icons, Segoe MDL2 Assets", lineHeight: 1 }}>
    {String.fromCharCode(code)}
  </Text>
);
const flag = fluent(0xe7c1 /* Flag */);
const resetGlyph = fluent(0xe72c /* Refresh */);

export default defineWidget({
  type: "productivity-stopwatch",
  name: "Cronômetro",
  description: "Iniciar, pausar e marcar voltas. As voltas aparecem no menu.",
  category: "productivity",
  defaultConfig: {},
  setup(ctx) {
    const state = store({ running: false, startAt: 0, acc: 0, laps: [] as number[], now: Date.now() });
    const elapsed = () => state.acc + (state.running ? Date.now() - state.startAt : 0);
    // Tenths only move while it runs and the dock is visible: the shared clock wakes on the next
    // tenth of the elapsed time only then (a covered dock catches up once when it is back).
    const sub = onClock(
      (now, covered) => (state.running && !covered ? now + 100 - ((state.acc + now - state.startAt) % 100) : null),
      (now) => {
        if (state.running) state.now = now;
      },
    );
    ctx.onDispose(sub.cancel);
    actions.set(toRaw(state), {
      toggle: () => {
        if (state.running) {
          state.acc = elapsed();
          state.running = false;
        } else {
          state.startAt = Date.now();
          state.running = true;
        }
        state.now = Date.now();
        sub.update();
      },
      lap: () => {
        if (state.running) state.laps = [...state.laps, elapsed()];
      },
      reset: () => {
        state.running = false;
        state.acc = 0;
        state.laps = [];
        state.now = Date.now();
        sub.update();
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
  View({ state, ctx, preview }) {
    const a = actions.get(toRaw(state));
    const demo = preview && !state.running && !state.acc;
    const ms = demo ? 83_400 : state.acc + (state.running ? state.now - state.startAt : 0);
    const laps = demo ? 2 : state.laps.length;
    const lapTime = laps && !demo ? state.laps[laps - 1]! - (state.laps[laps - 2] ?? 0) : 41_200;
    const b = buttonSize();
      const tip = () => {
        const total = state.acc + (state.running ? Date.now() - state.startAt : 0);
        const last = state.laps.slice(-3).map((t, i, all) => {
          const n = state.laps.length - all.length + i;
          return `Volta ${n + 1}: ${clockTenths(t - (state.laps[n - 1] ?? 0))}`;
        });
        return [`Total ${clockTenths(total)}${state.running ? "" : total ? " · pausado" : ""}`, ...last, state.running ? "Clique para pausar · bandeira marca volta" : "Clique para iniciar"];
      };
      return (
        <HoverTip id={`tip:${ctx.instanceId}`} tip={tip} disabled={preview}>
          <Tile icon={<FluentGlyph code={0xe916} size={ui.app.icon - 4} color={ui.text} />} value={clockTenths(ms)} valueColor={ms || state.running ? ui.text : ui.muted} width={156} onClick={a?.toggle}>
            <Stack
              label={laps ? `Volta ${laps} · ${clockTenths(lapTime)}` : state.running ? "Cronômetro" : ms ? "Pausado" : "Cronômetro"}
            value={clockTenths(ms)}
              valueColor={ms || state.running ? ui.text : ui.muted}
            />
            <Row style={{ gap: 4 }}>
            {state.running || demo ? (
                <RoundButton size={b} onClick={() => a?.lap()}>
                  {flag(Math.round(b / 2))}
                </RoundButton>
              ) : ms ? (
                <RoundButton size={b} onClick={() => a?.reset()}>
                  {resetGlyph(Math.round(b / 2))}
                </RoundButton>
            ) : null}
            <RoundButton size={b} background={state.running ? "#2a2a2e" : ui.green} onClick={() => a?.toggle()}>
              {state.running ? glyphs.pause(Math.round(b * 0.45)) : glyphs.play(Math.round(b * 0.45))}
            </RoundButton>
          </Row>
        </Tile>
      </HoverTip>
    );
  },
});
