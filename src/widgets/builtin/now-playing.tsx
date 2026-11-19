import { Column, Image, Pressable, Row, Text, View } from "@tarve/core";
import { media, mediaControls, mediaPosition, openPlayer, playerIcon, selectSource, sourceName, useMedia } from "../../services/media";
import { status, statusPoller, toggleMute } from "../../services/status";
import { launch } from "../../services/windows";
import { devicePx, ui } from "../../theme";
import { RoundButton, Tile, glyphs } from "../ui";
import { defineWidget } from "../types";
import { MediaHover, hideMediaFlyout } from "../../menu/media-flyout";
import type { DockMenuItem } from "../../menu/dock-menu";

type Size = "compact" | "normal" | "wide";
type SecondLine = "artist" | "album" | "app";
type ClickAction = "open" | "playPause" | "none";
type ControlSet = "full" | "playPause";

/** Room for the two lines of text, per size; "normal" is the tile's original width. */
const TEXT_WIDTH: Record<Size, number> = { compact: 100, normal: 136, wide: 210 };

/** The tile's control size, like the media buttons beside it, so all of them line up. */
const artSize = () => ui.tile.control;
/** Side padding equal to the space above and below the controls, so art and buttons sit evenly. */
const inset = () => (ui.tile.height - ui.tile.control) / 2;

function Art() {
  const size = artSize();
  if (media.art) {
    return <Image src={media.art} width={size} height={size} fit="cover" style={{ radius: 9, shrink: 0 }} />;
  }
  // The player's own icon, as the Windows media flyout shows when a track has no artwork.
  const icon = playerIcon(media.app, 28);
  if (icon) {
    return (
      <View style={{ width: size, height: size, radius: 9, shrink: 0, background: ui.tile.hover, align: "center", justify: "center" }}>
        <Image src={icon} width={Math.round(size * 0.74)} height={Math.round(size * 0.74)} fit="contain" style={{ radius: 0 }} />
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

function secondLine(kind: SecondLine) {
  if (!(media.active && media.title)) return "Abra um player";
  const app = media.app ? sourceName(media.app) : "";
  if (kind === "album") return media.album || media.artist || app;
  if (kind === "app") return app || media.artist;
  return media.artist || app;
}

export default defineWidget({
  type: "now-playing",
  name: "Tocando agora",
  description: "Música de qualquer player (Spotify, navegador, Apple Music) com controles, volume e troca de player ao passar o mouse.",
  category: "media",
  defaultConfig: {
    hideWhenIdle: true,
    hideWhenPaused: false,
    showProgress: true,
    showControls: true,
    controlSet: "full" as ControlSet,
    showArt: true,
    size: "normal" as Size,
    secondLine: "artist" as SecondLine,
    clickAction: "open" as ClickAction,
    hoverFlyout: true,
    flyoutVolume: true,
  },
  settings: [
    { kind: "toggle", key: "hideWhenIdle", label: "Ocultar quando nada estiver tocando", description: "Some do dock enquanto nenhum player tem mídia aberta." },
    {
      kind: "toggle",
      key: "hideWhenPaused",
      label: "Ocultar também quando pausado",
      description: "Só aparece enquanto algo está tocando.",
      when: (c) => c.hideWhenIdle,
    },
    {
      kind: "choice",
      key: "size",
      label: "Largura",
      options: [
        { value: "compact", label: "Compacta" },
        { value: "normal", label: "Normal" },
        { value: "wide", label: "Larga" },
      ],
    },
    { kind: "toggle", key: "showArt", label: "Mostrar capa do álbum", description: "Sem capa, mostra o ícone do player." },
    {
      kind: "choice",
      key: "secondLine",
      label: "Segunda linha",
      options: [
        { value: "artist", label: "Artista" },
        { value: "album", label: "Álbum" },
        { value: "app", label: "Player" },
      ],
    },
    { kind: "toggle", key: "showControls", label: "Mostrar controles", description: "Botões de mídia no próprio bloco." },
    {
      kind: "choice",
      key: "controlSet",
      label: "Botões",
      options: [
        { value: "full", label: "Anterior, tocar e próxima" },
        { value: "playPause", label: "Só tocar/pausar" },
      ],
      when: (c) => c.showControls,
    },
    { kind: "toggle", key: "showProgress", label: "Mostrar barra de progresso" },
    {
      kind: "choice",
      key: "clickAction",
      label: "Clique na música",
      description: "O que acontece ao clicar na capa ou no título.",
      options: [
        { value: "open", label: "Abrir o player" },
        { value: "playPause", label: "Tocar/pausar" },
        { value: "none", label: "Nada" },
      ],
    },
    {
      kind: "toggle",
      key: "hoverFlyout",
      label: "Painel ao passar o mouse",
      description: "Capa grande, tempo, controles, volume e troca entre players, como o painel de mídia do Windows.",
    },
    { kind: "toggle", key: "flyoutVolume", label: "Volume no painel", description: "Volume geral do dispositivo de som padrão.", when: (c) => c.hoverFlyout },
  ],
  setup(ctx) {
    ctx.onDispose(useMedia());
    ctx.onDispose(statusPoller.acquire());
    ctx.onDispose(hideMediaFlyout);
    // Read at render: mediaClock (each whole second while playing) re-renders with a new position.
    return {
        get progress() {
          return media.duration ? mediaPosition() / media.duration : 0;
        },
    };
  },
  hidden({ ctx }) {
    if (!ctx.config.hideWhenIdle) return false;
    if (!(media.active && media.title)) return true;
    return ctx.config.hideWhenPaused && !media.playing;
  },
  menu() {
    const sections: DockMenuItem[][] = [
      [
        { label: media.playing ? "Pausar" : "Tocar", icon: media.playing ? "pause" : "play", onSelect: mediaControls.playPause },
        { label: "Próxima", icon: "skip-forward", onSelect: mediaControls.next },
        { label: "Anterior", icon: "skip-back", onSelect: mediaControls.previous },
      ],
    ];
    // Every player with a session, the one the tile follows checked, as the Windows flyout pages them.
    if (media.sources.length > 1) {
      sections.push(
        media.sources.map((s): DockMenuItem => {
          const icon = playerIcon(s.appId, 16);
          return {
            label: `${sourceName(s.appId)}${s.title ? " — " + s.title : ""}`,
            icon: s.appId === media.app ? { fluent: 0xe73e /* CheckMark */ } : icon ? { image: icon } : undefined,
            onSelect: () => selectSource(s.appId),
          };
        }),
      );
    }
    const extra: DockMenuItem[] = [];
    if (media.app) extra.push({ label: `Abrir ${sourceName(media.app)}`, icon: { fluent: 0xe8a7 /* OpenInNewWindow */ }, onSelect: () => openPlayer() });
    if (status.hasAudio) {
      extra.push({ label: status.muted ? "Ativar som" : "Silenciar", icon: { fluent: status.muted ? 0xe995 : 0xe74f }, onSelect: toggleMute });
    }
    extra.push({ label: "Configurações de som", icon: "settings", onSelect: () => launch("ms-settings:sound") });
    sections.push(extra);
    return sections;
  },
  View({ state, ctx, preview }) {
    const c = ctx.config;
    const active = media.active && !!media.title;
    const lines = ui.tile.lines;
    const size = (TEXT_WIDTH[c.size] ? c.size : "normal") as Size;
    const buttons = !c.showControls ? 0 : c.controlSet === "playPause" ? 1 : 3;
    const control = ui.tile.control;
    const width =
      inset() * 2 +
      (c.showArt ? artSize() + 8 : 0) +
      TEXT_WIDTH[size] +
      (buttons ? 8 + buttons * control + (buttons - 1) * 5 : 0);
    const click = c.clickAction === "open" ? () => openPlayer() : c.clickAction === "playPause" ? mediaControls.playPause : undefined;
    const body = (
      <>
        {c.showArt ? <Art /> : null}
        <Column style={{ flex: 1, gap: lines.gap, minWidth: 0 }}>
          <Text size={lines.primary - 1} weight={650} color={ui.text} style={{ lineHeight: lines.lineHeight, whiteSpace: "nowrap", textOverflow: "ellipsis", overflow: "hidden" }}>
            {active ? media.title : "Nada tocando"}
          </Text>
          <Text size={lines.secondary} color={ui.muted} style={{ lineHeight: lines.lineHeight, whiteSpace: "nowrap", textOverflow: "ellipsis", overflow: "hidden" }}>
            {secondLine(c.secondLine)}
          </Text>
          {c.showProgress ? (
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
      </>
    );
    return (
      <MediaHover id={`media:${ctx.instanceId}`} disabled={preview || !c.hoverFlyout} showVolume={c.flyoutVolume}>
        <Tile width={Math.round(width)} padding={{ left: inset(), right: inset() }}>
          {click && active && !preview ? (
            <Pressable onClick={click} style={{ direction: "row", align: "center", gap: 8, flex: 1, minWidth: 0, cursor: "pointer" }}>
              {body}
            </Pressable>
          ) : (
            <Row style={{ align: "center", gap: 8, flex: 1, minWidth: 0 }}>{body}</Row>
          )}
          {buttons ? (
            <Row style={{ gap: 5, align: "center" }}>
              {buttons === 3 ? <RoundButton onClick={mediaControls.previous}>{glyphs.previous(13)}</RoundButton> : null}
              <RoundButton onClick={mediaControls.playPause} background={ui.blue}>
                {media.playing ? glyphs.pause(14) : glyphs.play(14)}
              </RoundButton>
              {buttons === 3 ? <RoundButton onClick={mediaControls.next}>{glyphs.next(13)}</RoundButton> : null}
            </Row>
          ) : null}
        </Tile>
      </MediaHover>
    );
  },
});
