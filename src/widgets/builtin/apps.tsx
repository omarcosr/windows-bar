import { Image, Pressable, Row, Text, View, store } from "@tarve/core";
import { existsSync } from "node:fs";
import { iconFor } from "../../services/icons";
import { glyph, showDockMenu, type DockMenuItem } from "../../menu/dock-menu";
import { hidePreview, hoverApp } from "../../menu/window-preview";
import { activateApp, closeApp, desktop, focusWindow, launch, openFileLocation, prettyName, windowsPoller } from "../../services/windows";
import { ui } from "../../theme";
import { Dot } from "../ui";
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
}

/** The icon being dragged and the icon under it, while an icon is dragged to a new place. */
const drag = store({ source: "", over: "" });
const DRAG_PREFIX = "app:";

function AppIcon(props: {
  item: Item;
  index: number;
  sourceIndex: number;
  onClick: () => void;
  onContextMenu: () => void;
  onMove: (source: string, target: string) => void;
}) {
  const { item } = props;
  const icon = iconFor(item.exe);
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
        hidePreview(true);
        props.onClick();
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
      {dropHere ? (
        <View style={{ position: "absolute", top: 8, bottom: 8, width: 3, radius: 2, background: ui.blue, [markerSide]: -2 }} />
      ) : null}
      <View style={{ position: "relative" }}>
        {icon ? (
          <Image src={icon} width={ui.app.icon} height={ui.app.icon} fit="contain" />
        ) : (
          <View style={{ width: ui.app.icon, height: ui.app.icon, radius: 8, background: "#3a3a40", align: "center", justify: "center" }}>
            <Text size={14} weight={700} color="#fff">
              {item.name.charAt(0)}
            </Text>
          </View>
        )}
        {item.windows > 1 ? (
          <View
            style={{
              position: "absolute",
              top: -4,
              right: -6,
              minWidth: 15,
              height: 15,
              radius: 8,
              padding: { left: 4, right: 4 },
              background: "#2c2c31",
              borderWidth: 1.5,
              borderColor: ui.dock.background,
              align: "center",
              justify: "center",
            }}
          >
            <Text size={9} weight={700} color="#fff" style={{ fontVariantNumeric: "tabular-nums", lineHeight: 1 }}>
              {String(item.windows)}
            </Text>
          </View>
        ) : null}
      </View>
      {/* Out of the flow, so the icon stays centred like the Start button. */}
      <View style={{ position: "absolute", bottom: 3, left: 0, right: 0, align: "center" }}>
        <Dot color={item.running ? ui.blue : "transparent"} width={item.active ? 12 : 4} />
      </View>
    </Pressable>
  );
}

export default defineWidget({
  type: "apps",
  name: "Apps",
  description: "Apps fixados e abertos. Arraste para reordenar; clique direito abre o menu do app.",
  category: "apps",
  defaultConfig: { pinned: candidates.filter((p) => existsSync(p)).slice(0, 5) as string[] },
  setup(ctx) {
    ctx.onDispose(windowsPoller.acquire());
    return {};
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
      };
    });
    for (const app of desktop.apps) {
      if (items.some((i) => i.key === app.key)) continue;
      items.push({
        key: app.key,
        exe: app.exe,
        name: app.name,
        pinned: false,
        running: true,
        active: desktop.activeKey === app.key,
        windows: app.windows.length,
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
      const icon = iconFor(item.exe);
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
