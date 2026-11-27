import { Column, Text } from "@tarve/core";
import { HoverTip } from "../../../menu/hover-tip";
import type { DockMenuItem } from "../../../menu/dock-menu";
import { acquireScreenTime, formatDuration, topApps, usageOf } from "../../../services/launcher-screen-time";
import { activateApp } from "../../../services/windows";
import { numeric, ui } from "../../../theme";
import { Sparkline, Tile } from "../../ui";
import { FluentGlyph } from "../../../menu/dock-menu";
import { defineWidget } from "../../types";
import { shellMenuIcon, fluentGlyph } from "./shared";

import { t } from "../../../i18n";
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
  name: t("widgets.launcher.screenTime.screenTime"),
  description: t("widgets.launcher.screenTime.howLongYouSpent"),
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
      [{ label: t("widgets.launcher.screenTime.today", { p0: formatDuration(usageOf().total) }), icon: { fluent: fluentGlyph.clock }, onSelect: () => {} }],
      today.length ? today : none(t("widgets.launcher.screenTime.nothingCountedToday")),
      [{ label: t("widgets.launcher.screenTime.thisWeek"), icon: { fluent: fluentGlyph.timeline }, onSelect: () => {} }],
      week.length ? week : none(t("widgets.launcher.screenTime.nothingCountedThisWeek")),
    ];
  },
  View({ ctx, preview }) {
    const lines = ui.tile.lines;
    const day = usageOf();
    const hour = new Date().getHours();
    const real = day.hours.slice(0, hour + 1);
    const hours = preview && day.total === 0 ? DEMO_HOURS : real.length >= 2 ? real : [0, ...real];
    const total = preview && day.total === 0 ? 7.6 * 3600 : day.total;
    const chartHeight = Math.max(14, Math.min(32, ui.tile.height - 14));
    const tip = () => [
      t("widgets.launcher.screenTime.todayWithPcIn", { p0: formatDuration(usageOf().total) }),
      ...topApps(1, 3).map((app) => `${app.name || app.key}: ${formatDuration(app.seconds)}`),
      t("widgets.launcher.screenTime.countsAppInForeground"),
      t("widgets.launcher.screenTime.moreThan5Min"),
      t("widgets.launcher.screenTime.chartMinutesPerHour"),
      ];
      return (
      <HoverTip id={`tip:${ctx.instanceId}`} tip={tip} disabled={preview}>
      <Tile icon={<FluentGlyph code={0xe7f4} size={ui.app.icon - 4} color={ui.blue} />} value={formatDuration(total)} width={150} padding={{ left: 10, right: 10 }} gap={8}>
        <Column style={{ gap: lines.gap, width: 58 }}>
          <Text size={lines.secondary} color={ui.muted} style={{ lineHeight: lines.lineHeight }}>
            {t("widgets.launcher.screenTime.today2")}
          </Text>
          <Text size={lines.primary} weight={700} color={ui.text} style={{ ...numeric, lineHeight: lines.lineHeight, whiteSpace: "nowrap" }}>
            {formatDuration(total)}
          </Text>
        </Column>
        <Sparkline values={hours} width={64} height={chartHeight} color={ui.blue} />
      </Tile>
      </HoverTip>
    );
  },
});
