import { Path, Row, Svg, SvgRect } from "@tarve/core";
import { tapKeys, VK } from "../../native/win32";
import { launch } from "../../services/windows";
import { status, statusPoller } from "../../services/status";
import { ui } from "../../theme";
import { Tile } from "../ui";
import { HoverTip } from "../../menu/hover-tip";
import { defineWidget } from "../types";

const SIZE = 18;
const dim = "rgba(245,245,247,0.28)";
const line = { fill: "none", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round" } as const;

/** Wi-Fi arcs lit by signal strength; a crossed globe without internet; a monitor on cable. */
function NetworkGlyph() {
  if (status.network === "none") {
    return (
      <Svg width={SIZE} height={SIZE} viewBox="0 0 24 24">
        <Path
          d="M12 20h.01M8.5 16.43a5 5 0 0 1 7 0M5 12.86a10 10 0 0 1 5.17-2.69M2 8.82a15 15 0 0 1 4.18-2.64M2 2l20 20"
          stroke={ui.text}
          {...line}
        />
      </Svg>
    );
  }
  if (status.network === "wifi") {
    const bars = status.signal >= 70 ? 3 : status.signal >= 40 ? 2 : 1;
    const arc = (d: string, n: number) => <Path d={d} stroke={bars >= n ? ui.text : dim} {...line} />;
    return (
      <Svg width={SIZE} height={SIZE} viewBox="0 0 24 24">
        <Path d="M12 20h.01" stroke={ui.text} {...line} stroke-width={3} />
        {arc("M8.5 16.43a5 5 0 0 1 7 0", 1)}
        {arc("M5 12.86a10 10 0 0 1 14 0", 2)}
        {arc("M2 8.82a15 15 0 0 1 20 0", 3)}
        {status.internet ? null : <Path d="M19 14v3M19 20.5h.01" stroke={ui.orange} {...line} />}
      </Svg>
    );
  }
  return (
    <Svg width={SIZE} height={SIZE} viewBox="0 0 24 24">
      <SvgRect x={2.5} y={3.5} width={19} height={13} rx={2} stroke={ui.text} {...line} />
      <Path d="M8 21h8M12 16.5V21" stroke={ui.text} {...line} />
      {status.internet ? null : <Path d="M12 7v4M12 13.5h.01" stroke={ui.orange} {...line} />}
    </Svg>
  );
}

function VolumeGlyph() {
  const speaker =
    "M11 4.7a.7.7 0 0 0-1.2-.5L6.41 7.59A1.4 1.4 0 0 1 5.42 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.42a1.4 1.4 0 0 1 1 .41l3.38 3.39A.7.7 0 0 0 11 19.3z";
  const silent = !status.hasAudio || status.muted;
  return (
    <Svg width={SIZE} height={SIZE} viewBox="0 0 24 24">
      <Path d={speaker} stroke={ui.text} {...line} />
      {silent ? (
        <Path d="M22 9l-6 6M16 9l6 6" stroke={ui.text} {...line} />
      ) : (
        <>
          <Path d="M15 9.5a4 4 0 0 1 0 5" stroke={status.volume > 0 ? ui.text : dim} {...line} />
          <Path d="M18 7a8 8 0 0 1 0 10" stroke={status.volume > 33 ? ui.text : dim} {...line} />
          <Path d="M21 4.5a12 12 0 0 1 0 15" stroke={status.volume > 66 ? ui.text : dim} {...line} />
        </>
      )}
    </Svg>
  );
}

function BatteryGlyph() {
  const pct = Math.max(0, Math.min(100, status.battery));
  const fill = status.charging ? ui.green : pct <= 15 ? ui.danger : ui.text;
  return (
    <Svg width={SIZE + 4} height={SIZE} viewBox="0 0 26 24">
      <SvgRect x={1.5} y={6.5} width={20} height={11} rx={3} stroke={ui.text} {...line} stroke-width={1.6} />
      <SvgRect x={3.5} y={8.5} width={Math.max(1, 16 * (pct / 100))} height={7} rx={1.5} fill={fill} stroke="none" />
      <Path d="M24 10.5v3" stroke={ui.text} {...line} stroke-width={1.8} />
      {status.charging ? <Path d="M12.5 7.5l-3 4.5h4l-3 4.5" stroke="#0c0c0e" {...line} stroke-width={1.6} /> : null}
    </Svg>
  );
}

function networkTip() {
  const access = status.internet ? "Acesso à Internet" : "Sem acesso à Internet";
  if (status.network === "none") return ["Não conectado", "Nenhuma conexão disponível"];
  if (status.network === "wifi") return [status.ssid || "Wi-Fi", access];
  return [status.network === "ethernet" ? "Rede (cabo)" : "Rede", access];
}

function volumeTip() {
  if (!status.hasAudio) return ["Nenhum dispositivo de áudio"];
  return [status.muted ? "Alto-falantes: mudo" : `Alto-falantes: ${status.volume}%`];
}

function batteryTip() {
  const pct = Math.round(status.battery);
  return [status.charging ? `Bateria: ${pct}% disponível (conectado)` : `Bateria: ${pct}% restante`];
}

/** Network, volume and battery in one block, as Windows groups them; a click opens Quick Settings. */
export default defineWidget({
  type: "tray-status",
  name: "Rede, volume e bateria",
  description: "Status da conexão, do volume e da bateria. Clique abre as configurações rápidas (Win+A).",
  category: "system",
  defaultConfig: {},
  setup(ctx) {
    ctx.onDispose(statusPoller.acquire());
    return {};
  },
  menu() {
    return [
      [{ label: "Configurações rápidas", icon: "settings", onSelect: () => tapKeys(VK.LWIN, 0x41 /* A */) }],
      [
        { label: "Rede e internet", icon: "settings", onSelect: () => launch("ms-settings:network") },
        { label: "Som", icon: "settings", onSelect: () => launch("ms-settings:sound") },
        { label: "Energia e bateria", icon: "settings", onSelect: () => launch("ms-settings:powersleep") },
      ],
    ];
  },
  View({ ctx, preview }) {
    // Each icon has its own tip, as on the taskbar.
    const id = (part: string) => `tip:${ctx.instanceId}:${part}`;
    return (
      <Tile padding={{ left: 12, right: 12 }} onClick={() => tapKeys(VK.LWIN, 0x41 /* A */)}>
        <Row style={{ align: "center", gap: 10 }}>
          <HoverTip id={id("net")} tip={networkTip} disabled={preview}>
            <NetworkGlyph />
          </HoverTip>
          <HoverTip id={id("volume")} tip={volumeTip} disabled={preview}>
            <VolumeGlyph />
          </HoverTip>
          {status.hasBattery ? (
            <HoverTip id={id("battery")} tip={batteryTip} disabled={preview}>
              <BatteryGlyph />
            </HoverTip>
          ) : null}
        </Row>
      </Tile>
    );
  },
});
