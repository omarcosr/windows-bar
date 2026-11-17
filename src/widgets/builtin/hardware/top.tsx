import { Image, Row, Text, View } from "@tarve/core";
import { formatBytes, processes, processPoller, type TopProcess } from "../../../services/hardware-perf";
import { iconFor } from "../../../services/icons";
import { launch } from "../../../services/windows";
import { devicePx, numeric, ui } from "../../../theme";
import { Tile } from "../../ui";
import type { DockMenuItem } from "../../../menu/dock-menu";
import { defineWidget } from "../../types";
import { loadTone } from "./shared";

const taskManager = () => launch("taskmgr.exe");

const DEMO_CPU: TopProcess[] = [
  { name: "chrome", path: "", count: 14, value: 12.4 },
  { name: "Code", path: "", count: 9, value: 6.1 },
  { name: "explorer", path: "", count: 1, value: 1.8 },
];
const DEMO_RAM: TopProcess[] = [
  { name: "chrome", path: "", count: 14, value: 1.9 * 1024 ** 3 },
  { name: "Code", path: "", count: 9, value: 812 * 1024 ** 2 },
  { name: "Teams", path: "", count: 4, value: 420 * 1024 ** 2 },
];

function ProcessIcon(props: { item: TopProcess }) {
  const size = devicePx(16, true);
  const icon = props.item.path ? iconFor(props.item.path, size) : undefined;
  if (icon) return <Image src={icon} width={size} height={size} fit="contain" style={{ shrink: 0 }} />;
  return (
    <View style={{ width: size, height: size, radius: 4, background: ui.track, align: "center", justify: "center", shrink: 0 }}>
      <Text size={9} weight={700} color={ui.muted}>
        {props.item.name.slice(0, 1).toUpperCase()}
      </Text>
    </View>
  );
}

function Entry(props: { item: TopProcess; value: string; color: string }) {
  return (
    <Row style={{ align: "center", gap: 5, width: 76, shrink: 0 }}>
      <ProcessIcon item={props.item} />
      <View style={{ direction: "column", gap: 0, flex: 1, minWidth: 0 }}>
        <Text size={10} weight={600} color={ui.text} style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {props.item.name}
        </Text>
        <Text size={10} weight={700} color={props.color} style={{ ...numeric, whiteSpace: "nowrap" }}>
          {props.value}
        </Text>
      </View>
    </Row>
  );
}

const menu = (): DockMenuItem[][] => [
  [
    { label: "Gerenciador de Tarefas", icon: "info", onSelect: taskManager },
    { label: "Monitor de Recursos", icon: "search", onSelect: () => launch("resmon.exe") },
  ],
];

const pctText = (v: number) => `${v.toLocaleString("pt-BR", { maximumFractionDigits: v < 10 ? 1 : 0, minimumFractionDigits: v < 10 ? 1 : 0 })}%`;

export const topCpu = defineWidget({
  type: "hardware-top-cpu",
  name: "Top CPU",
  description: "Os 3 programas que mais usam o processador agora, agrupados por executável. Clique abre o Gerenciador de Tarefas.",
  category: "system",
  defaultConfig: {},
  setup(ctx) {
    ctx.onDispose(processPoller.acquire());
    return {};
  },
  menu,
  View({ preview }) {
    const list = preview && !processes.ready ? DEMO_CPU : processes.topCpu;
    return (
      <Tile width={256} padding={{ left: 10, right: 10 }} gap={6} onClick={taskManager}>
        {list.map((p) => (
          <Entry key={p.name} item={p} value={pctText(p.value)} color={loadTone(p.value)} />
        ))}
      </Tile>
    );
  },
});

export const topRam = defineWidget({
  type: "hardware-top-ram",
  name: "Top RAM",
  description: "Os 3 programas com mais memória (conjunto de trabalho privado), agrupados por executável como no Gerenciador de Tarefas.",
  category: "system",
  defaultConfig: {},
  setup(ctx) {
    ctx.onDispose(processPoller.acquire());
    return {};
  },
  menu,
  View({ preview }) {
    const list = preview && !processes.topRam.length ? DEMO_RAM : processes.topRam;
    return (
      <Tile width={256} padding={{ left: 10, right: 10 }} gap={6} onClick={taskManager}>
        {list.map((p) => (
          <Entry key={p.name} item={p} value={formatBytes(p.value, p.value >= 1024 ** 3 ? 1 : 0)} color={ui.text} />
        ))}
      </Tile>
    );
  },
});
