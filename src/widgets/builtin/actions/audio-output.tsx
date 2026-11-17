import { Row } from "@tarve/core";
import { launch } from "../../../services/windows";
import { changeVolume, status, statusPoller, toggleMute } from "../../../services/status";
import { ui } from "../../../theme";
import { HoverTip } from "../../../menu/hover-tip";
import { Meter, Tile } from "../../ui";
import { defineWidget } from "../../types";
import { fluent, G, Glyph, Percent, volumeGlyph } from "./shared";

/** Default playback device (the taskbar speaker's IAudioEndpointVolume, read by services/status). */
export default defineWidget({
  type: "actions-audio-output",
  name: "Saída de áudio",
  description: "Volume do dispositivo de reprodução padrão. Clique silencia ou reativa o som.",
  category: "media",
  defaultConfig: { showMeter: true },
  settings: [{ kind: "toggle", key: "showMeter", label: "Mostrar barra de volume" }],
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
        { label: status.muted ? "Ativar som" : "Silenciar", icon: fluent(status.muted ? G.volume[3] : G.volumeMute), onSelect: toggleMute },
        { label: "Aumentar 10%", icon: fluent(G.plus), onSelect: () => changeVolume(status.volume + 10) },
        { label: "Diminuir 10%", icon: fluent(G.minus), onSelect: () => changeVolume(status.volume - 10) },
      ],
      steps,
      [
        { label: "Configurações de som", icon: fluent(G.settings), onSelect: () => launch("ms-settings:sound") },
        { label: "Mixer de volume", icon: fluent(G.settings), onSelect: () => launch("ms-settings:apps-volume") },
      ],
    ];
  },
  View({ ctx, preview }) {
    const demo = preview && !status.hasAudio;
    const level = demo ? 60 : status.volume;
    const muted = demo ? false : status.muted;
    const tip = () => [status.muted ? `${status.audioDevice || "Alto-falantes"}: sem áudio` : `${status.audioDevice || "Alto-falantes"}: ${status.volume}%`];
    return (
      <HoverTip id={`tip:${ctx.instanceId}:audio`} tip={tip} disabled={preview}>
        <Tile padding={{ left: 12, right: 12 }} gap={8} onClick={preview ? undefined : toggleMute}>
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
