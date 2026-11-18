import { Image, Pressable, Row, View } from "@tarve/core";
import { FluentGlyph, holdDockMenu, toggleDockMenu, updateDockMenu, type DockMenuItem, type DockMenuSpec } from "../../menu/dock-menu";
import { windowPidOf } from "../../native/tray-host";
import { acquireTaskbarHost, clickTrayIcon, tray, type TrayIcon } from "../../services/taskbar-host";
import { launch, prettyName } from "../../services/windows";
import { config } from "../../config";
import { dockEdge, dockVertical } from "../../services/taskbar-prefs";
import { ui } from "../../theme";
import { HitReach, iconHover, Tile } from "../ui";
import { HoverTip, hideTip } from "../../menu/hover-tip";
import { defineWidget } from "../types";

type InlineMode = "promoted" | "all" | "none";

/** Tray icons follow the icon size setting (18 px at 100%). */
const trayIcon = () => Math.round((18 * Math.max(0.7, Math.min(1.3, Number(config.iconScale ?? 100) / 100))) / 2) * 2;

function TrayButton(props: { icon: TrayIcon; preview?: boolean }) {
  const { icon } = props;
  const onClick = () => {
    hideTip();
    clickTrayIcon(icon, "left");
  };
  const onContextMenu = () => {
    hideTip();
    clickTrayIcon(icon, "right");
  };
  // The app's own tip text, shown by the taskbar on hover.
  return (
    <HoverTip id={`tip:tray:${icon.key}`} tip={() => icon.tip.split("\n").map((l) => l.trim())} disabled={props.preview} side="full">
    <Pressable
      focusable={false}
      onClick={onClick}
      onContextMenu={onContextMenu}
      style={{
        position: "relative",
        // Stacked in a side-edge column: as wide as before, shorter along the column.
        width: 30,
        height: dockVertical() && !props.preview ? 28 : 36,
        radius: 7,
        align: "center",
        justify: "center",
        cursor: "pointer",
        shrink: 0,
        ...iconHover(),
      }}
    >
      <HitReach height={dockVertical() && !props.preview ? 30 : 36} onClick={onClick} onContextMenu={onContextMenu} />
      <Image src={icon.image} width={trayIcon()} height={trayIcon()} fit="contain" />
    </Pressable>
    </HoverTip>
  );
}

const label = (icon: TrayIcon) => icon.tip.split("\n")[0]!.trim() || (icon.exe ? prettyName(icon.exe) : "Ícone");

const OVERFLOW_MENU = "tray-overflow";

/** The overflow arrow's Fluent glyph per dock edge: ChevronUp, ChevronDown, ChevronRight, ChevronLeft. */
const ARROWS = { bottom: 0xe70e, top: 0xe70d, left: 0xe76c, right: 0xe76b } as const;

/** The icons the open flyout shows; it is refreshed only when this changes (no render loop). */
let shownOverflow = "";
const overflowKey = (icons: TrayIcon[]) => icons.map((i) => `${i.key}\u0001${i.tip}`).join("\u0002");

function openOverflow(icons: TrayIcon[], anchor: string) {
  shownOverflow = overflowKey(icons);
  // A second press of the arrow puts the flyout away, as on the taskbar.
  toggleDockMenu(overflowSpec(icons), anchor);
}

function overflowSpec(icons: TrayIcon[]): DockMenuSpec & { id: string } {
  // The same flyout as Windows: an icon grid that stays open while you click, so an app that
  // opens on a double click gets both clicks.
  const items: DockMenuItem[] = icons.map((icon) => ({
    label: label(icon),
    icon: { image: icon.image },
    onSelect: () => clickTrayIcon(icon, "left"),
    onDoubleSelect: () => clickTrayIcon(icon, "double"),
    onContextMenu: () => {
      holdDockMenu(windowPidOf(icon.hwnd));
      clickTrayIcon(icon, "right");
    },
  }));
  return { id: OVERFLOW_MENU, title: "Ícones ocultos", sections: [items], grid: true };
}

/**
 * The notification area: icons other apps put in the system tray. Windows 11's own choice of
 * icons shown on the taskbar stays in the bar; the rest sit behind the arrow.
 */
export default defineWidget({
  type: "tray",
  sideForm: "full",
  name: "Bandeja do sistema",
  description: "Ícones dos apps em segundo plano. A seta mostra os ocultos.",
  category: "system",
  defaultConfig: { inline: "promoted" as InlineMode },
  settings: [
    {
      kind: "choice",
      key: "inline",
      label: "Ícones na barra",
      description: "Quais ícones ficam visíveis; o resto fica atrás da seta.",
      options: [
        { value: "promoted", label: "Como o Windows" },
        { value: "all", label: "Todos" },
        { value: "none", label: "Nenhum" },
      ],
    },
  ],
  setup(ctx) {
    ctx.onDispose(acquireTaskbarHost());
    return {};
  },
  menu() {
    return [
      [{ label: "Configurações da barra de tarefas", icon: "settings", onSelect: () => launch("ms-settings:taskbar") }],
    ];
  },
  View({ ctx, preview }) {
    const vertical = dockVertical() && !preview;
    const icons = tray.icons.filter((i) => !i.hidden && i.image);
    const mode = ctx.config.inline;
    const inline = mode === "all" ? icons : mode === "none" ? [] : icons.filter((i) => i.promoted);
    const overflow = icons.filter((i) => !inline.includes(i));
    // An open flyout follows the icons: one whose app quit leaves it at once, as on the taskbar.
    // Only when the hidden icons really changed: updating the menu re-renders, which renders this
    // again, so an unconditional update would loop forever.
    const key = overflowKey(overflow);
    const arrow = `tray-overflow:${ctx.instanceId}`;
    if (!preview && key !== shownOverflow) {
      shownOverflow = key;
      queueMicrotask(() => updateDockMenu(OVERFLOW_MENU, overflow.length ? overflowSpec(overflow) : null));
    }
    return (
      <Tile padding={{ left: 4, right: 4 }} gap={0} side="full">
        <Pressable
          id={preview ? undefined : arrow}
          onClick={() => overflow.length && openOverflow(overflow, arrow)}
          style={{
            width: vertical ? 30 : 26,
            height: vertical ? 24 : 36,
            radius: 7,
            align: "center",
            justify: "center",
            cursor: overflow.length ? "pointer" : "default",
            shrink: 0,
            opacity: overflow.length ? 1 : 0.35,
            hover: { background: "rgba(255,255,255,0.07)" },
          }}
        >
          {/* The taskbar's "Mostrar ícones ocultos" arrow (ChevronUp glyph). */}
          {/* Pointing to where the flyout opens: up, or down / right / left on the other edges. */}
          <FluentGlyph code={preview ? 0xe70e : ARROWS[dockEdge()]} size={12} color={ui.text} />
        </Pressable>
        {inline.length ? (
          <View style={{ direction: vertical ? "column" : "row", align: "center", gap: 0 }}>
            {inline.map((icon) => (
              <TrayButton key={icon.key} icon={icon} preview={preview} />
            ))}
          </View>
        ) : (
          <View />
        )}
      </Tile>
    );
  },
});
