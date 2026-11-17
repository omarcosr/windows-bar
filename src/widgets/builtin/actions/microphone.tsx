import { status, statusPoller, toggleMute } from "../../../services/status";
import { actions, micPoller, toggleMicMute } from "../../../services/actions-state";
import { launch } from "../../../services/windows";
import { ui } from "../../../theme";
import { HoverTip } from "../../../menu/hover-tip";
import { RoundButton, Tile } from "../../ui";
import { defineWidget } from "../../types";
import { fluent, G, Glyph, volumeGlyph } from "./shared";

/** Mute of the default microphone (capture endpoint) and, next to it, of the speakers. */
export default defineWidget({
  type: "actions-microphone",
  name: "Microfone",
  description: "Silencia o microfone padrão com um clique, com um botão ao lado para silenciar o som.",
  category: "media",
  defaultConfig: { speakerButton: true },
  settings: [{ kind: "toggle", key: "speakerButton", label: "Botão para silenciar o som" }],
  setup(ctx) {
    ctx.onDispose(micPoller.acquire());
    ctx.onDispose(statusPoller.acquire());
    return {};
  },
  hidden: () => !actions.hasMic,
  menu() {
    return [
      [
        { label: actions.micMuted ? "Ativar microfone" : "Silenciar microfone", icon: fluent(actions.micMuted ? G.mic : G.micOff), onSelect: toggleMicMute },
        { label: status.muted ? "Ativar som" : "Silenciar som", icon: fluent(volumeGlyph(status.volume, !status.muted)), onSelect: toggleMute },
      ],
      [
        { label: "Configurações do microfone", icon: fluent(G.settings), onSelect: () => launch("ms-settings:sound") },
        { label: "Privacidade do microfone", icon: fluent(G.settings), onSelect: () => launch("ms-settings:privacy-microphone") },
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
        <HoverTip id={id("mic")} tip={() => [`${actions.micDevice || "Microfone"}: ${actions.micMuted ? "sem áudio" : "ativo"}`]} disabled={preview}>
          <RoundButton size={size} background={micMuted ? ui.danger : "#2a2a2e"} onClick={() => !preview && toggleMicMute()}>
            <Glyph code={micMuted ? G.micOff : G.mic} size={15} />
          </RoundButton>
        </HoverTip>
        {ctx.config.speakerButton ? (
          <HoverTip id={id("speaker")} tip={() => [status.muted ? "Ativar som" : "Silenciar som"]} disabled={preview}>
            <RoundButton size={size} background={status.muted && !preview ? ui.danger : "#2a2a2e"} onClick={() => !preview && toggleMute()}>
              <Glyph code={volumeGlyph(preview ? 60 : status.volume, !preview && status.muted)} size={15} />
            </RoundButton>
          </HoverTip>
        ) : null}
      </Tile>
    );
  },
});
