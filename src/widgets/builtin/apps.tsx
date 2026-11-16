import { Image, Pressable, Row, Text, View, store } from "@tarve/core";
import { existsSync } from "node:fs";
import { acquireBadges, badgeFor } from "../../services/badges";
import { iconFor } from "../../services/icons";
import { glyph, showDockMenu, type DockMenuItem } from "../../menu/dock-menu";
import { clickApp, hidePreview, hoverApp } from "../../menu/window-preview";
import { activateApp, closeApp, desktop, focusWindow, launch, openFileLocation, prettyName, windowsPoller } from "../../services/windows";
import { ui } from "../../theme";
import { taskbarPrefs } from "../../services/taskbar-prefs";
import { defineWidget } from "../types";

const env = process.env;
const candidates = [
  "C:\\Windows\\explorer.exe",
  `${env["ProgramFiles(x86)"]}\\Microsoft\\Edge\\Application\\msedge.exe`,
  `${env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
  `${env.LOCALAPPDATA}\\Programs\\Microsoft VS Code\\Code.exe`,
  `${env.ProgramFiles}\\Microsoft VS Code\\Code.exe`,
  `${env.APPDATA}\\Spotify\\Spotify.exe`,
];

interface Item {
  key: string;
  exe: string;
  name: string;
  pinned: boolean;
  running: boolean;
  active: boolean;
  windows: number;
  /** One of its windows asked for attention (FlashWindowEx). */
  attention: boolean;
}

/** The icon being dragged and the icon under it, while an icon is dragged to a new place. */
const drag = store({ source: "", over: "" });
const DRAG_PREFIX = "app:";

/** Unread count (or the app's own overlay picture) on the icon's top-right corner. */
function AppBadge(props: { exe: string }) {
  const badge = badgeFor(props.exe);
  if (!badge) return null;
  if (badge.image && !badge.text) {
    return <Image src={badge.image} width={16} height={16} fit="contain" style={{ position: "absolute", top: 4, right: 2 }} />;
  }
  return (
    <View
      style={{
        position: "absolute",
        top: 3,
        right: badge.text.length > 1 ? 0 : 3,
        minWidth: badge.text ? 16 : 9,
        height: badge.text ? 16 : 9,
        padding: badge.text ? { left: 4, right: 4 } : 0,
        radius: 8,
        background: ui.red,
        borderWidth: 1.5,
        borderColor: ui.dock.background,
        align: "center",
        justify: "center",
      }}
    >
      {badge.text ? (
        <Text size={10} weight={700} color="#fff" style={{ lineHeight: 1 }}>
          {badge.text}
        </Text>
      ) : null}
    </View>
  );
}

function AppIcon(props: {
  item: Item;
  index: number;
  sourceIndex: number;
  onClick: () => void;
  onContextMenu: () => void;
  onMove: (source: string, target: string) => void;
}) {
  const { item } = props;
  const icon = iconFor(item.exe, ui.app.icon);
  const dragging = drag.source === item.key;
  const dropHere = drag.over === item.key && drag.source && !dragging;
  // The marker shows on the side the dragged icon will land.
  const markerSide = props.sourceIndex >= 0 && props.sourceIndex < props.index ? "right" : "left";
  return (
    <Pressable
      id={DRAG_PREFIX + item.key}
      draggable
      dropTarget
      onClick={() => {
        // Several windows: the list of them opens, as on the Windows taskbar.
        if (!clickApp(item.key)) props.onClick();
      }}
      onContextMenu={() => {
        hidePreview(true);
        props.onContextMenu();
      }}
      onHover={(hovered) => {
        if (!drag.source) hoverApp(item.key, hovered);
      }}
      onDragStart={() => {
        hidePreview(true);
        drag.source = item.key;
      }}
      onDragEnter={(source) => {
        if (source.startsWith(DRAG_PREFIX)) drag.over = item.key;
      }}
      onDragLeave={() => {
        if (drag.over === item.key) drag.over = "";
      }}
      onDrop={(event) => {
        if (event.source.startsWith(DRAG_PREFIX)) props.onMove(event.source.slice(DRAG_PREFIX.length), item.key);
      }}
      onDragEnd={() => {
        drag.source = "";
        drag.over = "";
      }}
      style={{
        position: "relative",
        width: ui.app.slot,
        height: ui.tile.height,
        align: "center",
        justify: "center",
        cursor: "pointer",
        radius: 10,
        opacity: dragging ? 0.35 : 1,
        hover: { background: "rgba(255,255,255,0.06)" },
        active: { transform: "scale(0.9)" },
      }}
    >
      {/* The app in front sits on a plate tinted with the Windows accent colour, as on the taskbar;
          an app asking for attention gets an orange plate until its window is activated. */}
      {item.attention ? (
        <View
          style={{
            position: "absolute",
            top: 5,
            left: 2,
            width: 40,
            height: 42,
            radius: 8,
            background: "rgba(247,99,12,0.32)",
            borderWidth: 1,
            borderColor: "rgba(247,99,12,0.55)",
            // Pulses a few times, then stays lit, like the taskbar's flashing button.
            animation: { from: { opacity: 0.35 }, duration: 600, iterations: 6, direction: "alternate", easing: "easeInOut" },
          }}
        />
      ) : item.active && item.running ? (
        <View
          style={{
            position: "absolute",
            top: 5,
            left: 2,
            width: 40,
            height: 42,
            radius: 8,
            background: `${taskbarPrefs.accent}2e`,
            borderWidth: 1,
            borderColor: "rgba(255,255,255,0.06)",
          }}
        />
      ) : null}
      {dropHere ? (
        <View style={{ position: "absolute", top: 8, bottom: 8, width: 3, radius: 2, background: ui.blue, [markerSide]: -2 }} />
      ) : null}
      {/* Two or more windows: a faded copy of the icon sits just behind it, as Windows does. */}
      {item.windows > 1 && icon ? (
        <Image
          src={icon}
          width={ui.app.icon}
          height={ui.app.icon}
          fit="contain"
          style={{ position: "absolute", top: 7, left: 9, opacity: 0.4 }}
        />
      ) : null}
      {icon ? (
        <Image src={icon} width={ui.app.icon} height={ui.app.icon} fit="contain" />
      ) : (
        <View style={{ width: ui.app.icon, height: ui.app.icon, radius: 8, background: "#3a3a40", align: "center", justify: "center" }}>
          <Text size={14} weight={700} color="#fff">
            {item.name.charAt(0)}
          </Text>
        </View>
      )}
      <AppBadge exe={item.exe} />
      {/* Out of the flow, so the icon stays centred like the Start button. */}
      {/* Running: a short grey pill; in front: a longer one in the accent colour. */}
      <View style={{ position: "absolute", bottom: 2, left: 0, right: 0, align: "center" }}>
        <View
          style={{
            width: item.active || item.attention ? 16 : 6,
            height: 3,
            radius: 2,
            background: !item.running
              ? "transparent"
              : item.attention
                ? "#f7630c"
                : item.active
                  ? taskbarPrefs.accent
                  : "rgba(255,255,255,0.55)",
            transition: { width: { duration: 180, easing: "easeOut" } },
          }}
        />
      </View>
    </Pressable>
  );
}

export default defineWidget({
  type: "apps",
  name: "Apps",
  description: "Apps fixados e abertos. Arraste para reordenar; clique direito abre o menu do app.",
  category: "apps",
  defaultConfig: { pinned: candidates.filter((p) => existsSync(p)).slice(0, 5) as string[], showUnpinned: true },
  setup(ctx) {
    ctx.onDispose(windowsPoller.acquire());
    ctx.onDispose(acquireBadges());
    return {};
  },
  menu({ ctx }) {
    return [
      [
        {
          label: ctx.config.showUnpinned === false ? "Mostrar apps abertos não fixados" : "Mostrar só apps fixados",
          icon: glyph.eye,
          onSelect: () => {
            ctx.config.showUnpinned = ctx.config.showUnpinned === false;
            ctx.save();
          },
        },
        { label: "Explorador de Arquivos", icon: "folder", onSelect: () => launch("explorer.exe") },
      ],
    ];
  },
  View({ ctx }) {
    const pinned = ctx.config.pinned;
    const running = new Map(desktop.apps.map((a) => [a.key, a]));
    const items: Item[] = pinned.map((exe) => {
      const key = exe.toLowerCase();
      return {
        key,
        exe,
        name: prettyName(exe),
        pinned: true,
        running: running.has(key),
        active: desktop.activeKey === key,
        windows: running.get(key)?.windows.length ?? 0,
        attention: !!running.get(key)?.windows.some((w) => desktop.flashing.includes(w.hwnd as unknown as number)),
      };
    });
    for (const app of desktop.apps) {
      if (ctx.config.showUnpinned === false) break;
      if (items.some((i) => i.key === app.key)) continue;
      items.push({
        key: app.key,
        exe: app.exe,
        name: app.name,
        pinned: false,
        running: true,
        active: desktop.activeKey === app.key,
        windows: app.windows.length,
        attention: app.windows.some((w) => desktop.flashing.includes(w.hwnd as unknown as number)),
      });
    }
    const togglePin = (item: Item) => {
      const index = pinned.findIndex((p) => p.toLowerCase() === item.key);
      if (index >= 0) pinned.splice(index, 1);
      else pinned.push(item.exe);
      ctx.save();
    };
    // Dropping an icon on another puts it there; it is pinned, so the place sticks.
    const move = (source: string, target: string) => {
      if (source === target) return;
      const keys = items.map((i) => i.key);
      const from = keys.indexOf(source);
      const to = keys.indexOf(target);
      if (from < 0 || to < 0) return;
      const reordered = items.slice();
      const [moved] = reordered.splice(from, 1);
      reordered.splice(to, 0, moved!);
      const next = reordered.filter((i) => i.pinned || i.key === source).map((i) => i.exe);
      pinned.splice(0, pinned.length, ...next);
      ctx.save();
    };
    const sourceIndex = items.findIndex((i) => i.key === drag.source);
    // The entries the Windows taskbar offers, in the dock's own menu above the icon.
    const showMenu = (item: Item) => {
      const windows = desktop.apps.find((a) => a.key === item.key)?.windows ?? [];
      const icon = iconFor(item.exe, 28);
      const windowItems: DockMenuItem[] = windows.slice(0, 8).map((w) => ({
        label: w.title,
        icon: glyph.window,
        onSelect: () => focusWindow(w.hwnd),
      }));
      const actions: DockMenuItem[] = [
        { label: windows.length ? "Nova janela" : "Abrir", icon: "plus", onSelect: () => launch(item.exe) },
        item.pinned
          ? { label: "Desafixar do dock", icon: glyph.unpin, onSelect: () => togglePin(item) }
          : { label: "Fixar no dock", icon: glyph.pin, onSelect: () => togglePin(item) },
        { label: "Abrir local do arquivo", icon: "folder", onSelect: () => openFileLocation(item.exe) },
      ];
      const close: DockMenuItem[] = windows.length
        ? [
            {
              label: windows.length > 1 ? `Fechar ${windows.length} janelas` : "Fechar janela",
              icon: "x",
              danger: true,
              onSelect: () => closeApp(item.key),
            },
          ]
        : [];
      showDockMenu({
        title: item.name,
        subtitle: windows.length ? (windows.length > 1 ? `${windows.length} janelas abertas` : "1 janela aberta") : "Não está aberto",
        image: icon,
        sections: [windowItems, actions, close],
      });
    };
    return (
      <Row style={{ height: ui.tile.height, align: "center", gap: 0, shrink: 0 }}>
        {items.map((item, index) => (
          <AppIcon
            key={item.key}
            item={item}
            index={index}
            sourceIndex={sourceIndex}
            onClick={() => activateApp(item.key, item.exe)}
            onContextMenu={() => showMenu(item)}
            onMove={move}
          />
        ))}
      </Row>
    );
  },
});
