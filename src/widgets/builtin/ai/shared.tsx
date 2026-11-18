import { Row, Text, View, store, toRaw } from "@tarve/core";
import { numeric, ui } from "../../../theme";
import { Meter } from "../../ui";
import type { WidgetContext } from "../../types";
import { onClock, type ClockSubscription } from "../../../services/clock";
import { aiUsage, resetLabel, type LimitUsage, type LocalUsage, type UsageWindow } from "../../../services/ai-usage";

export const brand = {
  claude: { color: "#d97757", letter: "C", name: "Claude" },
  codex: { color: "#10a37f", letter: "◎", name: "Codex" },
  opencode: { color: "#3b3b40", letter: "▣", name: "OpenCode" },
  gemini: { color: "#4285f4", letter: "G", name: "Gemini" },
} as const;

export type Brand = keyof typeof brand;

/** Meter colour after how much of the window is gone. */
export const tone = (used: number) => (used >= 90 ? ui.danger : used >= 70 ? "#ff9f0a" : ui.green);

/**
 * The next moment a "resets in" label (resetLabel) changes, over every reset time in `aiUsage`:
 * whole minutes below a day ("2h 13min", "5min", "agora"), the weekday and time above.
 */
function nextLabelChange(now: number): number | null {
  let next = Infinity;
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (key !== "resetsAt") visit(item);
      else if (typeof item === "number" && item > now) {
        const minutes = Math.ceil((item - now) / 60_000);
        const at = item - (Math.min(minutes, 24 * 60) - 1) * 60_000;
        if (at < next) next = at;
      }
    }
  };
  visit(toRaw(aiUsage));
  return next === Infinity ? null : next;
}

/**
 * A per-instance store whose `tick` re-renders the countdowns exactly when a shown "resets in"
 * label changes (the shared clock, not a 30 s check). New usage data renders the widget, and the
 * read of `tick` in that render re-plans the wake for the new reset times.
 */
export function ticker<C extends object>(ctx: WidgetContext<C>) {
  let sub: ClockSubscription | undefined;
  const state = store({
    count: 0,
    get tick(): number {
      sub?.update();
      return this.count;
    },
  });
  sub = onClock((now, covered) => (covered ? null : nextLabelChange(now)), () => state.count++);
  ctx.onDispose(sub.cancel);
  return state;
}

export function Logo(props: { brand: Brand; size?: number }) {
  const b = brand[props.brand];
  const size = props.size ?? 14;
  return (
    <View style={{ width: size, height: size, radius: size / 2, background: b.color, align: "center", justify: "center", shrink: 0 }}>
      <Text size={Math.round(size * 0.62)} weight={800} color="#fff">
        {b.letter}
      </Text>
    </View>
  );
}

/** "5h ▬▬▬── 37% 2h 13min" */
export function LimitRow(props: { label: string; window: UsageWindow | null; meter?: number; reset?: boolean }) {
  const used = props.window?.used ?? 0;
  const reset = props.reset === false ? "" : resetLabel(props.window?.resetsAt ?? null);
  return (
    <Row style={{ align: "center", gap: 6 }}>
      <Text size={10} weight={600} color={ui.muted} style={{ width: 22 }}>
        {props.label}
      </Text>
      <Meter value={used / 100} width={props.meter ?? 52} color={tone(used)} />
      <Text size={11} weight={700} color={props.window ? ui.text : ui.faint} style={{ ...numeric, width: 30, textAlign: "right" }}>
        {props.window ? `${used}%` : "—"}
      </Text>
      {reset ? (
        <Text size={10} color={ui.muted} style={{ ...numeric }}>
          {reset}
        </Text>
      ) : null}
    </Row>
  );
}

/** The line shown instead of the meters when there is nothing to draw ("não instalado", "abra o Claude Code"). */
export function StatusLine(props: { usage: LimitUsage | LocalUsage }) {
  const u = props.usage;
  const text = u.status === "loading" ? "carregando…" : u.note || (u.status === "error" ? "indisponível" : "");
  return (
    <Text size={10} color={u.status === "expired" ? "#ff9f0a" : ui.muted}>
      {text}
    </Text>
  );
}

export const showsData = (u: LimitUsage | LocalUsage) => u.status === "ok";

const inHours = (h: number) => Date.now() + h * 3_600_000;

export const demo = {
  claude: (): LimitUsage => ({
    status: "ok",
    note: "",
    plan: "Max",
    session: { used: 37, resetsAt: inHours(2.2) },
    weekly: { used: 58, resetsAt: inHours(76) },
    weeklyModel: { used: 64, resetsAt: inHours(76), label: "Opus" },
    updated: Date.now(),
  }),
  codex: (): LimitUsage => ({
    status: "ok",
    note: "",
    plan: "Plus",
    session: { used: 73, resetsAt: inHours(3.4) },
    weekly: { used: 41, resetsAt: inHours(98) },
    weeklyModel: null,
    updated: Date.now(),
  }),
  opencode: (): LocalUsage => ({
    status: "ok",
    note: "",
    tokens5h: 412_000,
    tokens7d: 3_840_000,
    cost5h: 0.84,
    cost7d: 6.12,
    messages7d: 643,
    top: [{ model: "deepseek-v4.1-flash", share: 72 }],
    updated: Date.now(),
  }),
  claudeModels: () => [{ model: "Opus 4.5", share: 81 }],
};
