import { Circle, Column, Path, Pressable, Row, Svg, Text, View } from "@tarve/core";
import { media, mediaControls, mediaPosition, openPlayer, sourceName, useMedia } from "../../../services/media";
import { HoverTip } from "../../../menu/hover-tip";
import type { DockMenuItem } from "../../../menu/dock-menu";
import { devicePx, numeric, ui } from "../../../theme";
import { RoundButton, Tile, glyphs } from "../../ui";
import { defineWidget, type WidgetContext } from "../../types";

import { t as tr } from "../../../i18n";
/** What the tiles draw: the Windows media session, or a demo track in the gallery when nothing plays. */
function track(preview: boolean, progress: number) {
  if (preview && !(media.active && media.title)) {
    return { active: true, title: "Blinding Lights", artist: "The Weeknd", playing: true, progress: 0.42, position: 84, duration: 200 };
  }
  const active = media.active && !!media.title;
  const second = media.artist || (media.app ? sourceName(media.app) : "");
  return {
    active,
    title: active ? media.title : tr("widgets.weatherMedia.media.nothingPlaying"),
    artist: active ? second : tr("widgets.weatherMedia.media.openPlayer"),
    playing: media.playing,
    progress,
    position: mediaPosition(),
    duration: media.duration,
  };
}

const defaultConfig = { hideWhenIdle: true };

const idleSetting = {
  kind: "toggle",
  key: "hideWhenIdle",
  label: tr("widgets.weatherMedia.media.hideWhenNothingIs"),
  description: tr("widgets.weatherMedia.media.disappearsFromDockWhile"),
} as const;

function setup<C extends object>(ctx: WidgetContext<C>): { progress: number } {
  ctx.onDispose(useMedia());
  // Read at render: mediaClock (each whole second while playing) re-renders with a new position.
  return {
    get progress() {
      return media.duration ? mediaPosition() / media.duration : 0;
    },
  };
}

function hidden<C extends typeof defaultConfig>({ ctx }: { ctx: WidgetContext<C> }) {
  return ctx.config.hideWhenIdle && !(media.active && media.title);
}

function menu(): DockMenuItem[][] {
  const items: DockMenuItem[] = [
    { label: media.playing ? tr("widgets.weatherMedia.media.pause") : tr("widgets.weatherMedia.media.play"), icon: media.playing ? "pause" : "play", onSelect: mediaControls.playPause },
    { label: tr("widgets.weatherMedia.media.next"), icon: "skip-forward", onSelect: mediaControls.next },
    { label: tr("widgets.weatherMedia.media.previous"), icon: "skip-back", onSelect: mediaControls.previous },
  ];
  const sections = [items];
  if (media.app) sections.push([{ label: tr("widgets.weatherMedia.media.open", { p0: sourceName(media.app) }), icon: { fluent: 0xe8a7 /* OpenInNewWindow */ }, onSelect: () => openPlayer() }]);
  return sections;
}

const line = { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } as const;

/** "3:07" */
function clock(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function TrackText(props: { title: string; artist: string; open?: () => void }) {
  const lines = ui.tile.lines;
  const body = (
    <Column style={{ flex: 1, gap: lines.gap, minWidth: 0 }}>
      <Text size={lines.primary - 1} weight={650} color={ui.text} style={{ ...line, lineHeight: lines.lineHeight }}>
        {props.title}
      </Text>
      <Text size={lines.secondary - 1} color={ui.muted} style={{ ...line, lineHeight: lines.lineHeight }}>
        {props.artist}
      </Text>
    </Column>
  );
  if (!props.open) return body;
  return (
    <Pressable onClick={props.open} focusable={false} style={{ flex: 1, minWidth: 0, cursor: "pointer", opacity: 1, hover: { opacity: 0.75 }, transition: { opacity: { duration: 120, easing: "easeOut" } } }}>
      {body}
    </Pressable>
  );
}

const nowCompact = defineWidget({
  type: "weather-media-now-compact",
  name: tr("widgets.weatherMedia.media.nowPlayingCompact"),
  description: tr("widgets.weatherMedia.media.titleArtistAndPlay"),
  category: "media",
  defaultConfig,
  settings: [idleSetting],
  setup: (ctx) => setup(ctx),
  hidden: (p) => hidden(p),
  menu,
  View({ state, preview }) {
    const t = track(preview, state.progress);
    return (
      <Tile icon={<RoundButton onClick={mediaControls.playPause} background={ui.blue}>{t.playing ? glyphs.pause(14) : glyphs.play(14)}</RoundButton>} width={176} padding={{ left: 10, right: (ui.tile.height - ui.tile.control) / 2 }}>
        <TrackText title={t.title} artist={t.artist} open={t.active && !preview ? () => openPlayer() : undefined} />
        <RoundButton onClick={mediaControls.playPause} background={ui.blue}>
          {t.playing ? glyphs.pause(14) : glyphs.play(14)}
        </RoundButton>
      </Tile>
    );
  },
});

/** A ring from 12 o'clock clockwise, `p` of the way round. */
function ringPath(cx: number, cy: number, r: number, p: number) {
  const a = Math.min(0.9999, Math.max(0, p)) * Math.PI * 2;
  const x = cx + Math.sin(a) * r;
  const y = cy - Math.cos(a) * r;
  return `M${cx} ${cy - r}A${r} ${r} 0 ${a > Math.PI ? 1 : 0} 1 ${x.toFixed(2)} ${y.toFixed(2)}`;
}

const nowMini = defineWidget({
  type: "weather-media-now-mini",
  name: tr("widgets.weatherMedia.media.nowPlayingMini"),
  description: tr("widgets.weatherMedia.media.roundPlayPauseButton"),
  category: "media",
  defaultConfig,
  settings: [idleSetting],
  setup: (ctx) => setup(ctx),
  hidden: (p) => hidden(p),
  menu,
  View({ state, ctx, preview }) {
    const t = track(preview, state.progress);
    const size = ui.tile.height;
    const ring = devicePx(Math.min(size - 6, 34), true);
    const stroke = 2.4;
    const r = ring / 2 - stroke / 2;
    return (
      <HoverTip id={`tip:${ctx.instanceId}`} tip={() => (t.active ? [t.title, t.artist] : [tr("widgets.weatherMedia.media.nothingPlaying")])} disabled={preview}>
        <Tile width={size} padding={0} onClick={preview ? undefined : mediaControls.playPause} style={{ justify: "center" }}>
          <View style={{ width: ring, height: ring, align: "center", justify: "center" }}>
            <View style={{ position: "absolute", left: 0, top: 0 }}>
              <Svg width={ring} height={ring} viewBox={[0, 0, ring, ring]}>
                <Circle cx={ring / 2} cy={ring / 2} r={r} fill="none" stroke={ui.track} stroke-width={stroke} />
                {t.progress > 0 ? (
                  <Path d={ringPath(ring / 2, ring / 2, r, t.progress)} fill="none" stroke={ui.blue} stroke-width={stroke} stroke-linecap="round" />
                ) : null}
              </Svg>
            </View>
            {t.playing ? glyphs.pause(Math.round(ring * 0.4)) : glyphs.play(Math.round(ring * 0.4))}
          </View>
        </Tile>
      </HoverTip>
    );
  },
});

const nowBar = defineWidget({
  type: "weather-media-now-bar",
  name: tr("widgets.weatherMedia.media.nowPlayingBar"),
  description: tr("widgets.weatherMedia.media.songWithProgressBar"),
  category: "media",
  defaultConfig: { ...defaultConfig, showTime: true },
  settings: [idleSetting, { kind: "toggle", key: "showTime", label: tr("widgets.weatherMedia.media.showTime"), description: tr("widgets.weatherMedia.media.timePlayedAndDuration") }],
  setup: (ctx) => setup(ctx),
  hidden: (p) => hidden(p),
  menu,
  View({ state, ctx, preview }) {
    const t = track(preview, state.progress);
    const lines = ui.tile.lines;
    const bar = devicePx(3);
    const showTime = ctx.config.showTime && t.duration > 0;
    const open = t.active && !preview ? () => openPlayer() : undefined;
    const text = (
      <Text size={lines.primary - 1} weight={650} color={ui.text} style={{ ...line, lineHeight: lines.lineHeight }}>
        {t.active && t.artist ? `${t.title} — ${t.artist}` : t.title}
      </Text>
    );
    return (
      <Tile icon={<RoundButton onClick={mediaControls.playPause} background={ui.blue}>{t.playing ? glyphs.pause(14) : glyphs.play(14)}</RoundButton>} width={250} padding={{ left: 10, right: (ui.tile.height - ui.tile.control) / 2 }} gap={6}>
        <Column style={{ flex: 1, gap: 4, minWidth: 0 }}>
          {open ? (
            <Pressable onClick={open} focusable={false} style={{ minWidth: 0, cursor: "pointer", opacity: 1, hover: { opacity: 0.75 }, transition: { opacity: { duration: 120, easing: "easeOut" } } }}>
              {text}
            </Pressable>
          ) : (
            text
          )}
          <Row style={{ align: "center", gap: 6 }}>
            {showTime ? (
              <Text size={9} color={ui.muted} style={numeric}>
                {clock(t.position)}
              </Text>
            ) : null}
            <View style={{ flex: 1, height: bar, radius: bar / 2, background: ui.track, overflow: "hidden" }}>
              <View
                style={{
                  width: `${Math.round(t.progress * 1000) / 10}%`,
                  height: bar,
                  radius: bar / 2,
                  background: ui.blue,
                  transition: { width: { duration: 900, easing: "linear" } },
                }}
              />
            </View>
            {showTime ? (
              <Text size={9} color={ui.muted} style={numeric}>
                {clock(t.duration)}
              </Text>
            ) : null}
          </Row>
        </Column>
        <Row style={{ gap: 5, align: "center" }}>
          <RoundButton onClick={mediaControls.playPause} background={ui.blue}>
            {t.playing ? glyphs.pause(14) : glyphs.play(14)}
          </RoundButton>
          <RoundButton onClick={mediaControls.next}>{glyphs.next(13)}</RoundButton>
        </Row>
      </Tile>
    );
  },
});

export default [nowCompact, nowMini, nowBar];
