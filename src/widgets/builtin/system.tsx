import { Column, Row, Text } from "@tarve/core";
import { system, systemPoller } from "../../services/system";
import { launch } from "../../services/windows";
import { numeric, ui } from "../../theme";
import { Meter, Tile } from "../ui";
import { defineWidget } from "../types";

const tone = (v: number) => (v >= 85 ? ui.danger : v >= 65 ? "#ff9f0a" : ui.green);

function Line(props: { label: string; value: number }) {
  return (
    <Row style={{ align: "center", gap: 7 }}>
      <Text size={10} weight={600} color={ui.muted} style={{ width: 26 }}>
        {props.label}
      </Text>
      <Meter value={props.value / 100} width={62} color={tone(props.value)} />
      <Text size={11} weight={700} color={ui.text} style={{ ...numeric, width: 30, textAlign: "right" }}>
        {`${props.value}%`}
      </Text>
    </Row>
  );
}

export default defineWidget({
  type: "system",
  name: "CPU e RAM",
  description: "Uso do processador e da memória ao vivo.",
  category: "system",
  defaultConfig: {},
  setup(ctx) {
    ctx.onDispose(systemPoller.acquire());
    return {};
  },
  menu() {
    return [
      [
        { label: "Gerenciador de Tarefas", icon: "info", onSelect: () => launch("taskmgr.exe") },
        { label: "Monitor de Recursos", icon: "search", onSelect: () => launch("resmon.exe") },
        { label: "Informações do sistema", icon: "settings", onSelect: () => launch("ms-settings:about") },
      ],
    ];
  },
  View() {
    return (
      <Tile width={146} padding={{ left: 10, right: 10 }}>
        <Column style={{ gap: 6, flex: 1 }}>
          <Line label="CPU" value={system.cpu} />
          <Line label="RAM" value={system.ram} />
        </Column>
      </Tile>
    );
  },
});
