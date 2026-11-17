import { Image, Pressable, Row, Text, View } from "@tarve/core";
import { acquireBadges, badgeFor } from "../../services/badges";
import { iconFor } from "../../services/icons";
import { glyph, showDockMenu, type DockMenuItem } from "../../menu/dock-menu";
import { clickApp, hidePreview, hoverApp } from "../../menu/window-preview";
import { activateApp, closeApp, desktop, focusWindow, launch, openFileLocation, prettyName, windowsPoller } from "../../services/windows";
import { config } from "../../config";
import { ui } from "../../theme";
import { taskbarPrefs } from "../../services/taskbar-prefs";
import { taskbarPins, unpinFromTaskbar, watchTaskbarPins, type TaskbarPin } from "../../services/taskbar-pins";
import { progressFor, type ButtonProgress } from "../../services/taskbar-host";
import { explorerStateFor } from "../../services/explorer-buttons";
import { iconHover } from "../ui";
import { dockIndex, dockMetrics, magnifying, magnifyStyles, peakSize, setAppCount } from "../magnify";
import { defineWidget } from "../types";

interface Item {
  key: string;
  exe: string;
  /** What a click starts when the app is not running: the pinned shortcut, as the taskbar does. */
  launch: string;
  /** The Windows taskbar pin it comes from. */
  pin?: TaskbarPin;
  name: string;
  pinned: boolean;
  running: boolean;
  active: boolean;
  windows: number;
  /** One of its windows asked for attention (FlashWindowEx). */
  attention: boolean;
}

/** Progress the app reports on its button (ITaskbarList3), from the dock's host or Explorer's. */
function appProgress(exe: string): ButtonProgress | undefined {
  const own = progressFor(exe);
  if (own) return own;
  // Apps started before the dock report progress to Explorer only.
  const value = explorerStateFor(exe)?.progress;
  return value !== undefined ? { key: exe.toLowerCase(), state: 2, value } : undefined;
}

/**
 * Drawn like Windows 11: a bar along the bottom of the slot in place of the running pill.
 * Accent while running, yellow paused, red on error; indeterminate pulses the whole track.
 */
function AppProgress(props: { exe: string }) {
  const p = appProgress(props.exe);
  if (!p) return null;
  const color = p.state & 4 ? ui.red : p.state & 8 ? "#fce100" : taskbarPrefs.accent;
  const indeterminate = !!(p.state & 1);
  const track = ui.app.slot - 12;
  return (
    <View style={{ position: "absolute", bottom: 2, left: 6, width: track, height: 3, radius: 2, background: "rgba(255,255,255,0.18)" }}>
      <View
        style={{
          width: indeterminate ? track : Math.max(3, Math.round(track * p.value)),
          height: 3,
          radius: 2,
          background: color,
          transition: { width: { duration: 250, easing: "easeOut" } },
          ...(indeterminate
            ? { animation: { from: { opacity: 0.25 }, duration: 800, iterations: Infinity, direction: "alternate", easing: "easeInOut" } }
            : {}),
        }}
      />
    </View>
  );
}

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
  /** Place in the dock's Start + Apps group, for the macOS magnification. */
  dockIndex: number;
  onClick: () => void;
  onContextMenu: () => void;
}) {
  const { item } = props;
  // Sharp when magnified: the bitmap is read at the largest size the icon reaches.
  const icon = iconFor(item.exe, magnifying() ? peakSize(dockMetrics()) : ui.app.icon);
  const magnify = magnifyStyles("dock", props.dockIndex, dockMetrics());
  return (
    <Pressable
      // The window preview anchors above the icon by this id.
      id={"app:" + item.key}
      onClick={() => {
        // Several windows: the list of them opens, as on the Windows taskbar.
        if (!clickApp(item.key)) props.onClick();
      }}
      onContextMenu={() => {
        hidePreview(true);
        props.onContextMenu();
      }}
      onHover={(hovered) => hoverApp(item.key, hovered)}
      style={{
        position: "relative",
        width: ui.app.slot,
        height: ui.tile.height,
        align: "center",
        justify: "center",
        cursor: "pointer",
        radius: 10,
        ...iconHover({ magnified: true }),
        ...magnify.slot,
      }}
    >
      {/* The app in front sits on a plate tinted with the Windows accent colour, as on the taskbar;
          an app asking for attention gets an orange plate until its window is activated. */}
      {/* The macOS effect draws no plate, as on the Dock: the grown icon would spill over it. The
          indicator below still marks the app in front (accent) and one asking for attention (orange). */}
      {magnifying() ? null : item.attention ? (
        <View
          style={{
            position: "absolute",
            // Inset from the slot, so the plate follows the bar height.
            top: 5,
            bottom: 5,
            left: 2 + magnify.grow,
            right: 2 + magnify.grow,
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
            // Inset from the slot, so the plate follows the bar height.
            top: 5,
            bottom: 5,
            left: 2 + magnify.grow,
            right: 2 + magnify.grow,
            radius: 8,
            background: `${taskbarPrefs.accent}2e`,
            borderWidth: 1,
            borderColor: "rgba(255,255,255,0.06)",
          }}
        />
      ) : null}
      {/* The icon grows up from its bottom edge (macOS magnification), with its stacked copy, and
          the badge follows its corner; the plate and the indicators keep the slot's size. */}
      <View style={magnify.box}>
        <View style={{ position: "relative", ...magnify.icon }}>
          {/* Two or more windows: a faded copy of the icon sits just behind it, as Windows does. */}
          {item.windows > 1 && icon && config.stackedIcons ? (
            <Image
              src={icon}
              width={ui.app.icon}
              height={ui.app.icon}
              fit="contain"
              // 3 px up and right of the icon, whatever the bar height.
              style={{ position: "absolute", top: -3, left: 3, opacity: 0.4, ...magnify.icon }}
            />
          ) : null}
          {icon ? (
            <Image src={icon} width={ui.app.icon} height={ui.app.icon} fit="contain" style={magnify.icon} />
          ) : (
            <View style={{ radius: 8, background: "#3a3a40", align: "center", justify: "center", ...magnify.icon }}>
              <Text size={14} weight={700} color="#fff">
                {item.name.charAt(0)}
              </Text>
            </View>
          )}
        </View>
      </View>
      <View style={magnify.corner}>
        <AppBadge exe={item.exe} />
      </View>
      <AppProgress exe={item.exe} />
      {/* Out of the flow, so the icon stays centred like the Start button. */}
      {/* Running: a short grey pill; in front: a longer one in the accent colour. */}
      <View style={{ position: "absolute", bottom: 2, left: 0, right: 0, align: "center", opacity: config.runningIndicator && !appProgress(item.exe) ? 1 : 0 }}>
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
  description: "Os mesmos apps fixados da barra de tarefas do Windows, e os abertos. Clique direito abre o menu do app.",
  category: "apps",
  defaultConfig: { showUnpinned: true },
  settings: [{ kind: "toggle", key: "showUnpinned", label: "Mostrar apps abertos não fixados" }],
  setup(ctx) {
    watchTaskbarPins();
    ctx.onDispose(windowsPoller.acquire());
    ctx.onDispose(acquireBadges());
    return {};
  },
  menu() {
    return [
      [
        { label: "Explorador de Arquivos", icon: "folder", onSelect: () => launch("explorer.exe") },
        { label: "Fixar e organizar na barra do Windows", icon: "settings", onSelect: () => launch("ms-settings:taskbar") },
      ],
    ];
  },
  View({ ctx }) {
    // Pins come from the Windows taskbar itself (same apps, same order); pin, unpin and reorder there.
    const running = new Map(desktop.apps.map((a) => [a.key, a]));
    const attention = (key: string) => !!running.get(key)?.windows.some((w) => desktop.flashing.includes(w.hwnd as unknown as number));
    const items: Item[] = [];
    for (const pin of taskbarPins.items) {
      if (items.some((i) => i.key === pin.key)) continue;
      items.push({
        key: pin.key,
        exe: pin.exe,
        launch: pin.path,
        pin,
        name: pin.name || prettyName(pin.exe),
        pinned: true,
        running: running.has(pin.key),
        active: desktop.activeKey === pin.key,
        windows: running.get(pin.key)?.windows.length ?? 0,
        attention: attention(pin.key),
      });
    }
    for (const app of desktop.apps) {
      if (ctx.config.showUnpinned === false) break;
      if (items.some((i) => i.key === app.key)) continue;
      items.push({
        key: app.key,
        exe: app.exe,
        launch: app.exe,
        name: app.name,
        pinned: false,
        running: true,
        active: desktop.activeKey === app.key,
        windows: app.windows.length,
        attention: attention(app.key),
      });
    }
    setAppCount(ctx.instanceId, items.length);
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
        { label: windows.length ? "Nova janela" : "Abrir", icon: "plus", onSelect: () => launch(item.launch) },
        ...(item.pin
          ? [{ label: "Desafixar da barra de tarefas", icon: glyph.unpin, onSelect: () => void unpinFromTaskbar(item.pin!) }]
          : []),
        ...(/^[a-z]:\\/i.test(item.exe)
          ? [{ label: "Abrir local do arquivo", icon: "folder" as const, onSelect: () => openFileLocation(item.exe) }]
          : []),
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
            dockIndex={dockIndex(ctx.instanceId, index)}
            onClick={() => activateApp(item.key, item.launch)}
            onContextMenu={() => showMenu(item)}
          />
        ))}
      </Row>
    );
  },
});
