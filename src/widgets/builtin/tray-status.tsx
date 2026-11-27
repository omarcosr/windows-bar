import { Row, Text, View } from "@tarve/core";
import { openQuickSettings } from "../../native/desktop";
import { launch } from "../../services/windows";
import { status, statusPoller } from "../../services/status";
import { ui } from "../../theme";
import { Tile } from "../ui";
import { HoverTip } from "../../menu/hover-tip";
import { defineWidget } from "../types";

import { t } from "../../i18n";
/*
 * The notification area's system icons are glyphs of Windows' icon font (Segoe Fluent Icons on
 * Windows 11, Segoe MDL2 Assets before it), the same characters the taskbar draws, at its 16 px.
 */
const FONT = "Segoe Fluent Icons, Segoe MDL2 Assets";
const SIZE = 16;
const dim = "rgba(245,245,247,0.3)";

function Glyph(props: { code: number; color?: string; under?: number }) {
  const glyph = (code: number, color: string) => (
    <Text size={SIZE} color={color} style={{ fontFamily: FONT, lineHeight: 1 }}>
      {String.fromCharCode(code)}
    </Text>
  );
  if (props.under === undefined) return glyph(props.code, props.color ?? ui.text);
  // Wi-Fi: the full set of arcs dimmed under the lit ones, as Windows 11 draws signal strength.
  return (
    <View style={{ position: "relative", width: SIZE, height: SIZE }}>
      <View style={{ position: "absolute", left: 0, top: 0 }}>{glyph(props.under, dim)}</View>
      <View style={{ position: "absolute", left: 0, top: 0 }}>{glyph(props.code, props.color ?? ui.text)}</View>
    </View>
  );
}

/** Wifi1-3 / Wifi (E872-E874, E701); with a warning sign without internet (WifiWarning1-4, EB60-EB63). */
function NetworkGlyph() {
  if (status.network === "none") return <Glyph code={0xf384 /* NetworkOffline */} />;
  if (status.network === "wifi") {
    // Signal quality (0-100) from the WLAN service, in the taskbar's four steps.
    const bars = status.signal >= 75 ? 4 : status.signal >= 50 ? 3 : status.signal >= 25 ? 2 : 1;
    if (!status.internet) return <Glyph code={0xeb5f + bars} under={0xeb63} />;
    return <Glyph code={[0xe872, 0xe873, 0xe874, 0xe701][bars - 1]!} under={0xe701} />;
  }
  return <Glyph code={status.internet ? 0xe839 /* Ethernet */ : 0xeb55 /* EthernetError */} />;
}

/** Mute (E74F) or Volume0-3 (E992-E995) by level, as the taskbar's speaker. */
function VolumeGlyph() {
  if (!status.hasAudio || status.muted) return <Glyph code={0xe74f} />;
  const v = status.volume;
  return <Glyph code={v === 0 ? 0xe992 : v <= 33 ? 0xe993 : v <= 66 ? 0xe994 : 0xe995} />;
}

/** Battery0-10 (E850-E859, E83F) and BatteryCharging0-10 (E85A-E862, E83E, EA93) in 10 % steps. */
const BATTERY = [0xe850, 0xe851, 0xe852, 0xe853, 0xe854, 0xe855, 0xe856, 0xe857, 0xe858, 0xe859, 0xe83f];
const CHARGING = [0xe85a, 0xe85b, 0xe85c, 0xe85d, 0xe85e, 0xe85f, 0xe860, 0xe861, 0xe862, 0xe83e, 0xea93];

function BatteryGlyph() {
  const step = Math.round(Math.max(0, Math.min(100, status.battery)) / 10);
  return <Glyph code={(status.charging ? CHARGING : BATTERY)[step]!} />;
}

function networkTip() {
  const access = status.internet ? t("widgets.trayStatus.internetAccess") : t("widgets.trayStatus.noInternetAccess");
  if (status.network === "none") return [t("widgets.trayStatus.notConnected"), t("widgets.trayStatus.noConnectionsAvailable")];
  if (status.network === "wifi") return [status.ssid || "Wi-Fi", access];
  return [t("widgets.trayStatus.network"), access];
}

/** "Fone de ouvido (CORSAIR …): 36%", with the device's own name, as the taskbar's volume tip. */
function volumeTip() {
  if (!status.hasAudio) return [t("widgets.trayStatus.noAudioOutputDevice")];
  const device = status.audioDevice || t("widgets.trayStatus.speakers");
  return [status.muted ? t("widgets.trayStatus.muted", { device }) : `${device}: ${status.volume}%`];
}

function batteryTip() {
  const pct = Math.round(status.battery);
  return [status.charging ? t("widgets.trayStatus.batteryAvailablePluggedIn", { pct }) : t("widgets.trayStatus.batteryRemaining", { pct })];
}

/** Network, volume and battery in one block, as Windows groups them; a click opens Quick Settings. */
export default defineWidget({
  type: "tray-status",
  sideForm: "full",
  name: t("widgets.trayStatus.networkVolumeAndBattery"),
  description: t("widgets.trayStatus.connectionVolumeAndBattery"),
  category: "system",
  defaultConfig: {},
  setup(ctx) {
    ctx.onDispose(statusPoller.acquire());
    return {};
  },
  menu() {
    return [
      [{ label: t("widgets.trayStatus.quickSettings"), icon: "settings", onSelect: openQuickSettings }],
      [
        { label: t("widgets.trayStatus.networkInternet"), icon: "settings", onSelect: () => launch("ms-settings:network") },
        { label: t("widgets.trayStatus.sound"), icon: "settings", onSelect: () => launch("ms-settings:sound") },
        { label: t("widgets.trayStatus.powerBattery"), icon: "settings", onSelect: () => launch("ms-settings:powersleep") },
      ],
    ];
  },
  View({ ctx, preview }) {
    // Each icon has its own tip, as on the taskbar.
    const id = (part: string) => `tip:${ctx.instanceId}:${part}`;
    return (
      <Tile padding={{ left: 12, right: 12 }} onClick={openQuickSettings} side="full">
        <Row style={{ align: "center", gap: 10 }}>
          <HoverTip id={id("net")} tip={networkTip} disabled={preview} side="full">
            <NetworkGlyph />
          </HoverTip>
          <HoverTip id={id("volume")} tip={volumeTip} disabled={preview} side="full">
            <VolumeGlyph />
          </HoverTip>
          {status.hasBattery ? (
            <HoverTip id={id("battery")} tip={batteryTip} disabled={preview} side="full">
              <BatteryGlyph />
            </HoverTip>
          ) : null}
        </Row>
      </Tile>
    );
  },
});
