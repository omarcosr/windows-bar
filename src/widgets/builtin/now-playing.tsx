import { Column, Image, Pressable, Row, Text, View } from "@tarve/core";
import { media, mediaControls, mediaPosition, openPlayer, playerIcon, selectSource, sourceName, useMedia } from "../../services/media";
import { status, statusPoller, toggleMute } from "../../services/status";
import { launch } from "../../services/windows";
import { devicePx, ui } from "../../theme";
import { RoundButton, Tile, glyphs } from "../ui";
import { defineWidget } from "../types";
import { MediaHover, hideMediaFlyout } from "../../menu/media-flyout";
import type { DockMenuItem } from "../../menu/dock-menu";

import { t } from "../../i18n";
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
  if (!(media.active && media.title)) return t("widgets.nowPlaying.openPlayer");
  const app = media.app ? sourceName(media.app) : "";
  if (kind === "album") return media.album || media.artist || app;
  if (kind === "app") return app || media.artist;
  return media.artist || app;
}

export default defineWidget({
  type: "now-playing",
  name: t("widgets.nowPlaying.nowPlaying"),
  description: t("widgets.nowPlaying.musicFromAnyPlayer"),
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
    { kind: "toggle", key: "hideWhenIdle", label: t("widgets.nowPlaying.hideWhenNothingIs"), description: t("widgets.nowPlaying.disappearsFromDockWhile") },
    {
      kind: "toggle",
      key: "hideWhenPaused",
      label: t("widgets.nowPlaying.alsoHideWhenPaused"),
      description: t("widgets.nowPlaying.onlyShowsWhileSomething"),
      when: (c) => c.hideWhenIdle,
    },
    {
      kind: "choice",
      key: "size",
      label: t("widgets.nowPlaying.width"),
      options: [
        { value: "compact", label: t("widgets.nowPlaying.compact") },
        { value: "normal", label: t("widgets.nowPlaying.normal") },
        { value: "wide", label: t("widgets.nowPlaying.wide") },
      ],
    },
    { kind: "toggle", key: "showArt", label: t("widgets.nowPlaying.showAlbumArt"), description: t("widgets.nowPlaying.withoutArtShowsPlayer") },
    {
      kind: "choice",
      key: "secondLine",
      label: t("widgets.nowPlaying.secondLine"),
      options: [
        { value: "artist", label: t("widgets.nowPlaying.artist") },
        { value: "album", label: t("widgets.nowPlaying.album") },
        { value: "app", label: "Player" },
      ],
    },
    { kind: "toggle", key: "showControls", label: t("widgets.nowPlaying.showControls"), description: t("widgets.nowPlaying.mediaButtonsOnBlock") },
    {
      kind: "choice",
      key: "controlSet",
      label: t("widgets.nowPlaying.buttons"),
      options: [
        { value: "full", label: t("widgets.nowPlaying.previousPlayAndNext") },
        { value: "playPause", label: t("widgets.nowPlaying.playPauseOnly") },
      ],
      when: (c) => c.showControls,
    },
    { kind: "toggle", key: "showProgress", label: t("widgets.nowPlaying.showProgressBar") },
    {
      kind: "choice",
      key: "clickAction",
      label: t("widgets.nowPlaying.clickOnSong"),
      description: t("widgets.nowPlaying.whatHappensWhenYou"),
      options: [
        { value: "open", label: t("widgets.nowPlaying.openPlayer2") },
        { value: "playPause", label: "Tocar/pausar" },
        { value: "none", label: t("widgets.nowPlaying.nothing") },
      ],
    },
    {
      kind: "toggle",
      key: "hoverFlyout",
      label: t("widgets.nowPlaying.panelOnHover"),
      description: t("widgets.nowPlaying.largeArtTimeControls"),
    },
    { kind: "toggle", key: "flyoutVolume", label: t("widgets.nowPlaying.volumeInPanel"), description: t("widgets.nowPlaying.overallVolumeOfDefault"), when: (c) => c.hoverFlyout },
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
        { label: media.playing ? t("widgets.nowPlaying.pause") : t("widgets.nowPlaying.play"), icon: media.playing ? "pause" : "play", onSelect: mediaControls.playPause },
        { label: t("widgets.nowPlaying.next"), icon: "skip-forward", onSelect: mediaControls.next },
        { label: t("widgets.nowPlaying.previous"), icon: "skip-back", onSelect: mediaControls.previous },
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
    if (media.app) extra.push({ label: t("widgets.nowPlaying.open", { p0: sourceName(media.app) }), icon: { fluent: 0xe8a7 /* OpenInNewWindow */ }, onSelect: () => openPlayer() });
    if (status.hasAudio) {
      extra.push({ label: status.muted ? t("widgets.nowPlaying.unmute") : t("widgets.nowPlaying.mute"), icon: { fluent: status.muted ? 0xe995 : 0xe74f }, onSelect: toggleMute });
    }
    extra.push({ label: t("widgets.nowPlaying.soundSettings"), icon: "settings", onSelect: () => launch("ms-settings:sound") });
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
            {active ? media.title : t("widgets.nowPlaying.nothingPlaying")}
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
