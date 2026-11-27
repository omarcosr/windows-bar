import { Text } from "@tarve/core";
import { system, systemPoller } from "../../../services/system";
import { launch } from "../../../services/windows";
import { numeric, ui } from "../../../theme";
import { Tile } from "../../ui";
import type { DockMenuItem } from "../../../menu/dock-menu";
import { defineWidget } from "../../types";
import { Metric, Ring, loadTone } from "./shared";

import { t, language } from "../../../i18n";
const taskManager = () => launch("taskmgr.exe");

const perfMenu = (): DockMenuItem[][] => [
  [
    { label: t("widgets.hardware.rings.taskManager"), icon: "info", onSelect: taskManager },
    { label: t("widgets.hardware.rings.resourceMonitor"), icon: "search", onSelect: () => launch("resmon.exe") },
  ],
];

function RingTile(props: { label: string; percent: number; detail: string; tipId: string; tip: () => string[]; preview: boolean }) {
  const tone = loadTone(props.percent);
  return (
    <Tile lead="round" onClick={taskManager} preview={props.preview} tip={{ id: props.tipId, lines: props.tip }}>
      <Ring value={props.percent / 100} color={tone}>
        <Text size={9} weight={700} color={ui.text} style={numeric}>
          {String(props.percent)}
        </Text>
      </Ring>
      <Metric label={props.label} value={props.detail} />
    </Tile>
  );
}

export const cpuRing = defineWidget({
  type: "hardware-cpu-ring",
  name: t("widgets.hardware.rings.cpuRing"),
  description: t("widgets.hardware.rings.processorUsageInRing"),
  category: "system",
  defaultConfig: {},
  setup(ctx) {
    ctx.onDispose(systemPoller.acquire());
    return {};
  },
  menu: perfMenu,
  View({ ctx, preview }) {
    const cpu = preview && !system.cpuHistory.length ? 23 : system.cpu;
    const tip = () => [t("widgets.hardware.rings.processorInUseAll", { cpu: system.cpu }), t("widgets.hardware.rings.clickTaskManager")];
    return <RingTile label="CPU" percent={cpu} detail={`${cpu}%`} tipId={`tip:${ctx.instanceId}`} tip={tip} preview={preview} />;
  },
});

export const ramRing = defineWidget({
  type: "hardware-ram-ring",
  name: t("widgets.hardware.rings.ramRing"),
  description: t("widgets.hardware.rings.memoryInUseIn"),
  category: "system",
  defaultConfig: {},
  setup(ctx) {
    ctx.onDispose(systemPoller.acquire());
    return {};
  },
  menu: perfMenu,
  View({ ctx, preview }) {
    const demo = preview && !system.ramTotalGb;
    const load = demo ? 58 : system.ram;
    const used = demo ? 9.3 : system.ramUsedGb;
    const total = demo ? 16 : system.ramTotalGb;
    const fmt = (n: number) => n.toLocaleString(language, { maximumFractionDigits: 1, minimumFractionDigits: 1 });
    const tip = () => [t("widgets.hardware.rings.memoryOfGbIn", { p0: fmt(system.ramUsedGb), p1: fmt(system.ramTotalGb), ram: system.ram }), t("widgets.hardware.rings.clickTaskManager")];
    return <RingTile label="RAM" percent={load} detail={`${fmt(used)}/${Math.round(total)} GB`} tipId={`tip:${ctx.instanceId}`} tip={tip} preview={preview} />;
  },
});
