import { status, statusPoller, toggleMute } from "../../../services/status";
import { actions, micPoller, toggleMicMute } from "../../../services/actions-state";
import { launch } from "../../../services/windows";
import { ui } from "../../../theme";
import { HoverTip } from "../../../menu/hover-tip";
import { RoundButton, Tile } from "../../ui";
import { defineWidget } from "../../types";
import { fluent, G, Glyph, volumeGlyph } from "./shared";

import { t } from "../../../i18n";
/** Mute of the default microphone (capture endpoint) and, next to it, of the speakers. */
export default defineWidget({
  type: "actions-microphone",
  name: t("widgets.actions.microphone.microphone"),
  description: t("widgets.actions.microphone.mutesDefaultMicrophoneWith"),
  category: "media",
  defaultConfig: { speakerButton: true },
  settings: [{ kind: "toggle", key: "speakerButton", label: t("widgets.actions.microphone.buttonToMuteSound") }],
  setup(ctx) {
    ctx.onDispose(micPoller.acquire());
    ctx.onDispose(statusPoller.acquire());
    return {};
  },
  hidden: () => !actions.hasMic,
  menu() {
    return [
      [
        { label: actions.micMuted ? t("widgets.actions.microphone.unmuteMicrophone") : t("widgets.actions.microphone.muteMicrophone"), icon: fluent(actions.micMuted ? G.mic : G.micOff), onSelect: toggleMicMute },
        { label: status.muted ? t("widgets.actions.microphone.unmute") : t("widgets.actions.microphone.muteSound"), icon: fluent(volumeGlyph(status.volume, !status.muted)), onSelect: toggleMute },
      ],
      [
        { label: t("widgets.actions.microphone.microphoneSettings"), icon: fluent(G.settings), onSelect: () => launch("ms-settings:sound") },
        { label: t("widgets.actions.microphone.microphonePrivacy"), icon: fluent(G.settings), onSelect: () => launch("ms-settings:privacy-microphone") },
      ],
    ];
  },
  View({ ctx, preview }) {
    const demo = preview && !actions.hasMic;
    const micMuted = demo ? false : actions.micMuted;
    const id = (part: string) => `tip:${ctx.instanceId}:${part}`;
    const size = ui.tile.control;
    return (
      <Tile padding={{ left: 6, right: 6 }} gap={6}>
        <HoverTip id={id("mic")} tip={() => [`${actions.micDevice || t("widgets.actions.microphone.microphone")}: ${actions.micMuted ? t("widgets.actions.microphone.muted") : t("widgets.actions.microphone.on")}`]} disabled={preview}>
          <RoundButton size={size} background={micMuted ? ui.danger : "#2a2a2e"} onClick={() => !preview && toggleMicMute()}>
            <Glyph code={micMuted ? G.micOff : G.mic} size={15} />
          </RoundButton>
        </HoverTip>
        {ctx.config.speakerButton ? (
          <HoverTip id={id("speaker")} tip={() => [status.muted ? t("widgets.actions.microphone.unmute") : t("widgets.actions.microphone.muteSound")]} disabled={preview}>
            <RoundButton size={size} background={status.muted && !preview ? ui.danger : "#2a2a2e"} onClick={() => !preview && toggleMute()}>
              <Glyph code={volumeGlyph(preview ? 60 : status.volume, !preview && status.muted)} size={15} />
            </RoundButton>
          </HoverTip>
        ) : null}
      </Tile>
    );
  },
});
