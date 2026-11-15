import { store } from "@tarve/core";
import { keyboardLayout, readNetwork, readVolume, type NetworkKind } from "../native/status";
import { powerStatus } from "../native/win32";
import { createPoller } from "./poller";
import { foregroundApp } from "./windows";

/** What the right end of the Windows taskbar shows: network, volume, battery, input language. */
export const status = store({
  network: "none" as NetworkKind,
  internet: false,
  signal: 0,
  ssid: "",
  hasAudio: false,
  volume: 0,
  muted: false,
  hasBattery: false,
  battery: 0,
  charging: false,
  language: "",
  layout: "",
});

function assign(next: Partial<typeof status>) {
  // Only write what changed, so an idle poll repaints nothing.
  for (const [key, value] of Object.entries(next)) {
    if ((status as Record<string, unknown>)[key] !== value) (status as Record<string, unknown>)[key] = value;
  }
}

export function refreshStatus() {
  const net = readNetwork();
  const volume = readVolume();
  const power = powerStatus();
  assign({
    network: net.kind,
    internet: net.internet,
    signal: net.signal,
    ssid: net.name,
    hasAudio: !!volume,
    volume: volume?.level ?? 0,
    muted: volume?.muted ?? false,
    hasBattery: power.hasBattery,
    battery: power.percent,
    charging: power.charging,
  });
}

export function refreshLanguage() {
  const kb = keyboardLayout(foregroundApp());
  assign({ language: kb.language, layout: kb.layout });
}

export const statusPoller = createPoller(1000, refreshStatus);
export const languagePoller = createPoller(400, refreshLanguage);
