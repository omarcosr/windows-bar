import { Row, Text, type Child } from "@tarve/core";
import { numeric, ui } from "../../../theme";
import { HoverTip } from "../../../menu/hover-tip";
import { Tile } from "../../ui";

/** Segoe Fluent Icons (Segoe MDL2 Assets before Windows 11): the glyphs the taskbar and quick settings draw. */
export const FONT = "Segoe Fluent Icons, Segoe MDL2 Assets";

export const G = {
  volumeMute: 0xe74f,
  volume: [0xe992, 0xe993, 0xe994, 0xe995],
  mic: 0xe720,
  micOff: 0xec54,
  brightness: 0xe706,
  dim: 0xec8a,
  sun: 0xe706,
  moon: 0xe708,
  bell: 0xea8f,
  desktop: 0xe7f4,
  keyboard: 0xe765,
  snip: 0xe8c6,
  recycle: 0xe74d,
  photo: 0xeb9f,
  next: 0xe893,
  minus: 0xe738,
  plus: 0xe710,
  settings: 0xe713,
} as const;

export function Glyph(props: { code: number; size?: number; color?: string }) {
  return (
    <Text size={props.size ?? 16} color={props.color ?? ui.text} style={{ fontFamily: FONT, lineHeight: 1 }}>
      {String.fromCharCode(props.code)}
    </Text>
  );
}

/** Speaker glyph by level, as the taskbar's (Volume0-3, Mute). */
export function volumeGlyph(level: number, muted: boolean) {
  if (muted) return G.volumeMute;
  return level === 0 ? G.volume[0] : level <= 33 ? G.volume[1] : level <= 66 ? G.volume[2] : G.volume[3];
}

export function Percent(props: { value: number; color?: string }) {
  return (
    <Text size={ui.tile.lines.primary} weight={600} color={props.color ?? ui.text} style={{ ...numeric }}>
      {`${Math.round(props.value)}%`}
    </Text>
  );
}

/** A square tile with one glyph: the shape of the taskbar's own single-action buttons. */
export function GlyphTile(props: { code: number; color?: string; onClick: () => void; tipId: string; tip: () => string[]; preview: boolean }) {
  return (
    <HoverTip id={props.tipId} tip={props.tip} disabled={props.preview}>
      <Tile width={ui.tile.height} padding={0} style={{ justify: "center" }} onClick={props.preview ? undefined : props.onClick}>
        <Glyph code={props.code} color={props.color} />
      </Tile>
    </HoverTip>
  );
}

export function Labeled(props: { children: Child }) {
  return <Row style={{ align: "center", gap: 8 }}>{props.children}</Row>;
}

export const fluent = (code: number) => ({ fluent: code });
