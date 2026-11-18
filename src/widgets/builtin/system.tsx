import { Column, Row, Text } from "@tarve/core";
import { system, systemPoller } from "../../services/system";
import { launch } from "../../services/windows";
import { numeric, ui } from "../../theme";
import { Meter, Tile } from "../ui";
import { defineWidget } from "../types";

const tone = (v: number) => (v >= 85 ? ui.danger : v >= 65 ? "#ff9f0a" : ui.green);

function Line(props: { label: string; value: number }) {
  const l = ui.tile.lines;
  return (
    <Row style={{ align: "center", gap: 7 }}>
      <Text size={l.secondary - 1} weight={600} color={ui.muted} style={{ width: 26, lineHeight: l.lineHeight }}>
        {props.label}
      </Text>
      <Meter value={props.value / 100} width={62} color={tone(props.value)} height={4} />
      <Text size={l.secondary} weight={700} color={ui.text} style={{ ...numeric, width: 32, textAlign: "right", lineHeight: l.lineHeight }}>
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
  View({ ctx, preview }) {
    return (
      <Tile
        width={146}
        preview={preview}
        // As the CPU meter Task Manager leaves in the notification area: a click opens Task Manager.
        onClick={() => launch("taskmgr.exe")}
        tip={{
          id: `tip:${ctx.instanceId}`,
          lines: () => ["Uso agora (média de todos os núcleos)", `Processador: ${system.cpu}%`, `Memória: ${system.ram}% em uso`, "Clique: Gerenciador de Tarefas"],
        }}
      >
        <Column style={{ gap: ui.tile.lines.gap + 2, flex: 1, justify: "center" }}>
          <Line label="CPU" value={system.cpu} />
          <Line label="RAM" value={system.ram} />
        </Column>
      </Tile>
    );
  },
});
