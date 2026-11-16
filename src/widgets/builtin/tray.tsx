import { Icon, Image, Pressable, Row, View } from "@tarve/core";
import { showDockMenu, type DockMenuItem } from "../../menu/dock-menu";
import { acquireTaskbarHost, clickTrayIcon, tray, type TrayIcon } from "../../services/taskbar-host";
import { launch, prettyName } from "../../services/windows";
import { config } from "../../config";
import { ui } from "../../theme";
import { iconHover, Tile } from "../ui";
import { defineWidget } from "../types";

type InlineMode = "promoted" | "all" | "none";

/** Tray icons follow the icon size setting (18 px at 100%). */
const trayIcon = () => Math.round((18 * Math.max(0.7, Math.min(1.3, Number(config.iconScale ?? 100) / 100))) / 2) * 2;

function TrayButton(props: { icon: TrayIcon }) {
  const { icon } = props;
  return (
    <Pressable
      onClick={() => clickTrayIcon(icon, "left")}
      onContextMenu={() => clickTrayIcon(icon, "right")}
      style={{
        width: 30,
        height: 36,
        radius: 7,
        align: "center",
        justify: "center",
        cursor: "pointer",
        shrink: 0,
        ...iconHover(),
      }}
    >
      <Image src={icon.image} width={trayIcon()} height={trayIcon()} fit="contain" />
    </Pressable>
  );
}

const label = (icon: TrayIcon) => icon.tip.split("\n")[0]!.trim() || (icon.exe ? prettyName(icon.exe) : "Ícone");

function openOverflow(icons: TrayIcon[]) {
  // The same flyout as Windows: an icon grid that stays open while you click, so an app that
  // opens on a double click gets both clicks.
  const items: DockMenuItem[] = icons.map((icon) => ({
    label: label(icon),
    icon: { image: icon.image },
    onSelect: () => clickTrayIcon(icon, "left"),
    onDoubleSelect: () => clickTrayIcon(icon, "double"),
    onContextMenu: () => clickTrayIcon(icon, "right"),
  }));
  showDockMenu({ title: "Ícones ocultos", sections: [items], grid: true });
}

/**
 * The notification area: icons other apps put in the system tray. Windows 11's own choice of
 * icons shown on the taskbar stays in the bar; the rest sit behind the arrow.
 */
export default defineWidget({
  type: "tray",
  name: "Bandeja do sistema",
  description: "Ícones dos apps em segundo plano. A seta mostra os ocultos.",
  category: "system",
  defaultConfig: { inline: "promoted" as InlineMode },
  setup(ctx) {
    ctx.onDispose(acquireTaskbarHost());
    return {};
  },
  menu({ ctx }) {
    const set = (inline: InlineMode) => () => {
      ctx.config.inline = inline;
      ctx.save();
    };
    return [
      [
        { label: "Mostrar ícones como o Windows", icon: ctx.config.inline === "promoted" ? "check" : undefined, onSelect: set("promoted") },
        { label: "Mostrar todos os ícones", icon: ctx.config.inline === "all" ? "check" : undefined, onSelect: set("all") },
        { label: "Esconder todos atrás da seta", icon: ctx.config.inline === "none" ? "check" : undefined, onSelect: set("none") },
      ],
      [{ label: "Configurações da barra de tarefas", icon: "settings", onSelect: () => launch("ms-settings:taskbar") }],
    ];
  },
  View({ ctx }) {
    const icons = tray.icons.filter((i) => !i.hidden && i.image);
    const mode = ctx.config.inline;
    const inline = mode === "all" ? icons : mode === "none" ? [] : icons.filter((i) => i.promoted);
    const overflow = icons.filter((i) => !inline.includes(i));
    return (
      <Tile padding={{ left: 4, right: 4 }} gap={0}>
        <Pressable
          onClick={() => overflow.length && openOverflow(overflow)}
          style={{
            width: 26,
            height: 36,
            radius: 7,
            align: "center",
            justify: "center",
            cursor: overflow.length ? "pointer" : "default",
            shrink: 0,
            opacity: overflow.length ? 1 : 0.35,
            hover: { background: "rgba(255,255,255,0.07)" },
          }}
        >
          <Icon name="chevron-up" size={16} color={ui.text} strokeWidth={2} />
        </Pressable>
        {inline.length ? (
          <Row style={{ align: "center", gap: 0 }}>
            {inline.map((icon) => (
              <TrayButton key={icon.key} icon={icon} />
            ))}
          </Row>
        ) : (
          <View />
        )}
      </Tile>
    );
  },
});
