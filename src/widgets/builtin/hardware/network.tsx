import { Column, Path, Polyline, Row, Svg, Text, View } from "@tarve/core";
import { formatRate, network, networkPoller } from "../../../services/hardware-perf";
import { launch } from "../../../services/windows";
import { openQuickSettings } from "../../../native/desktop";
import { numeric, ui } from "../../../theme";
import { Tile } from "../../ui";
import { defineWidget } from "../../types";

const DOWN = ui.blue;
const UP = "#bf5af2";
const DEMO_DOWN = [2, 3, 2.5, 6, 9, 7, 12, 10, 8, 14, 18, 15, 11, 9, 13, 20, 24, 19, 16, 12, 10, 14, 17, 21, 18, 15, 22, 26, 23, 20].map((v) => v * 120_000);
const DEMO_UP = [1, 1.2, 0.8, 1.5, 2, 1.6, 2.4, 2, 1.8, 2.6, 3, 2.2, 1.9, 1.7, 2.1, 3.2, 3.6, 2.8, 2.4, 2, 1.9, 2.3, 2.7, 3.1, 2.6, 2.2, 3.3, 3.8, 3.1, 2.9].map((v) => v * 60_000);

/** Download (filled) and upload (line) on one scale, from zero, as Task Manager's adapter graph. */
function Chart(props: { down: readonly number[]; up: readonly number[]; width: number; height: number }) {
  const { down, up, width, height } = props;
  const n = Math.max(down.length, up.length);
  if (n < 2) return <View style={{ width, height }} />;
  const max = Math.max(1, ...down, ...up) * 1.1;
  const pt = (v: number, i: number, len: number) => {
    const x = (i / (len - 1)) * width;
    const y = height - 1 - (v / max) * (height - 2);
    return [x.toFixed(1), y.toFixed(1)] as const;
  };
  const line = (vs: readonly number[]) => vs.map((v, i) => pt(v, i, vs.length).join(",")).join(" ");
  const area = down.length > 1 ? `M 0 ${height} L ${down.map((v, i) => pt(v, i, down.length).join(" ")).join(" L ")} L ${width} ${height} Z` : "";
  return (
    <Svg width={width} height={height} viewBox={[0, 0, width, height]}>
      {area ? <Path d={area} fill={DOWN} fill-opacity={0.22} stroke="none" /> : null}
      {down.length > 1 ? <Polyline points={line(down)} fill="none" stroke={DOWN} stroke-width={1.4} stroke-linejoin="round" /> : null}
      {up.length > 1 ? <Polyline points={line(up)} fill="none" stroke={UP} stroke-width={1.4} stroke-linejoin="round" /> : null}
    </Svg>
  );
}

function Rate(props: { arrow: string; color: string; value: number }) {
  return (
    <Row style={{ align: "center", gap: 3 }}>
      <Text size={10} weight={800} color={props.color}>
        {props.arrow}
      </Text>
      <Text size={10} weight={600} color={ui.text} style={{ ...numeric, whiteSpace: "nowrap" }}>
        {formatRate(props.value)}
      </Text>
    </Row>
  );
}

export const networkSpeed = defineWidget({
  type: "hardware-network",
  name: "Rede",
  description: "Velocidade de download e upload ao vivo com gráfico, somando os adaptadores físicos conectados.",
  category: "system",
  defaultConfig: {},
  setup(ctx) {
    ctx.onDispose(networkPoller.acquire());
    return {};
  },
  menu() {
    return [
      [
        { label: "Gerenciador de Tarefas", icon: "info", onSelect: () => launch("taskmgr.exe") },
        { label: "Rede e internet", icon: "settings", onSelect: () => launch("ms-settings:network") },
        { label: "Uso de dados", icon: "settings", onSelect: () => launch("ms-settings:datausage") },
      ],
    ];
  },
  View({ preview }) {
    const demo = preview && !network.ready;
    const down = demo ? DEMO_DOWN : network.downHistory;
    const up = demo ? DEMO_UP : network.upHistory;
    const h = Math.max(16, ui.tile.height - 14);
    return (
      <Tile width={176} padding={{ left: 10, right: 10 }} gap={8} onClick={openQuickSettings}>
        <Chart down={down} up={up} width={64} height={h} />
        <Column style={{ gap: 1, flex: 1 }}>
          <Rate arrow="↓" color={DOWN} value={demo ? DEMO_DOWN[DEMO_DOWN.length - 1]! : network.down} />
          <Rate arrow="↑" color={UP} value={demo ? DEMO_UP[DEMO_UP.length - 1]! : network.up} />
        </Column>
      </Tile>
    );
  },
});
