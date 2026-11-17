import { store } from "@tarve/core";
import { keyboardLayout, readNetwork, readVolume, setMuted, setVolume, type NetworkKind } from "../native/status";
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
  /** The default playback device's name ("Alto-falantes (Realtek(R) Audio)"). */
  audioDevice: "",
  volume: 0,
  muted: false,
  hasBattery: false,
  battery: 0,
  charging: false,
  language: "",
  layout: "",
  /** The input language's full name, for the hover tip. */
  languageName: "",
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
    audioDevice: volume?.device ?? "",
    volume: volume?.level ?? 0,
    muted: volume?.muted ?? false,
    hasBattery: power.hasBattery,
    battery: power.percent,
    charging: power.charging,
  });
}

export function refreshLanguage() {
  const kb = keyboardLayout(foregroundApp());
  assign({ language: kb.language, layout: kb.layout, languageName: kb.name });
}

export const statusPoller = createPoller(1000, refreshStatus);

/** Master volume (0..100) of the default device; shown at once, then confirmed by a read. */
export function changeVolume(level: number) {
  const next = Math.round(Math.max(0, Math.min(100, level)));
  if (!setVolume(next)) return;
  assign({ volume: next, muted: next === 0 ? status.muted : false });
}

/** Mute toggle of the default device, as the speaker button in quick settings. */
export function toggleMute() {
  if (setMuted(!status.muted)) assign({ muted: !status.muted });
}
export const languagePoller = createPoller(400, refreshLanguage);
