import { Row } from "@tarve/core";
import { launch } from "../../../services/windows";
import { openQuickSettings } from "../../../native/desktop";
import { changeVolume, status, statusPoller, toggleMute } from "../../../services/status";
import { ui } from "../../../theme";
import { HoverTip } from "../../../menu/hover-tip";
import { Meter, Tile } from "../../ui";
import { defineWidget } from "../../types";
import { fluent, G, Glyph, Percent, volumeGlyph } from "./shared";

import { t } from "../../../i18n";
/** Default playback device (the taskbar speaker's IAudioEndpointVolume, read by services/status). */
export default defineWidget({
  type: "actions-audio-output",
  name: t("widgets.actions.audioOutput.audioOutput"),
  description: t("widgets.actions.audioOutput.volumeOfDefaultPlayback"),
  category: "media",
  defaultConfig: { showMeter: true, click: "flyout" },
  settings: [
    { kind: "toggle", key: "showMeter", label: t("widgets.actions.audioOutput.showVolumeBar") },
    {
      kind: "choice",
      key: "click",
      label: t("widgets.actions.audioOutput.onClick"),
      options: [
        { value: "flyout", label: t("widgets.actions.audioOutput.openWindowsVolumeQuick") },
        { value: "mute", label: t("widgets.actions.audioOutput.muteOrUnmute") },
      ],
    },
  ],
  setup(ctx) {
    ctx.onDispose(statusPoller.acquire());
    return {};
  },
  hidden: () => !status.hasAudio,
  menu() {
    const steps = [0, 25, 50, 75, 100].map((v) => ({
      label: v === 0 ? "Volume 0%" : `Volume ${v}%`,
      icon: fluent(volumeGlyph(v, false)),
      onSelect: () => changeVolume(v),
    }));
    return [
      [
        { label: status.muted ? t("widgets.actions.audioOutput.unmute") : t("widgets.actions.audioOutput.mute"), icon: fluent(status.muted ? G.volume[3] : G.volumeMute), onSelect: toggleMute },
        { label: "Aumentar 10%", icon: fluent(G.plus), onSelect: () => changeVolume(status.volume + 10) },
        { label: "Diminuir 10%", icon: fluent(G.minus), onSelect: () => changeVolume(status.volume - 10) },
      ],
      steps,
      [
        { label: t("widgets.actions.audioOutput.soundSettings"), icon: fluent(G.settings), onSelect: () => launch("ms-settings:sound") },
        { label: t("widgets.actions.audioOutput.volumeMixer"), icon: fluent(G.settings), onSelect: () => launch("ms-settings:apps-volume") },
      ],
    ];
  },
  View({ ctx, preview }) {
    const demo = preview && !status.hasAudio;
    const level = demo ? 60 : status.volume;
    const muted = demo ? false : status.muted;
    // The taskbar's speaker opens quick settings (volume slider, output picker); "mute" keeps the old one-click mute.
    const mute = ctx.config.click === "mute";
    const tip = () => [
      status.muted ? t("widgets.actions.audioOutput.muted", { p0: status.audioDevice || t("widgets.actions.audioOutput.speakers") }) : `${status.audioDevice || t("widgets.actions.audioOutput.speakers")}: ${status.volume}%`,
      mute ? (status.muted ? t("widgets.actions.audioOutput.clickToUnmute") : t("widgets.actions.audioOutput.clickToMute")) : t("widgets.actions.audioOutput.clickToAdjustVolume"),
    ];
    return (
      <HoverTip id={`tip:${ctx.instanceId}:audio`} tip={tip} disabled={preview}>
        <Tile padding={{ left: 12, right: 12 }} gap={8} onClick={preview ? undefined : mute ? toggleMute : openQuickSettings}>
          <Glyph code={volumeGlyph(level, muted)} color={muted ? ui.muted : ui.text} />
          {ctx.config.showMeter ? <Meter value={muted ? 0 : level / 100} width={48} color={ui.blue} /> : null}
          <Row style={{ width: 34, justify: "end" }}>
            <Percent value={level} color={muted ? ui.muted : ui.text} />
          </Row>
        </Tile>
      </HoverTip>
    );
  },
});
