import { Column, Image, Row, Text, View, store } from "@tarve/core";
import { media, mediaControls, useMedia } from "../../services/media";
import { launch } from "../../services/windows";
import { ui } from "../../theme";
import { RoundButton, Tile, glyphs } from "../ui";
import { defineWidget } from "../types";

function Art() {
  if (media.art) {
    return <Image src={media.art} width={38} height={38} fit="cover" style={{ radius: 9, shrink: 0 }} />;
  }
  return (
    <View
      style={{
        width: 38,
        height: 38,
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
    return (
      <Tile width={ctx.config.showControls ? 300 : 220} padding={7} style={{ position: "relative" }}>
        <Art />
        <Column style={{ flex: 1, gap: 1, minWidth: 0 }}>
          <Text size={12} weight={650} color={ui.text} style={{ whiteSpace: "nowrap", textOverflow: "ellipsis", overflow: "hidden" }}>
            {active ? media.title : "Nada tocando"}
          </Text>
          <Text size={11} color={ui.muted} style={{ whiteSpace: "nowrap", textOverflow: "ellipsis", overflow: "hidden" }}>
            {active ? media.artist || media.app : "Abra um player"}
          </Text>
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
        {ctx.config.showProgress ? (
        <View style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 2, background: "rgba(255,255,255,0.06)" }}>
          <View
            style={{
              width: `${Math.round(state.progress * 1000) / 10}%`,
              height: 2,
              background: ui.blue,
              transition: { width: { duration: 900, easing: "linear" } },
            }}
          />
        </View>
        ) : null}
      </Tile>
    );
  },
});
