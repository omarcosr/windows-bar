import { store } from "@tarve/core";
import { keyboardLayout, readNetwork, setMuted, setVolume, watchEndpoint, watchNetwork, type EndpointState, type NetworkKind } from "../native/status";
import { powerStatus } from "../native/win32";
import { HSHELL, onShellEvent } from "../native/shell-events";
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
  // Only write what changed, so a notification that changes nothing repaints nothing.
  for (const [key, value] of Object.entries(next)) {
    if ((status as Record<string, unknown>)[key] !== value) (status as Record<string, unknown>)[key] = value;
  }
}

function refreshBattery() {
  const power = powerStatus();
  assign({ hasBattery: power.hasBattery, battery: power.percent, charging: power.charging });
}

function refreshNetwork() {
  const net = readNetwork();
  assign({ network: net.kind, internet: net.internet, signal: net.signal, ssid: net.name });
}

function applyVolume(volume: EndpointState | null) {
  assign({ hasAudio: !!volume, audioDevice: volume?.device ?? "", volume: volume?.level ?? 0, muted: volume?.muted ?? false });
}

export function refreshLanguage() {
  const kb = keyboardLayout(foregroundApp());
  assign({ language: kb.language, layout: kb.layout, languageName: kb.name });
}

/**
 * Everything follows the system's own notifications, as the taskbar's icons do: the default speaker's
 * volume and mute (IAudioEndpointVolumeCallback, IMMNotificationClient), the network
 * (NotifyNetworkConnectivityHintChange, route and WLAN notifications) and the battery (WM_POWERBROADCAST).
 */
export const statusPoller = {
  acquire(): () => void {
    refreshBattery();
    refreshNetwork();
    const offPower = onShellEvent((event) => {
      if (event.type === "power") refreshBattery();
    });
    const offVolume = watchEndpoint(0, applyVolume);
    const offNetwork = watchNetwork(refreshNetwork);
    return () => {
      offPower();
      offVolume();
      offNetwork();
    };
  },
};

/** Master volume (0..100) of the default device; shown at once, then confirmed by its change notification. */
export function changeVolume(level: number) {
  const next = Math.round(Math.max(0, Math.min(100, level)));
  if (!setVolume(next)) return;
  assign({ volume: next, muted: next === 0 ? status.muted : false });
}

/** Mute toggle of the default device, as the speaker button in quick settings. */
export function toggleMute() {
  if (setMuted(!status.muted)) assign({ muted: !status.muted });
}
/**
 * The input language is per window: it is read again when the shell says it changed
 * (HSHELL_LANGUAGE) and when another window comes forward, as the taskbar's language button does.
 */
export const languagePoller = {
  acquire(): () => void {
    refreshLanguage();
    return onShellEvent((event) => {
      if (event.type === "foreground" || (event.type === "shell" && event.code === HSHELL.LANGUAGE)) refreshLanguage();
    });
  },
};
