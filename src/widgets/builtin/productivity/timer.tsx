import { Column, Text, store, toRaw } from "@tarve/core";
import { numeric, ui } from "../../../theme";
import { RoundButton, Tile, glyphs } from "../../ui";
import { defineWidget } from "../../types";
import type { DockMenuItem } from "../../../menu/dock-menu";
import { clock, flashBackground, minuteOptions, ring, Ring } from "./shared";
import { onClock } from "../../../services/clock";

const PRESETS = [1, 3, 5, 10, 15, 20, 25, 30, 45, 60];

interface Config {
  preset: string;
  sound: boolean;
}

const actions = new WeakMap<object, { click(): void; startFor(min: number): void; add(min: number): void; cancel(): void; toggle(): void }>();

export default defineWidget<Config, ReturnType<typeof makeState>>({
  type: "productivity-timer",
  name: "Timer",
  description: "Contagem regressiva com um clique. Outros tempos e +1 min no menu.",
  category: "productivity",
  defaultConfig: { preset: "5", sound: true },
  settings: [
    { kind: "choice", key: "preset", label: "Tempo do clique", options: minuteOptions(PRESETS) },
    { kind: "toggle", key: "sound", label: "Som ao terminar" },
  ],
  setup(ctx) {
    const state = makeState();
    // On the shared clock, only when the shown value changes: the next whole second of the countdown
    // (its end rings even behind a full-screen app) and each half-second frame of the end flash.
    // An idle one wakes nothing.
    const sub = onClock((now, covered) => {
      const left = state.endsAt - now;
      if (state.running) return covered || left <= 0 ? state.endsAt : now + (left % 1000 || 1000);
      if (state.now < state.flashUntil) return covered ? null : Math.min(Math.floor(now / 500) * 500 + 500, state.flashUntil);
      return null;
    }, (now) => {
      if (state.running && now >= state.endsAt) {
        state.running = false;
        state.active = false;
        state.left = 0;
        ring(state, ctx.config.sound);
      }
      // While counting, redraw when the shown second changes; while flashing, each frame and its end.
      if (state.running) {
        if (Math.ceil((state.endsAt - now) / 1000) !== Math.ceil((state.endsAt - state.now) / 1000)) state.now = now;
      } else if (state.now < state.flashUntil) state.now = now;
    });
    ctx.onDispose(sub.cancel);
    /** Runs an action, then re-plans the wake (started, paused, cancelled). */
    const replan = <A extends unknown[]>(fn: (...args: A) => void) => (...args: A) => {
      fn(...args);
      sub.update();
    };
    const startFor = (min: number) => {
      state.total = state.left = min * 60_000;
      state.endsAt = Date.now() + state.left;
      state.running = true;
      state.active = true;
      state.flashUntil = 0;
      state.now = Date.now();
    };
    const toggle = () => {
      if (!state.active) return startFor(Number(ctx.config.preset) || 5);
      if (state.running) {
        state.left = Math.max(0, state.endsAt - Date.now());
        state.running = false;
      } else {
        state.endsAt = Date.now() + state.left;
        state.running = true;
      }
      state.now = Date.now();
    };
    actions.set(toRaw(state), {
      click: replan(() => {
        if (Date.now() < state.flashUntil) {
          state.flashUntil = 0;
          state.now = Date.now();
        } else toggle();
      }),
      toggle: replan(toggle),
      startFor: replan(startFor),
      add: replan((min: number) => {
        if (!state.active) return startFor(min);
        state.total += min * 60_000;
        if (state.running) state.endsAt += min * 60_000;
        else state.left += min * 60_000;
        state.now = Date.now();
      }),
      cancel: replan(() => {
        state.running = false;
        state.active = false;
        state.flashUntil = 0;
        state.now = Date.now();
      }),
    });
    return state;
  },
  menu({ state }) {
    const a = actions.get(toRaw(state))!;
    const control: DockMenuItem[] = state.active
      ? [
          { label: state.running ? "Pausar" : "Continuar", icon: state.running ? "pause" : "play", onSelect: a.toggle },
          { label: "+1 min", icon: "plus", onSelect: () => a.add(1) },
          { label: "+5 min", icon: "plus", onSelect: () => a.add(5) },
          { label: "Cancelar", icon: "x", danger: true, onSelect: a.cancel },
        ]
      : [];
    return [control, PRESETS.map((m) => ({ label: `Iniciar ${m} min`, icon: "play" as const, onSelect: () => a.startFor(m) }))].filter((s) => s.length);
  },
  View({ state, ctx, preview }) {
    const a = actions.get(toRaw(state));
    const idle = !state.active;
    const left = preview && idle ? 3 * 60_000 + 12_000 : idle ? (Number(ctx.config.preset) || 5) * 60_000 : state.running ? state.endsAt - state.now : state.left;
    const progress = preview && idle ? 0.36 : idle ? 0 : 1 - left / state.total;
    const flashing = state.now < state.flashUntil;
    return (
      <Tile width={124} onClick={a?.click} background={flashBackground(state)}>
        <Ring value={flashing ? 1 : progress} size={Math.min(26, ui.tile.control)} color={flashing ? "#ff9f0a" : ui.blue} />
        <Column style={{ flex: 1, gap: 0 }}>
          <Text size={10} weight={600} color={ui.muted}>
            {flashing ? "Tempo esgotado" : idle && !preview ? "Timer" : state.running || preview ? "Restam" : "Pausado"}
          </Text>
          <Text size={15} weight={700} color={idle && !preview ? ui.muted : ui.text} style={numeric}>
            {flashing ? "0:00" : clock(left)}
          </Text>
        </Column>
        {state.active ? (
          <RoundButton size={22} onClick={() => a?.toggle()}>
            {state.running ? glyphs.pause(10) : glyphs.play(10)}
          </RoundButton>
        ) : null}
      </Tile>
    );
  },
});

function makeState() {
  return store({ active: false, running: false, endsAt: 0, left: 0, total: 1, now: Date.now(), flashUntil: 0 });
}
