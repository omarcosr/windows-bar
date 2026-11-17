import { Text, View } from "@tarve/core";
import type { DockMenuItem } from "../../../menu/dock-menu";
import { iconFor } from "../../../services/icons";
import { ui } from "../../../theme";

/** Segoe Fluent Icons, as the shell draws these glyphs. */
export const FLUENT_FONT = "Segoe Fluent Icons, Segoe MDL2 Assets";

export const fluentGlyph = {
  history: 0xe81c,
  search: 0xe721,
  command: 0xe756,
  clock: 0xe823,
  timeline: 0xe9d9,
  run: 0xe768,
  apps: 0xe74c,
  folder: 0xe8b7,
  openFolder: 0xe838,
};

export function Glyph(props: { code: number; size?: number; color?: string }) {
  const size = props.size ?? 16;
  return (
    <View style={{ width: size, height: size, align: "center", justify: "center", shrink: 0 }}>
      <Text size={size} color={props.color ?? ui.text} style={{ fontFamily: FLUENT_FONT, lineHeight: 1 }}>
        {String.fromCharCode(props.code)}
      </Text>
    </View>
  );
}

/** A menu icon from the item's shell icon, or the fallback glyph. */
export function shellMenuIcon(path: string, fallback: number): DockMenuItem["icon"] {
  let icon: ReturnType<typeof iconFor>;
  try {
    icon = iconFor(path, 16);
  } catch {
    icon = undefined;
  }
  return icon ? { image: icon } : { fluent: fallback };
}
