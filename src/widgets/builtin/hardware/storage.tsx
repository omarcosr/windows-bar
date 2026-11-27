import { Row, Text } from "@tarve/core";
import { formatBytes, storage, storagePoller } from "../../../services/hardware-perf";
import { launch } from "../../../services/windows";
import { numeric, ui } from "../../../theme";
import { Meter, Tile } from "../../ui";
import { defineWidget } from "../../types";
import { amber } from "./shared";

import { t } from "../../../i18n";
export const storageSpace = defineWidget({
  type: "hardware-storage",
  name: t("widgets.hardware.storage.storage"),
  description: t("widgets.hardware.storage.freeSpaceOnSystem"),
  category: "system",
  defaultConfig: {},
  setup(ctx) {
    ctx.onDispose(storagePoller.acquire());
    return {};
  },
  menu() {
    return [
      [
        { label: t("widgets.hardware.storage.storageSense"), icon: "settings", onSelect: () => launch("ms-settings:storagesense") },
        { label: t("widgets.hardware.storage.openDrive"), icon: "search", onSelect: () => launch(storage.root) },
        { label: t("widgets.hardware.storage.diskCleanup"), icon: "settings", onSelect: () => launch("cleanmgr.exe") },
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
          lines: () => [t("widgets.hardware.storage.driveFreeOf", { drive, p1: formatBytes(free, 0), p2: formatBytes(total, 0) }), t("widgets.hardware.storage.used", { p0: Math.round(used * 100) }), t("widgets.hardware.storage.clickStorageSettings")],
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
