import { Column, Row, Text, View } from "@tarve/core";
import { HoverTip } from "../../../menu/hover-tip";
import type { DockMenuItem } from "../../../menu/dock-menu";
import { acquireScreenTime, formatDuration, kindInfo, kindOf, usageOf, type AppKind, type DayUsage } from "../../../services/launcher-screen-time";
import { numeric, ui } from "../../../theme";
import { Tile } from "../../ui";
import { defineWidget } from "../../types";

/** The day in 20-minute cells, each colored by the kind of app used most in it. */
const CELLS = 72;
const CELL_S = 86_400 / CELLS;
const BAR_WIDTH = 180;

function cells(day: DayUsage): (AppKind | null)[] {
  const out: Map<AppKind, number>[] = Array.from({ length: CELLS }, () => new Map());
  for (const [start, end, key] of day.spans) {
    const kind = kindOf(key, day.apps[key]);
    for (let c = Math.floor(start / CELL_S); c <= Math.min(CELLS - 1, Math.floor(end / CELL_S)); c++) {
      const overlap = Math.min(end, (c + 1) * CELL_S) - Math.max(start, c * CELL_S);
      if (overlap > 0) out[c]!.set(kind, (out[c]!.get(kind) ?? 0) + overlap);
    }
  }
  return out.map((m) => {
    let best: AppKind | null = null;
    let most = 0;
    for (const [k, s] of m) if (s > most) [best, most] = [k, s];
    return best;
  });
}

function demoDay(): DayUsage {
  const day: DayUsage = { total: 0, hours: new Array(24).fill(0), apps: {}, spans: [] };
  const add = (from: number, to: number, key: string) => {
    day.spans.push([from * 3600, to * 3600, key]);
    day.total += (to - from) * 3600;
  };
  add(8.5, 10, "code.exe");
  add(10, 10.7, "teams.exe");
  add(10.7, 12.2, "chrome.exe");
  add(13.3, 15.5, "code.exe");
  add(15.5, 16, "spotify.exe");
  add(16, 17.6, "winword.exe");
  return day;
}

function kindTotals(day: DayUsage) {
  const totals = new Map<AppKind, number>();
  for (const [key, app] of Object.entries(day.apps)) {
    const kind = kindOf(key, app);
    totals.set(kind, (totals.get(kind) ?? 0) + app.seconds);
  }
  return [...totals.entries()].sort((a, b) => b[1] - a[1]);
}

export default defineWidget({
  type: "launcher-day-timeline",
  name: "Linha do dia",
  description: "O dia de hoje numa linha, colorida pelo tipo de app em uso (dados do Tempo de tela).",
  category: "productivity",
  defaultConfig: {},
  setup(ctx) {
    ctx.onDispose(acquireScreenTime());
    return {};
  },
  menu() {
    const day = usageOf();
    const items: DockMenuItem[] = kindTotals(day).map(([kind, seconds]) => ({
      label: `${kindInfo[kind].label} — ${formatDuration(seconds)}`,
      icon: [["circle", { cx: 12, cy: 12, r: 6, fill: kindInfo[kind].color, stroke: "none" }]],
      onSelect: () => {},
    }));
    return [items.length ? items : [{ label: "Nada contado hoje", onSelect: () => {} }]];
  },
  View({ ctx, preview }) {
    const real = usageOf();
    const day = preview && real.total === 0 ? demoDay() : real;
    const list = cells(day);
    const now = preview ? CELLS : Math.floor(((Date.now() - new Date().setHours(0, 0, 0, 0)) / 1000) / CELL_S);
    const cell = BAR_WIDTH / CELLS;
    const lines = ui.tile.lines;
    // The hour scale needs a 44 px tile (the 56 px bar); below it the title and the line fit and the
      // scale is in the tooltip (three lines in a 28-36 px tile were cut at the top).
      const scale = ui.tile.height >= 44;
      const tip = () => [
        `Hoje: ${formatDuration(usageOf().total)} com o PC em uso`,
        ...kindTotals(usageOf()).map(([kind, seconds]) => `${kindInfo[kind].label}: ${formatDuration(seconds)}`),
        "Cada trecho é 20 min, colorido pelo tipo de app mais usado nele",
        "De 0h a 24h; ausências de mais de 5 min não contam",
      ];
      return (
        <HoverTip id={`tip:${ctx.instanceId}`} tip={tip} disabled={preview}>
        <Tile width={BAR_WIDTH + 20} padding={{ left: 10, right: 10 }}>
        <Column style={{ gap: scale ? Math.max(4, lines.gap + 3) : ui.tile.height < 32 ? 3 : 5, flex: 1, justify: "center" }}>
          <Row style={{ align: "center" }}>
            <Text size={lines.secondary} color={ui.muted} style={{ flex: 1, lineHeight: 1.2 }}>
              Hoje
            </Text>
            <Text size={lines.secondary} weight={700} color={ui.text} style={{ ...numeric, lineHeight: 1.2 }}>
              {formatDuration(day.total)}
            </Text>
          </Row>
          <Row style={{ height: 8, radius: 4, overflow: "hidden", background: ui.track, width: BAR_WIDTH }}>
            {list.map((kind, i) => (
              <View
                style={{
                  width: cell,
                  height: 8,
                  background: kind ? kindInfo[kind].color : i < now ? "#3a3a40" : ui.track,
                  shrink: 0,
                }}
              />
            ))}
          </Row>
          {scale ? (
            <Row>
              {["0h", "6h", "12h", "18h", "24h"].map((label, i) => (
                <Text size={9} color={ui.faint} style={{ flex: i === 4 ? 0 : 1, lineHeight: 1.15 }}>
                    {label}
                  </Text>
                ))}
              </Row>
            ) : null}
        </Column>
      </Tile>
      </HoverTip>
    );
  },
});
