import { Path, Svg, Text, View } from "@tarve/core";
import { system, systemPoller } from "../../../services/system";
import { gpuThermal, hottestSensor, thermal, zoneThermal, type GpuTemperature, type Hottest } from "../../../services/thermal";
import { launch } from "../../../services/windows";
import { numeric, ui } from "../../../theme";
import { Sparkline, Tile } from "../../ui";
import type { DockMenuItem } from "../../../menu/dock-menu";
import { defineWidget } from "../../types";
import { Metric, amber } from "./shared";

/** Temperature colour: green, amber from 70 °C (or the driver's warning level), red from 85 °C. */
const heatTone = (celsius: number, warningC = 0) =>
  celsius >= (warningC > 0 ? Math.min(warningC, 85) : 85) ? ui.danger : celsius >= 70 ? amber : ui.green;

const degrees = (celsius: number) => `${Math.round(celsius)}°`;

/** Task Manager opened on its Performance page, where it shows the GPU temperature. */
const taskManager = () => launch("taskmgr.exe");

const menu = (): DockMenuItem[][] => [[{ label: "Gerenciador de Tarefas", icon: "info", onSelect: taskManager }]];

const isPreview = (id: string) => id.startsWith("preview:");

/** Open ring (270°, gap at the bottom) filled clockwise from its lower-left end, like a gauge. */
function ArcGauge(props: { value: number; color: string; size: number; children?: unknown }) {
  const { size } = props;
  const stroke = Math.max(3, Math.round(size / 9));
  const r = (size - stroke) / 2;
  const c = size / 2;
  const start = (3 / 4) * Math.PI; // 135°: lower left
  const sweep = (3 / 2) * Math.PI; // 270°
  const at = (a: number) => `${(c + r * Math.cos(a)).toFixed(2)} ${(c + r * Math.sin(a)).toFixed(2)}`;
  const arc = (from: number, to: number) => `M ${at(from)} A ${r} ${r} 0 ${to - from > Math.PI ? 1 : 0} 1 ${at(to)}`;
  const f = Math.max(0, Math.min(1, props.value));
  return (
    <View style={{ width: size, height: size, shrink: 0 }}>
      <Svg width={size} height={size} viewBox={[0, 0, size, size]}>
        <Path d={arc(start, start + sweep)} fill="none" stroke={ui.track} stroke-width={stroke} stroke-linecap="round" />
        {f > 0.005 ? (
          <Path d={arc(start, start + sweep * f)} fill="none" stroke={props.color} stroke-width={stroke} stroke-linecap="round" />
        ) : null}
      </Svg>
      <View style={{ position: "absolute", left: 0, top: 0, width: size, height: size, align: "center", justify: "center" }}>
        {props.children as never}
      </View>
    </View>
  );
}

/**
 * A load on one line: label, a thin bar that grows with it, the percentage. One line each, so two
 * fit the tile's height on every bar size (stacked label over bar overflowed the 36 px tile).
 */
function LoadBar(props: { label: string; value: number }) {
  const v = Math.max(0, Math.min(100, props.value));
  return (
    <View style={{ direction: "row", align: "center", gap: 6, height: 13 }}>
      <Text size={10} weight={600} color={ui.muted} style={{ width: 24, lineHeight: 1 }}>
        {props.label}
      </Text>
      <View style={{ flex: 1, minWidth: 0, height: 4, radius: 2, background: ui.track }}>
        <View style={{ width: `${Math.max(4, v)}%`, height: 4, radius: 2, background: ui.blue, transition: { width: { duration: 400, easing: "easeOut" } } }} />
      </View>
      <Text size={10} weight={700} color={ui.text} style={{ ...numeric, width: 28, textAlign: "right", lineHeight: 1 }}>
        {`${Math.round(v)}%`}
      </Text>
    </View>
  );
}

const demoHottest: Hottest = { celsius: 62, source: "GPU", maxC: 100 };

export const temperature = defineWidget({
  type: "hardware-temperature",
  name: "Temperatura",
  description: "Sensor mais quente que o Windows informa (GPU ou zona térmica ACPI), com uso de CPU e RAM.",
  category: "system",
  defaultConfig: {},
  setup(ctx) {
    // The gallery shows demo values: no sensor is opened there.
    if (!isPreview(ctx.instanceId)) {
      ctx.onDispose(gpuThermal.acquire());
      ctx.onDispose(zoneThermal.acquire());
      ctx.onDispose(systemPoller.acquire());
    }
    return {};
  },
  menu,
  hidden: ({ ctx }) => !isPreview(ctx.instanceId) && !hottestSensor(),
  View({ preview }) {
    const live = hottestSensor();
    const hot = live ?? (preview ? demoHottest : null);
    const demo = preview && !live;
    const cpu = demo ? 23 : system.cpu;
    const ram = demo ? 58 : system.ram;
    if (!hot) return <Tile width={64} />;
    const tone = heatTone(hot.celsius);
    const size = ui.tile.height - 6;
    return (
      <Tile width={size + 130} padding={{ left: 4, right: 10 }} gap={8} onClick={taskManager}>
        <ArcGauge value={hot.celsius / hot.maxC} color={tone} size={size}>
          <Text size={Math.round(size * 0.3)} weight={700} color={ui.text} style={{ ...numeric, lineHeight: 1 }}>
            {degrees(hot.celsius)}
          </Text>
        </ArcGauge>
        <View style={{ direction: "column", justify: "center", gap: 4, flex: 1, minWidth: 0 }}>
          <LoadBar label="CPU" value={cpu} />
          <LoadBar label="RAM" value={ram} />
        </View>
      </Tile>
    );
  },
});

const demoGpu: GpuTemperature = { name: "GPU", celsius: 58, warningC: 0, maxC: 89, fanRpm: 1450 };
const demoHistory = [52, 53, 55, 54, 57, 59, 58, 60, 58, 57, 58];

export const gpuTemperature = defineWidget({
  type: "hardware-gpu-temperature",
  name: "Temperatura da GPU",
  description: "Temperatura da GPU como o Gerenciador de Tarefas mostra, com histórico e ventoinha quando o driver informa.",
  category: "system",
  defaultConfig: {},
  setup(ctx) {
    if (!isPreview(ctx.instanceId)) ctx.onDispose(gpuThermal.acquire());
    return {};
  },
  menu,
  hidden: ({ ctx }) => !isPreview(ctx.instanceId) && !thermal.gpus.length,
  View({ preview }) {
    const live = thermal.gpus[0];
    const gpu = live ?? (preview ? demoGpu : null);
    if (!gpu) return <Tile width={64} />;
    const history = live ? thermal.gpuHistory : demoHistory;
    const tone = heatTone(gpu.celsius, gpu.warningC);
    const fan = gpu.fanRpm !== null ? ` · ${gpu.fanRpm.toLocaleString("pt-BR")} rpm` : "";
    return (
      <Tile width={gpu.fanRpm !== null ? 168 : 128} onClick={taskManager}>
        <Metric label="GPU" value={`${gpu.celsius.toLocaleString("pt-BR", { maximumFractionDigits: 0 })} °C${fan}`} color={tone} />
        <View style={{ shrink: 0 }}>
          <Sparkline values={history} width={44} height={20} color={tone} />
        </View>
      </Tile>
    );
  },
});
