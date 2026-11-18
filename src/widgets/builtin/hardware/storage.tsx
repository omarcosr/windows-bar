import { Row, Text } from "@tarve/core";
import { formatBytes, storage, storagePoller } from "../../../services/hardware-perf";
import { launch } from "../../../services/windows";
import { numeric, ui } from "../../../theme";
import { Meter, Tile } from "../../ui";
import { defineWidget } from "../../types";
import { amber } from "./shared";

export const storageSpace = defineWidget({
  type: "hardware-storage",
  name: "Armazenamento",
  description: "Espaço livre na unidade do sistema com barra de uso. Clique abre o Sensor de Armazenamento.",
  category: "system",
  defaultConfig: {},
  setup(ctx) {
    ctx.onDispose(storagePoller.acquire());
    return {};
  },
  menu() {
    return [
      [
        { label: "Sensor de Armazenamento", icon: "settings", onSelect: () => launch("ms-settings:storagesense") },
        { label: "Abrir unidade", icon: "search", onSelect: () => launch(storage.root) },
        { label: "Limpeza de Disco", icon: "settings", onSelect: () => launch("cleanmgr.exe") },
      ],
    ];
  },
  View({ ctx, preview }) {
    const demo = !storage.ready;
    const total = demo ? 512 * 1024 ** 3 : storage.total;
    const free = demo ? 148 * 1024 ** 3 : storage.free;
    const used = total ? 1 - free / total : 0;
    const tone = used >= 0.9 ? ui.danger : used >= 0.8 ? amber : ui.blue;
    const drive = storage.root.replace(/\\$/, "");
    const l = ui.tile.lines;
    return (
      <Tile
        width={132}
        onClick={() => launch("ms-settings:storagesense")}
        preview={preview}
        tip={{
          id: `tip:${ctx.instanceId}`,
          lines: () => [`Disco ${drive}: ${formatBytes(free, 0)} livres de ${formatBytes(total, 0)}`, `${Math.round(used * 100)}% usado`, "Clique: Configurações de armazenamento"],
        }}
      >
        <Row style={{ direction: "column", justify: "center", gap: l.gap + 3, flex: 1 }}>
          <Row style={{ align: "center", gap: 4 }}>
            <Text size={l.secondary} weight={600} color={ui.muted} style={{ lineHeight: l.lineHeight }}>
              {drive}
            </Text>
            <Text size={l.primary} weight={700} color={ui.text} style={{ ...numeric, lineHeight: l.lineHeight, flex: 1, textAlign: "right", whiteSpace: "nowrap" }}>
              {`${formatBytes(free, 0)} livres`}
            </Text>
          </Row>
          <Meter value={used} width={110} color={tone} />
        </Row>
      </Tile>
    );
  },
});
