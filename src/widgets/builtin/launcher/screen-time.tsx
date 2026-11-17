import { Column, Text } from "@tarve/core";
import type { DockMenuItem } from "../../../menu/dock-menu";
import { acquireScreenTime, formatDuration, topApps, usageOf } from "../../../services/launcher-screen-time";
import { activateApp } from "../../../services/windows";
import { numeric, ui } from "../../../theme";
import { Sparkline, Tile } from "../../ui";
import { defineWidget } from "../../types";
import { shellMenuIcon, fluentGlyph } from "./shared";

const DEMO_HOURS = [0, 0, 0, 0, 0, 0, 0, 0, 1500, 3000, 3300, 2700, 1200, 2400, 3400, 3100];

function appItems(days: number): DockMenuItem[] {
  return topApps(days, 5).map((app) => ({
    label: `${app.name || app.key} — ${formatDuration(app.seconds)}`,
    icon: shellMenuIcon(app.exe, fluentGlyph.apps),
    onSelect: () => activateApp(app.key, app.exe),
  }));
}

export default defineWidget({
  type: "launcher-screen-time",
  name: "Tempo de tela",
  description: "Quanto tempo você passou em cada app hoje e na semana (ignora ausências de mais de 5 min).",
  category: "productivity",
  defaultConfig: {},
  setup(ctx) {
    ctx.onDispose(acquireScreenTime());
    return {};
  },
  menu() {
    const today = appItems(1);
    const week = appItems(7);
    const none = (label: string): DockMenuItem[] => [{ label, icon: { fluent: fluentGlyph.clock }, onSelect: () => {} }];
    return [
      [{ label: `Hoje: ${formatDuration(usageOf().total)}`, icon: { fluent: fluentGlyph.clock }, onSelect: () => {} }],
      today.length ? today : none("Nada contado hoje"),
      [{ label: "Esta semana", icon: { fluent: fluentGlyph.timeline }, onSelect: () => {} }],
      week.length ? week : none("Nada contado na semana"),
    ];
  },
  View({ preview }) {
    const lines = ui.tile.lines;
    const day = usageOf();
    const hour = new Date().getHours();
    const real = day.hours.slice(0, hour + 1);
    const hours = preview && day.total === 0 ? DEMO_HOURS : real.length >= 2 ? real : [0, ...real];
    const total = preview && day.total === 0 ? 7.6 * 3600 : day.total;
    const chartHeight = Math.max(16, ui.tile.height - 16);
    return (
      <Tile width={150} padding={{ left: 10, right: 10 }} gap={8}>
        <Column style={{ gap: lines.gap, width: 58 }}>
          <Text size={lines.secondary} color={ui.muted} style={{ lineHeight: lines.lineHeight }}>
            Hoje
          </Text>
          <Text size={lines.primary} weight={700} color={ui.text} style={{ ...numeric, lineHeight: lines.lineHeight, whiteSpace: "nowrap" }}>
            {formatDuration(total)}
          </Text>
        </Column>
        <Sparkline values={hours} width={64} height={chartHeight} color={ui.blue} />
      </Tile>
    );
  },
});
