import { Column, Image, Row, Text, View, store } from "@tarve/core";
import { media, mediaControls, useMedia } from "../../services/media";
import { launch } from "../../services/windows";
import { devicePx, ui } from "../../theme";
import { RoundButton, Tile, glyphs } from "../ui";
import { defineWidget } from "../types";
import { iconFor } from "../../services/icons";
import { programOfAppId } from "../../native/shell-item";

/** The player's own icon, as the Windows media flyout shows when a track has no artwork. */
function sourceIcon(): ReturnType<typeof iconFor> {
  if (!media.app) return undefined;
  if (/\.exe$/i.test(media.app)) {
    const program = programOfAppId(media.app.replace(/^.*\\/, ""));
    return iconFor(program || media.app, 28);
  }
  return iconFor(`shell:AppsFolder\\${media.app}`, 28);
}

/** The tile's control size, like the media buttons beside it, so all of them line up. */
const artSize = () => ui.tile.control;
/** Side padding equal to the space above and below the controls, so art and buttons sit evenly. */
const inset = () => (ui.tile.height - ui.tile.control) / 2;

function Art() {
  const size = artSize();
  if (media.art) {
    return <Image src={media.art} width={size} height={size} fit="cover" style={{ radius: 9, shrink: 0 }} />;
  }
  const icon = sourceIcon();
  if (icon) {
    return (
      <View style={{ width: size, height: size, radius: 9, shrink: 0, background: ui.tile.hover, align: "center", justify: "center" }}>
        <Image src={icon} width={Math.round(size * 0.74)} height={Math.round(size * 0.74)} fit="contain" />
      </View>
    );
  }
  return (
    <View
      style={{
        width: size,
        height: size,
        radius: 9,
        shrink: 0,
        background: "linear-gradient(140deg, #ff4f7a, #7b2ff7)",
        align: "center",
        justify: "center",
        direction: "row",
        gap: 2,
      }}
    >
      {[10, 18, 13, 20, 9].map((h) => (
        <View style={{ width: 2, height: h, radius: 1, background: "rgba(255,255,255,0.85)" }} />
      ))}
    </View>
  );
}

export default defineWidget({
  type: "now-playing",
  name: "Tocando agora",
  description: "Música de qualquer player (Spotify, navegador, Apple Music) com controles.",
  category: "media",
  defaultConfig: { hideWhenIdle: true, hideWhenPaused: false, showProgress: true, showControls: true },
  settings: [
    { kind: "toggle", key: "hideWhenIdle", label: "Ocultar quando nada estiver tocando", description: "Some do dock enquanto nenhum player tem mídia aberta." },
    {
      kind: "toggle",
      key: "hideWhenPaused",
      label: "Ocultar também quando pausado",
      description: "Só aparece enquanto algo está tocando.",
      when: (c) => c.hideWhenIdle,
    },
    { kind: "toggle", key: "showControls", label: "Mostrar controles", description: "Anterior, tocar/pausar e próxima no próprio bloco." },
    { kind: "toggle", key: "showProgress", label: "Mostrar barra de progresso" },
  ],
  setup(ctx) {
    ctx.onDispose(useMedia());
    const state = store({ progress: 0 });
    // Extrapolate playback between helper updates for a smooth bar.
    ctx.every(1000, () => {
      if (!media.duration) return void (state.progress = 0);
      const elapsed = media.playing ? (Date.now() - media.sampledAt) / 1000 : 0;
      state.progress = Math.min(1, (media.position + elapsed) / media.duration);
    });
    return state;
  },
  hidden({ ctx }) {
    if (!ctx.config.hideWhenIdle) return false;
    if (!(media.active && media.title)) return true;
    return ctx.config.hideWhenPaused && !media.playing;
  },
  menu() {
    return [
      [
        { label: media.playing ? "Pausar" : "Tocar", icon: media.playing ? "pause" : "play", onSelect: mediaControls.playPause },
        { label: "Próxima", icon: "skip-forward", onSelect: mediaControls.next },
        { label: "Anterior", icon: "skip-back", onSelect: mediaControls.previous },
      ],
      [
        { label: "Configurações de som", icon: "settings", onSelect: () => launch("ms-settings:sound") },
      ],
    ];
  },
  View({ state, ctx }) {
    const active = media.active && !!media.title;
    const lines = ui.tile.lines;
    return (
      <Tile width={ctx.config.showControls ? 300 : 220} padding={{ left: inset(), right: inset() }}>
        <Art />
        <Column style={{ flex: 1, gap: lines.gap, minWidth: 0 }}>
          <Text size={lines.primary - 1} weight={650} color={ui.text} style={{ lineHeight: lines.lineHeight, whiteSpace: "nowrap", textOverflow: "ellipsis", overflow: "hidden" }}>
            {active ? media.title : "Nada tocando"}
          </Text>
          <Text size={lines.secondary} color={ui.muted} style={{ lineHeight: lines.lineHeight, whiteSpace: "nowrap", textOverflow: "ellipsis", overflow: "hidden" }}>
            {active ? media.artist || media.app : "Abra um player"}
          </Text>
          {ctx.config.showProgress ? (
            // Under the text it belongs to, aligned with it, instead of along the tile's rounded edge.
            <View style={{ height: devicePx(2), radius: devicePx(2) / 2, background: "rgba(255,255,255,0.12)", margin: { top: 2 } }}>
              <View
                style={{
                  width: `${Math.round(state.progress * 1000) / 10}%`,
                  height: devicePx(2),
                  radius: devicePx(2) / 2,
                  background: ui.blue,
                  transition: { width: { duration: 900, easing: "linear" } },
                }}
              />
            </View>
          ) : null}
        </Column>
        {ctx.config.showControls ? (
          <Row style={{ gap: 5, align: "center" }}>
            <RoundButton onClick={mediaControls.previous}>{glyphs.previous(13)}</RoundButton>
            <RoundButton onClick={mediaControls.playPause} background={ui.blue}>
              {media.playing ? glyphs.pause(14) : glyphs.play(14)}
            </RoundButton>
            <RoundButton onClick={mediaControls.next}>{glyphs.next(13)}</RoundButton>
          </Row>
        ) : null}
      </Tile>
    );
  },
});
