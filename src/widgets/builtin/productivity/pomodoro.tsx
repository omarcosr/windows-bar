import { store, toRaw } from "@tarve/core";
import { ui } from "../../../theme";
import { HoverTip } from "../../../menu/hover-tip";
import { RoundButton, Tile, glyphs } from "../../ui";
import { defineWidget, type WidgetContext } from "../../types";
import { Stack, buttonSize, clock, endsAt, flashBackground, minuteOptions, ring, Ring } from "./shared";
import { onConfigSaved } from "../../../config";
import { onClock } from "../../../services/clock";

type Phase = "focus" | "short" | "long";
const PHASE_LABEL: Record<Phase, string> = { focus: "Foco", short: "Pausa", long: "Pausa longa" };
const PHASE_COLOR: Record<Phase, string> = { focus: ui.red, short: ui.green, long: ui.blue };

interface Config {
  focus: string;
  short: string;
  long: string;
  rounds: string;
  autoStart: boolean;
  sound: boolean;
}

const actions = new WeakMap<object, { toggle(): void; skip(): void; reset(): void }>();

function minutes(ctx: WidgetContext<Config>, phase: Phase) {
  return Math.max(1, Number(ctx.config[phase]) || 1) * 60_000;
}

export default defineWidget<Config, ReturnType<typeof makeState>>({
  type: "productivity-pomodoro",
  name: "Pomodoro",
  description: "Rodadas de foco e pausas. Clique para iniciar ou pausar; pule a fase pelo botão ou pelo menu.",
  category: "productivity",
  defaultConfig: { focus: "25", short: "5", long: "15", rounds: "4", autoStart: false, sound: true },
  settings: [
    { kind: "choice", key: "focus", label: "Foco", options: minuteOptions([15, 20, 25, 30, 45, 50, 60, 90]) },
    { kind: "choice", key: "short", label: "Pausa", options: minuteOptions([3, 5, 10, 15]) },
    { kind: "choice", key: "long", label: "Pausa longa", options: minuteOptions([10, 15, 20, 30]) },
    {
      kind: "choice",
      key: "rounds",
      label: "Pausa longa a cada",
      options: [2, 3, 4, 5, 6].map((n) => ({ value: String(n), label: `${n} rodadas` })),
    },
    { kind: "toggle", key: "autoStart", label: "Emendar a próxima fase automaticamente" },
    { kind: "toggle", key: "sound", label: "Som ao terminar uma fase" },
  ],
  setup(ctx) {
    const state = makeState(minutes(ctx, "focus"));
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
        ring(state, ctx.config.sound);
        next(true);
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
    const start = () => {
      state.endsAt = Date.now() + state.left;
      state.running = true;
    };
    const pause = () => {
      state.left = Math.max(0, state.endsAt - Date.now());
      state.running = false;
    };
    const next = (finished: boolean) => {
      if (state.phase === "focus") {
        state.round++;
        const every = Math.max(1, Number(ctx.config.rounds) || 4);
        state.phase = state.round % every === 0 ? "long" : "short";
      } else state.phase = "focus";
      state.total = state.left = minutes(ctx, state.phase);
      const keep = finished ? ctx.config.autoStart : state.running;
      state.running = false;
      if (keep) start();
    };
    // Durations changed in the settings while idle: show the new length.
    ctx.onDispose(
      onConfigSaved(() => {
        if (!state.running && state.left === state.total && state.total !== minutes(ctx, state.phase))
          state.total = state.left = minutes(ctx, state.phase);
      }),
    );
    actions.set(toRaw(state), {
      toggle: replan(() => {
        state.flashUntil = 0;
        if (state.running) pause();
        else start();
        state.now = Date.now();
      }),
      skip: replan(() => {
        state.flashUntil = 0;
        const was = state.running;
        if (was) pause();
        state.running = was;
        next(false);
        state.now = Date.now();
      }),
      reset: replan(() => {
        state.running = false;
        state.flashUntil = 0;
        state.phase = "focus";
        state.round = 0;
        state.total = state.left = minutes(ctx, "focus");
        state.now = Date.now();
      }),
    });
    return state;
  },
  menu({ state }) {
    const a = actions.get(toRaw(state))!;
    return [
      [
        { label: state.running ? "Pausar" : "Iniciar", icon: state.running ? "pause" : "play", onSelect: a.toggle },
        { label: `Pular para ${state.phase === "focus" ? "a pausa" : "o foco"}`, icon: "skip-forward", onSelect: a.skip },
        { label: "Reiniciar o ciclo", icon: "skip-back", onSelect: a.reset },
      ],
    ];
  },
  View({ state, ctx, preview }) {
    const a = actions.get(toRaw(state));
    const left = preview && !state.running ? 17 * 60_000 + 42_000 : state.running ? state.endsAt - state.now : state.left;
    const progress = state.total ? 1 - left / state.total : 0;
    const size = Math.min(30, ui.tile.control);
    const round = (state.round % 100) + (state.phase === "focus" ? 1 : 0);
      const tip = () => [
        `${PHASE_LABEL[state.phase]} · rodada ${round} de ${ctx.config.rounds}`,
        state.running ? `Faltam ${clock(state.endsAt - Date.now())} · termina às ${endsAt(state.endsAt - Date.now())}` : `${clock(state.left)} · ${state.left === state.total ? "pronto para iniciar" : "pausado"}`,
        state.running ? "Clique para pausar" : "Clique para iniciar",
      ];
      const button = buttonSize();
      return (
        <HoverTip id={`tip:${ctx.instanceId}`} tip={tip} disabled={preview}>
          <Tile width={ui.tile.height >= 46 ? 160 : 150} onClick={a?.toggle} background={flashBackground(state)} padding={{ left: 8, right: 8 }}>
            <Ring value={progress} size={size} color={PHASE_COLOR[state.phase]} label={String(round)} />
            <Stack label={state.running || state.left !== state.total ? PHASE_LABEL[state.phase] : `${PHASE_LABEL[state.phase]} · pronto`} value={clock(left)} />
          <RoundButton size={button} onClick={() => a?.skip()}>
            {glyphs.next(Math.round(button / 2))}
          </RoundButton>
        </Tile>
      </HoverTip>
    );
  },
});

function makeState(total: number) {
  return store({
    phase: "focus" as Phase,
    running: false,
    endsAt: 0,
    left: total,
    total,
    round: 0,
    now: Date.now(),
    flashUntil: 0,
  });
}
