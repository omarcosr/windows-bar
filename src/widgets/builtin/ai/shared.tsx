import { Row, Text, View, store, toRaw } from "@tarve/core";
import { numeric, ui } from "../../../theme";
import { Meter } from "../../ui";
import type { WidgetContext } from "../../types";
import { onClock, type ClockSubscription } from "../../../services/clock";
import { aiUsage, resetLabel, type LimitUsage, type LocalUsage, type UsageWindow } from "../../../services/ai-usage";
import { oneRow } from "../finance/shared";

import { t, language } from "../../../i18n";
/**
 * Below 34 px (the 40–44 px bar's 28 px tile) the AI tiles follow finance/shared's oneRow: a title
 * and its value go on one row, and two meter rows tighten to 1.1 lines with no gap between them so
 * both fit; whatever is left out is in the tile's tip.
 */
export const short = oneRow;
/** The line height of a meter-row text: tight on a short tile, the font's own above. */
export const tight = () => (short() ? { lineHeight: 1.1 } : {});
/** The gap between two meter rows: none on a short tile. */
export const rowGap = (gap: number) => (short() ? 0 : gap);


export const brand = {
  claude: { color: "#d97757", letter: "C", name: "Claude" },
  codex: { color: "#10a37f", letter: "◎", name: "Codex" },
  opencode: { color: "#3b3b40", letter: "O", name: "OpenCode" },
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
      <Text size={10} weight={600} color={ui.muted} style={{ ...tight(), width: 22 }}>
        {props.label}
      </Text>
      <Meter value={used / 100} width={props.meter ?? 52} color={tone(used)} />
      <Text size={11} weight={700} color={props.window ? ui.text : ui.faint} style={{ ...numeric, ...tight(), width: 30, textAlign: "right" }}>
        {props.window ? `${used}%` : "—"}
      </Text>
      {reset ? (
        <Text size={10} color={ui.muted} style={{ ...numeric, ...tight() }}>
          {reset}
        </Text>
      ) : null}
    </Row>
  );
}

/** The line shown instead of the meters when there is nothing to draw ("não instalado", "abra o Claude Code"). */
export function StatusLine(props: { usage: LimitUsage | LocalUsage }) {
  const u = props.usage;
  const text = u.status === "loading" ? t("widgets.ai.shared.loading") : u.note || (u.status === "error" ? t("widgets.ai.shared.unavailable") : "");
  return (
    <Text size={10} color={u.status === "expired" ? "#ff9f0a" : ui.muted}>
      {text}
    </Text>
  );
}

export const showsData = (u: LimitUsage | LocalUsage) => u.status === "ok";

const timeFormat = new Intl.DateTimeFormat(language, { hour: "2-digit", minute: "2-digit" });
const dayFormat = new Intl.DateTimeFormat(language, { weekday: "short", day: "2-digit", month: "2-digit" });

/** "hoje às 16:40", "amanhã às 09:00", "dom., 18/05 às 01:00". */
export function whenLabel(ms: number) {
  const day = new Date(ms);
  day.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((day.getTime() - today.getTime()) / 86_400_000);
  const date = diff === 0 ? t("widgets.ai.shared.today") : diff === 1 ? t("widgets.ai.shared.tomorrow") : diff === -1 ? t("widgets.ai.shared.yesterday") : dayFormat.format(new Date(ms));
  return t("widgets.ai.shared.at", { date, p1: timeFormat.format(new Date(ms)) });
}

/** "Sessão de 5 h: 37% usado, renova em 2h 12min (hoje às 16:40)". */
export function windowLine(label: string, w: UsageWindow | null) {
  if (!w) return t("widgets.ai.shared.noData", { label });
  const reset = w.resetsAt ? t("widgets.ai.shared.resetsIn", { p0: resetLabel(w.resetsAt), p1: whenLabel(w.resetsAt) }) : "";
  return t("widgets.ai.shared.used", { label, used: w.used, reset });
}

/**
 * The tip of a plan-limit tile: each window with its reset, where the numbers come from and when
 * they were read, and what a click does.
 */
export function limitTip(options: { name: string; usage: LimitUsage; source: string; preview?: boolean; click?: string; windows?: ("session" | "weekly" | "model")[] }) {
  const u = options.usage;
  const lines = [`${options.name}${u.plan ? t("widgets.ai.shared.plan", { plan: u.plan }) : ""}`];
  if (u.status !== "ok") lines.push(u.note || (u.status === "loading" ? t("widgets.ai.shared.loading2") : t("widgets.ai.shared.unavailable2")));
  else {
    const windows = options.windows ?? ["session", "weekly", "model"];
    if (windows.includes("session")) lines.push(windowLine(t("widgets.ai.shared.n5HourSession"), u.session));
    if (windows.includes("weekly") && u.weekly) lines.push(windowLine(t("widgets.ai.shared.weeklyLimit"), u.weekly));
    if (windows.includes("model") && u.weeklyModel) lines.push(windowLine(t("widgets.ai.shared.weeklyFor", { label: u.weeklyModel.label }), u.weeklyModel));
  }
  lines.push(options.preview ? t("widgets.ai.shared.sampleData") : t("widgets.ai.shared.source", { source: options.source, p1: u.updated ? t("widgets.ai.shared.read", { p0: whenLabel(u.updated) }) : "" }));
  if (options.click) lines.push(options.click);
  return lines;
}

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
