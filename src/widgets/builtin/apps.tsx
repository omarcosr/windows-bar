import { Image, Pressable, Row, Text, View, store } from "@tarve/core";
import { acquireBadges, badgeFor } from "../../services/badges";
import { iconFor } from "../../services/icons";
import { glyph, showDockMenu, type DockMenuItem, updateDockMenu, type DockMenuSpec } from "../../menu/dock-menu";
import { clickApp, hidePreview, hoverApp, dragOverApp } from "../../menu/window-preview";
import { activateApp, closeApp, desktop, endTask, focusWindow, launch, openFileLocation, prettyName, windowsPoller, cycleApp, launchAsAdmin, minimizeApp, restoreApp, showWindowSystemMenu, activateWindowButton, type AppWindow } from "../../services/windows";
import { config } from "../../config";
import { devicePx, ui } from "../../theme";
import { dockVertical, taskbarPrefs } from "../../services/taskbar-prefs";
import { taskbarPins, unpinFromTaskbar, watchTaskbarPins, type TaskbarPin } from "../../services/taskbar-pins";
import { progressFor, type ButtonProgress } from "../../services/taskbar-host";
import { explorerStateFor } from "../../services/explorer-buttons";
import { HitReach, axisBox, iconHover, windowsHighlight, windowsHoverPlate } from "../ui";
import { appRoom, dockIndex, dockMetrics, magnifying, magnifyStyles, peakSize, setAppCount } from "../magnify";
import { defineWidget } from "../types";
import { dropFilesOn } from "../../native/drop-target";
import { cursorPos, mouseHoverTime, windowRect } from "../../native/win32";
import type { AppHandle, ImageRgbaSource } from "@tarve/core";
import { DockWindow } from "../../native/dock-window";
import { appIdForShortcut, appIdForWindow, defaultAppIdForProgram, readJumpList, type JumpCategory, linkIconPixels } from "../../native/jump-list";
import { popupSystemMenu } from "../../native/system-menu";
import { systemScale } from "../../native/shell-icon";

/** The last mouse press on the dock: its button and the Shift/Ctrl state Tarve reports with it (pointerEvents). */
let lastPress: { button: number; shift: boolean; ctrl: boolean; at: number } | null = null;
/** Each Apps instance's buttons, for the middle click (released over one of them). */
const middleTargets = new Map<string, { id: string; launch: string }[]>();
let pressWatchers = 0;
let stopPresses: (() => void) | null = null;

/** The press that led to this click or context menu, if it was made with `button`. */
function pressWith(button: number) {
  const p = lastPress;
  return p && p.button === button && Date.now() - p.at < 5000 ? p : null;
}

/**
 * Follows the dock's mouse presses and the pointer entering and leaving app buttons while an Apps
 * widget is shown (one listener for all of them).
 */
function watchPresses(app: AppHandle): () => void {
  if (pressWatchers++ === 0) {
    stopPresses = app.onEvent((event) => {
      if (event.type === "hover") {
        // An app button (or its HitReach, its first child) entered or left. Read here and not with
        // onHover: Tarve re-renders the whole dock after every element handler (~11 ms under txiki),
        // and the pointer crossing the icons fires several of these a second.
        const key = /^app:(.+?)(\/children\/0)?$/.exec(event.id)?.[1];
        // No preview while a button is being dragged to a new place.
        if (key) hoverApp(key, event.entered && !appDrag.source);
        return;
      }
      if (event.type !== "pointer" || event.phase === "wheel") return;
      if (event.phase === "down") {
        lastPress = { button: event.button ?? 0, shift: event.shiftKey, ctrl: event.ctrlKey, at: Date.now() };
        return;
      }
      // Middle button released over an app's button: a new instance, as on the taskbar.
      if (event.button !== 1 || !pressWith(1)) return;
      for (const items of middleTargets.values()) {
        const target = items.find((t) => DockWindow.pointerOn(t.id));
        if (!target) continue;
        hidePreview(true);
        launch(target.launch);
        return;
      }
    });
  }
  return () => {
    if (--pressWatchers === 0) {
      stopPresses?.();
      stopPresses = null;
    }
  };
}

let dragTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Files dragged over a button, as on the taskbar: once they rest there for the system hover time
 * (SPI_GETMOUSEHOVERTIME, what Explorer waits), the app's most recent window comes forward so the
 * files can be dropped into it; an app with several windows opens its thumbnails instead, and the
 * files go on to one of them. Never minimizes, unlike a click.
 */
function dragHoverApp(key: string, hovered: boolean) {
  clearTimeout(dragTimer);
  if (!hovered) return dragOverApp(key, false);
  dragTimer = setTimeout(() => {
    const app = desktop.apps.find((a) => a.key === key);
    if (!app?.windows.length) return;
    if (app.windows.length > 1) return dragOverApp(key, true);
    const minimized = new Set(app.windows.filter((w) => w.minimized).map((w) => w.hwnd));
    const target = app.recent.find((h) => !minimized.has(h)) ?? app.recent[0];
    if (target) focusWindow(target as never);
  }, mouseHoverTime());
}

/** Files dropped on a button open with that app: the shell drop handler of its pin, .lnk or program. */
function dropOnApp(item: Item, paths: string[]) {
  clearTimeout(dragTimer);
  dragOverApp(item.key, false);
  // After Tarve's own Drop has returned to the drag source.
  setTimeout(() => {
    if (!dropFilesOn(item.launch, paths, cursorPos())) console.error("[apps] O app não aceitou os arquivos", item.launch);
  }, 0);
}


interface Item {
  key: string;
  /** Its place in the dock's own order (`order` in the widget's config): the pin's key, else the app's. */
  orderKey: string;
  exe: string;
  /** What a click starts when the app is not running: the pinned shortcut, as the taskbar does. */
  launch: string;
  /** The Windows taskbar pin it comes from. */
  pin?: TaskbarPin;
  /** Pinned to the dock only (Windows does not let other programs pin to its taskbar). */
  dockPin?: DockPin;
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
  // Along the plate's bottom edge, where the running indicator sits, on whole device pixels.
  const inset = devicePx(5);
  const vertical = dockVertical();
  // In a side-edge column the plate is as wide as the tile: the bar runs under the icon across it.
  const track = (vertical ? ui.tile.height : ui.app.plate) - inset * 2;
  const height = devicePx(3);
  return (
    <View
      style={{
        position: "absolute",
        ...(vertical
          ? { bottom: (ui.app.slot - ui.app.plate) / 2 + devicePx(2), left: inset }
          : { bottom: indicatorBottom(), left: (ui.app.slot - ui.app.plate) / 2 + inset }),
        width: track,
        height,
        radius: height / 2,
        background: "rgba(255,255,255,0.18)",
      }}
    >
      <View
        style={{
          width: indeterminate ? track : Math.max(height, devicePx(track * p.value)),
          height,
          radius: height / 2,
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
    return <Image src={badge.image} width={16} height={16} fit="contain" style={{ position: "absolute", top: 4, right: 2, radius: 0 }} />;
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

/**
 * The plate behind the icon: as tall as the slot (room for the icon and, under it, the indicator,
 * like the Windows 11 button), 4 px narrower so neighbouring plates keep a gap. Whole device px.
 */
function plateBox() {
  const plate = ui.app.plate;
  const inset = (ui.app.slot - plate) / 2;
  // Narrower along the dock: across a row, down a side-edge column.
  return dockVertical()
    ? { position: "absolute" as const, left: 0, top: inset, width: ui.tile.height, height: plate, radius: devicePx(8) }
    : { position: "absolute" as const, top: 0, left: inset, width: plate, height: ui.tile.height, radius: devicePx(8) };
}

/**
 * Where the running indicator sits, as the taskbar draws it (measured on each edge): under the
 * icon on a bar at the bottom or the top, left of it on a bar at either side. The pill lies
 * along that side.
 */
function indicatorBox(): Record<string, unknown> {
  const at = indicatorBottom();
  if (dockVertical()) return { position: "absolute", left: at, top: 0, bottom: 0, justify: "center" };
  return { position: "absolute", bottom: at, left: 0, right: 0, align: "center" };
}

/**
 * The running indicator sits under the icon with a 3 px gap, inside the plate's bottom edge, as on
 * the Windows 11 taskbar; on a short bar it keeps at least 1 px from the edge.
 */
function indicatorBottom() {
  const below = (ui.tile.height - ui.app.icon) / 2;
  return Math.max(devicePx(1), devicePx(below - devicePx(3) - devicePx(3)));
}

function AppIcon(props: {
  item: Item;
  /** Place in the dock's Start + Apps group, for the macOS magnification. */
  dockIndex: number;
  onClick: () => void;
  onContextMenu: () => void;
  /** Drag sideways to reorder (appDragProps), and where a dragged button lands on this one. */
  drag: ReturnType<typeof appDragProps>;
      /** How far this button's look slides along the bar while another is dragged (appShifts). */
    shift: number;
}) {
  const { item } = props;
  // Sharp when magnified: the bitmap is read once at the largest size the icon reaches.
  // A pin shows its shortcut's icon, as the taskbar does (it can differ from the program's).
  const magnified = magnifying();
  const icon = iconFor(item.pin?.path ?? item.exe, magnified ? peakSize(dockMetrics()) : ui.app.icon, magnified);
  const magnify = magnifyStyles("dock", props.dockIndex, dockMetrics());
  // Several windows: the list of them opens, as on the Windows taskbar.
  const onClick = () => {
    if (modifiedClick(item)) return;
    if (!clickApp(item.key)) props.onClick();
  };
  const onContextMenu = () => {
    hidePreview(true);
    props.onContextMenu();
  };
  return (
    <Pressable
      // The window preview anchors above the icon by this id.
      id={"app:" + item.key}
      // A taskbar button never keeps the keyboard: Enter or Space after a click must not press it again.
      focusable={false}
      onClick={onClick}
      onContextMenu={onContextMenu}
      {...props.drag}
      onFileDragEnter={() => dragHoverApp(item.key, true)}
      onFileDragLeave={() => dragHoverApp(item.key, false)}
      onFileDrop={(event) => dropOnApp(item, event.paths)}
      style={{
        position: "relative",
        ...axisBox(ui.app.slot, ui.tile.height),
        align: "center",
        justify: "center",
        cursor: "pointer",
        radius: 10,
        group: true,
        ...iconHover({ magnified: true, plate: true }),
        ...magnify.slot,
        opacity: appDrag.source === item.orderKey ? 0.4 : 1,
      }}
    >
      <HitReach height={ui.tile.height} onClick={onClick} onContextMenu={onContextMenu} drag={props.drag} />
      {/* The look slides while a button is dragged; the slot (and its hit area) stays put. */}
      <View style={shiftStyle(props.shift)}>
      {/* The app in front sits on a plate tinted with the Windows accent colour, as on the taskbar;
          an app asking for attention gets an orange plate until its window is activated. */}
      {/* The macOS effect draws no plate, as on the Dock: the grown icon would spill over it. The
          indicator below still marks the app in front (accent) and one asking for attention (orange). */}
      {/* "Realce do Windows": the taskbar's hover plate, under the front/attention plate's tint. */}
      {windowsHighlight() ? <View style={{ ...plateBox(), ...windowsHoverPlate() }} /> : null}
      {magnifying() ? null : item.attention ? (
        <View
          style={{
            ...plateBox(),
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
            ...plateBox(),
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
              style={{ position: "absolute", top: -3, left: 3, opacity: 0.4, radius: 0, ...magnify.icon }}
            />
          ) : null}
          {icon ? (
            <Image src={icon} width={ui.app.icon} height={ui.app.icon} fit="contain" style={{ radius: 0, ...magnify.icon }} />
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
      <View style={{ ...indicatorBox(), opacity: config.runningIndicator && !appProgress(item.exe) ? 1 : 0 }}>
        <View
          style={{
            ...(dockVertical()
              ? { height: devicePx(item.active || item.attention ? 16 : 6, true), width: devicePx(3) }
              : { width: devicePx(item.active || item.attention ? 16 : 6, true), height: devicePx(3) }),
            radius: devicePx(3) / 2,
            background: !item.running
              ? "transparent"
              : item.attention
                ? "#f7630c"
                : item.active
                  ? taskbarPrefs.accent
                  : "rgba(255,255,255,0.55)",
            transition: { width: { duration: 180, easing: "easeOut" }, height: { duration: 180, easing: "easeOut" } },
          }}
        />
        </View>
      </View>
      </Pressable>
  );
}

/** An app pinned to the dock only; it keeps its identity so its windows group under it. */
interface DockPin {
  /** What starts it: the program, or shell:AppsFolder\\<AUMID> for packaged apps. */
  path: string;
  /** The running app's key (its AppUserModelID key, or the lower-cased program). */
  key: string;
  /** Lower-cased program, for windows that set no AppUserModelID. */
  program: string;
  name: string;
}

/**
 * The taskbar's overflow button: apps without room on the bar sit behind "•••", in a flyout
 * grid, as Windows 11 does when the taskbar fills up.
 */
function OverflowButton(props: { items: Item[]; dockIndex: number; onContextMenu: (item: Item) => void }) {
  const magnify = magnifyStyles("dock", props.dockIndex, dockMetrics());
  const open = () => {
    hidePreview(true);
    showDockMenu({
      title: "Mais apps",
      grid: true,
      sections: [
        props.items.map((item): DockMenuItem => {
          const icon = iconFor(item.pin?.path ?? item.exe, 32);
          return {
            label: item.name,
            icon: icon ? { image: icon } : glyph.window,
            onSelect: () => activateApp(item.key, item.launch),
            onContextMenu: () => props.onContextMenu(item),
          };
        }),
      ],
    });
  };
  const attention = props.items.some((i) => i.attention);
  return (
    <Pressable
      focusable={false}
      onClick={open}
      style={{
        position: "relative",
        ...axisBox(ui.app.slot, ui.tile.height),
        align: "center",
        justify: "center",
        cursor: "pointer",
        radius: 10,
        ...iconHover({ magnified: true }),
        ...magnify.slot,
      }}
    >
      <HitReach height={ui.tile.height} onClick={open} />
      <Text size={16} color={attention ? "#ff9f0a" : ui.text} style={{ fontFamily: "Segoe Fluent Icons, Segoe MDL2 Assets", lineHeight: 1 }}>
        {String.fromCharCode(0xe712)}
      </Text>
    </Pressable>
  );
}
/** Width of a labelled button, in app slots: at most LABEL_MAX, never below LABEL_MIN (then the taskbar combines or overflows). */
const LABEL_MAX = 4;
const LABEL_MIN = 2;

/** One button of the row: an app (icon only), or one window of it with its title (the taskbar not combining). */
interface Button {
  item: Item;
  win?: AppWindow;
}

/**
 * The buttons for Settings > Taskbar > "Combine taskbar buttons and hide labels" (TaskbarGlomLevel),
 * as Explorer lays them out: 0 always, one icon per app; 1 when the taskbar is full, one labelled
 * button per window while they fit, combined icons once they do not; 2 never, labelled buttons that
 * narrow and then overflow behind "•••". Apps that are not running keep an icon-only button. A
 * side-edge column has no room for labels: it always combines.
 */
function layoutButtons(instanceId: string, items: Item[]) {
  const glom = taskbarPrefs.glom;
  const combined = (): { visible: Button[]; overflow: Item[]; slots: number[] } => {
    const room = appRoom(instanceId, items.length);
    const overflow = items.length > room ? items.slice(Math.max(0, room - 1)) : [];
    const shown = overflow.length ? items.slice(0, Math.max(0, room - 1)) : items;
    return { visible: shown.map((item) => ({ item })), overflow, slots: shown.map(() => 1) };
  };
  if (glom === 0 || dockVertical()) return combined();
  const buttons: Button[] = items.flatMap((item): Button[] => {
    const wins = item.running ? (desktop.apps.find((a) => a.key === item.key)?.windows ?? []) : [];
    return wins.length ? wins.map((win) => ({ item, win })) : [{ item }];
  });
  const labelled = buttons.filter((b) => b.win).length;
  const icons = buttons.length - labelled;
  const room = appRoom(instanceId, icons + labelled * LABEL_MAX);
  const per = labelled ? Math.min(LABEL_MAX, Math.floor((room - icons) / labelled)) : LABEL_MAX;
  if (per >= LABEL_MIN) return { visible: buttons, overflow: [] as Item[], slots: buttons.map((b) => (b.win ? per : 1)) };
  if (glom === 1) return combined();
  // Never combine, and still no room: the narrowest labels, the rest behind the overflow button.
  const visible: Button[] = [];
  const slots: number[] = [];
  let used = 1;
  for (const b of buttons) {
    const w = b.win ? LABEL_MIN : 1;
    if (used + w > room) break;
    visible.push(b);
    slots.push(w);
    used += w;
  }
  const shownKeys = new Set(visible.map((b) => b.win ?? b.item.key));
  const overflow = items.filter((item, i, all) => all.indexOf(item) === i && buttons.some((b) => b.item === item && !shownKeys.has(b.win ?? b.item.key)));
  return { visible, overflow, slots };
}

/**
 * A window's own button (the taskbar set not to combine): its app's icon and the window title,
 * on a plate as wide as `slots` app slots. A click brings the window forward, or minimizes it when
 * it is already in front, as Explorer's ungrouped button does; right-click opens the app's menu.
 */
function WindowButton(props: {
  item: Item;
  win: AppWindow;
  slots: number;
  onContextMenu: () => void;
  drag: ReturnType<typeof appDragProps>;
      shift: number;
}) {
  const { item, win } = props;
  const icon = iconFor(item.pin?.path ?? item.exe, ui.app.icon);
  const hwnd = Number(win.hwnd);
  const active = desktop.activeHwnd === hwnd && !win.minimized;
  const attention = desktop.flashing.includes(hwnd);
  const width = props.slots * ui.app.slot;
  const inset = (ui.app.slot - ui.app.plate) / 2;
  const onClick = () => {
    if (modifiedClick(item)) return;
    hidePreview(true);
    activateWindowButton(win.hwnd);
  };
  const onContextMenu = () => {
    hidePreview(true);
    // Shift+right-click on an uncombined button: that window's own system menu, as on the taskbar.
    if (pressWith(2)?.shift) {
      const at = cursorPos();
      if (popupSystemMenu(win.hwnd, at.x, at.y)) return;
    }
    props.onContextMenu();
  };
  return (
    <Pressable
      id={"win:" + hwnd}
      focusable={false}
      onClick={onClick}
      onContextMenu={onContextMenu}
      {...props.drag}
        style={{ position: "relative", width, height: ui.tile.height, cursor: "pointer", radius: 10, ...iconHover({ magnified: true }), opacity: appDrag.source === item.orderKey ? 0.4 : 1 }}
      >
      <HitReach height={ui.tile.height} onClick={onClick} onContextMenu={onContextMenu} drag={props.drag} />
      <View style={shiftStyle(props.shift)}>
      {attention || active ? (
        <View
          style={{
            position: "absolute",
            top: 0,
            left: inset,
            width: width - inset * 2,
            height: ui.tile.height,
            radius: devicePx(8),
            background: attention ? "rgba(247,99,12,0.32)" : `${taskbarPrefs.accent}2e`,
            borderWidth: 1,
            borderColor: attention ? "rgba(247,99,12,0.55)" : "rgba(255,255,255,0.06)",
          }}
        />
      ) : null}
      <Row style={{ position: "absolute", top: 0, bottom: 0, left: (ui.app.slot - ui.app.icon) / 2, right: inset + devicePx(6), align: "center", gap: devicePx(8) }}>
        {icon ? (
          <Image src={icon} width={ui.app.icon} height={ui.app.icon} fit="contain" style={{ radius: 0, shrink: 0 }} />
        ) : (
          <View style={{ width: ui.app.icon, height: ui.app.icon, radius: 8, background: "#3a3a40", shrink: 0 }} />
        )}
        <Text size={12} color={ui.text} style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", textOverflow: "ellipsis", overflow: "hidden" }}>
          {win.title || item.name}
        </Text>
      </Row>
      <AppProgress exe={item.exe} />
      <View style={{ ...indicatorBox(), opacity: config.runningIndicator && !appProgress(item.exe) ? 1 : 0 }}>
        <View
          style={{
            width: devicePx(active || attention ? 16 : 6, true),
            height: devicePx(3),
            radius: devicePx(3) / 2,
            background: attention ? "#f7630c" : active ? taskbarPrefs.accent : "rgba(255,255,255,0.55)",
            transition: { width: { duration: 180, easing: "easeOut" } },
          }}
        />
        </View>
      </View>
      </Pressable>
  );
}
/** The AppUserModelID Explorer keeps the app's jump list under: asked of a window, else of the pin. */
function jumpAppId(item: Item, windows: readonly AppWindow[]): string {
  const hwnd = windows[0]?.hwnd as unknown as number | undefined;
  const fromWindow = hwnd ? appIdForWindow(hwnd) : "";
  if (fromWindow) return fromWindow;
  const path = item.pin?.path ?? item.dockPin?.path ?? item.launch;
  const packaged = /^shell:AppsFolder\\(.+)$/i.exec(path);
  if (packaged) return packaged[1]!;
  if (/\.lnk$/i.test(path)) return appIdForShortcut(path);
  return /^[a-z]:\\/i.test(path) ? defaultAppIdForProgram(path) : "";
}

const JUMP_TITLES: Record<JumpCategory["kind"], string> = { pinned: "Fixado", recent: "Recentes", frequent: "Frequentes", tasks: "Tarefas", custom: "" };

/** The app's jump list as menu sections, each under the heading the taskbar gives it. */
function jumpSections(appId: string, refresh: () => void): { sections: DockMenuItem[][]; titles: string[] } {
  const categories = readJumpList(appId);
  return {
    sections: categories.map((category) =>
      category.items.map((entry): DockMenuItem => {
        const image = jumpIcon(entry.iconPath, entry.iconIndex);
        return {
          label: entry.label,
          icon: image ? { image } : { fluent: 0xe8a5 },
          onSelect: entry.open,
          trailing: entry.pinnable
            ? {
                icon: entry.pinned ? glyph.unpin : glyph.pin,
                label: entry.pinned ? "Desafixar desta lista" : "Fixar nesta lista",
                onSelect: () => {
                  entry.togglePin();
                  refresh();
                },
              }
            : undefined,
        };
      }),
    ),
    titles: categories.map((category) => category.title || JUMP_TITLES[category.kind]),
  };
}
/** A jump-list row's icon: a link's own icon resource, else the shell's icon for the item. */
const jumpIcons = new Map<string, ImageRgbaSource | null>();
function jumpIcon(path: string, index: number | null): ImageRgbaSource | string | undefined {
  if (!path) return undefined;
  if (index === null) return iconFor(path, 16);
  const px = Math.round(16 * systemScale());
  const key = `${path.toLowerCase()},${index}|${px}`;
  let icon = jumpIcons.get(key);
  if (icon === undefined) {
    const pixels = linkIconPixels(path, index, px);
    icon = pixels ? { ...pixels, cacheKey: `jump:${key}` } : null;
    if (jumpIcons.size > 256) jumpIcons.clear();
    jumpIcons.set(key, icon);
  }
  return icon ?? iconFor(path, 16);
}
/**
 * Reordering by dragging a button sideways, as on the taskbar. Windows keeps the order of its pins
 * in Explorer's memory and writes Taskband\Favorites itself; IPinnedList3 (CLSID_TaskbarPin) has no
 * move, and its Modify silently ignores pins from other processes on Windows 11, so the order cannot
 * be written to the Windows taskbar from here. The dock keeps its own order instead, in the widget's
 * `order` (pins, dock pins and open apps alike); buttons it does not know keep Windows' place.
 */
const appDrag = store({ instance: "", source: "", over: "" });

function appDragProps(instance: string, item: Item, onMove: (source: string, target: string) => void) {
  const key = item.orderKey;
  return {
    draggable: true,
    dropTarget: true,
    onDragStart: () => {
      hidePreview(true);
      clearTimeout(dragTimer);
      appDrag.instance = instance;
      appDrag.source = key;
    },
    onDragEnter: () => {
      if (appDrag.source && appDrag.instance === instance) appDrag.over = key;
    },
    // Leaving a button keeps it as the target: past the last (or first) one the dragged button
    // stays at that end, as on the taskbar; entering another button retargets it.
    onDrop: () => {
      const source = appDrag.instance === instance ? appDrag.source : "";
      // Cleared first: the new order renders with no slide left to ease back.
      appDrag.instance = "";
      appDrag.source = "";
      appDrag.over = "";
      if (source) onMove(source, key);
    },
    onDragEnd: () => {
      // Not dropped on a button (released past the end of the group): it lands where it was
      // shown, if still on the bar; released off the bar, it goes back, as on the taskbar.
      const source = appDrag.instance === instance ? appDrag.source : "";
      const over = appDrag.over;
      appDrag.instance = "";
      appDrag.source = "";
      appDrag.over = "";
      if (source && over && source !== over && pointerOnDock()) onMove(source, over);
    },
  };
}

/**
 * How far each visible button's look slides while one is dragged, in px along the bar: the dragged
 * one moves to where it will land and the ones it passes make room, as the taskbar's icons do.
 * The slots themselves stay put, so the button under the pointer is the place it lands on.
 */
function appShifts(instance: string, keys: readonly string[], slots: readonly number[]): number[] {
  const shifts = keys.map(() => 0);
  if (appDrag.instance !== instance || !appDrag.source || !appDrag.over || appDrag.source === appDrag.over) return shifts;
  const source = keys.flatMap((k, i) => (k === appDrag.source ? [i] : []));
  const target = keys.flatMap((k, i) => (k === appDrag.over ? [i] : []));
  if (!source.length || !target.length) return shifts;
  const px = (i: number) => slots[i]! * ui.app.slot;
  const width = source.reduce((a, i) => a + px(i), 0);
  let passed = 0;
  if (source[0]! < target[0]!) {
    // Moving forward: it lands after the target; the buttons in between step back.
    for (let i = source[source.length - 1]! + 1; i <= target[target.length - 1]!; i++) {
      shifts[i] = -width;
      passed += px(i);
    }
    for (const i of source) shifts[i] = passed;
  } else {
    for (let i = target[0]!; i < source[0]!; i++) {
      shifts[i] = width;
      passed += px(i);
    }
    for (const i of source) shifts[i] = -passed;
  }
  return shifts;
}

/** A button's look, slid by `shift` px along the bar; it eases only while a drag is going on, so the drop lands without a jump. */
function shiftStyle(shift: number) {
  return {
    position: "absolute" as const,
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    transform: dockVertical() ? `translateY(${shift}px)` : `translateX(${shift}px)`,
    ...(appDrag.source ? { transition: { transform: { duration: 200, easing: "easeOut" as const } } } : {}),
  };
}

/** `items` in the saved order: known buttons take the saved sequence, unknown ones keep their place. */
function applyOrder(items: Item[], order: readonly string[] | undefined): Item[] {
  if (!order?.length) return items;
  const rank = new Map(order.map((k, i) => [k, i]));
  const known = items.filter((i) => rank.has(i.orderKey)).sort((a, b) => rank.get(a.orderKey)! - rank.get(b.orderKey)!);
  let next = 0;
  return items.map((i) => (rank.has(i.orderKey) ? known[next++]! : i));
}





export default defineWidget({
  type: "apps",
  name: "Apps",
  description: "Os apps fixados da barra de tarefas do Windows, os fixados no dock e os abertos. Clique direito abre o menu do app.",
  category: "apps",
  defaultConfig: { showUnpinned: true, dockPins: [] as DockPin[], order: [] as string[] },
  settings: [{ kind: "toggle", key: "showUnpinned", label: "Mostrar apps abertos não fixados" }],
  setup(ctx) {
    watchTaskbarPins();
    ctx.onDispose(windowsPoller.acquire());
    ctx.onDispose(acquireBadges());
    // The app handle is set right after the first render; until then the presses are not needed.
    let unwatch: (() => void) | null = null;
    let disposed = false;
    queueMicrotask(() => {
      if (!disposed) unwatch = watchPresses(ctx.app);
    });
    ctx.onDispose(() => {
      disposed = true;
      unwatch?.();
      middleTargets.delete(ctx.instanceId);
    });
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
      // As the taskbar matches a pin: by AppUserModelID, else (windows that set none) by program.
      const app = running.get(pin.key) ?? desktop.apps.find((a) => !a.explicitId && a.program === pin.program);
      const key = app?.key ?? pin.key;
      if (items.some((i) => i.key === key)) continue;
      items.push({
        key,
        orderKey: pin.key,
        exe: pin.exe,
        launch: pin.path,
        pin,
        name: pin.name || prettyName(pin.exe),
        pinned: true,
        running: !!app,
        active: desktop.activeKey === key,
        windows: app?.windows.length ?? 0,
        attention: attention(key),
      });
    }
    // Then the dock's own pins, in the order they were pinned.
    const dockPins = (ctx.config.dockPins ??= []);
    for (const pin of dockPins) {
      const app = running.get(pin.key) ?? desktop.apps.find((a) => !a.explicitId && a.program === pin.program);
      const key = app?.key ?? pin.key;
      if (items.some((i) => i.key === key)) continue;
      items.push({
        key,
        orderKey: pin.key,
        exe: app?.exe ?? pin.path,
        launch: pin.path,
        dockPin: pin,
        name: app?.name ?? pin.name,
        pinned: true,
        running: !!app,
        active: desktop.activeKey === key,
        windows: app?.windows.length ?? 0,
        attention: attention(key),
      });
    }
    for (const app of desktop.apps) {
      if (ctx.config.showUnpinned === false) break;
      if (items.some((i) => i.key === app.key)) continue;
      items.push({
        key: app.key,
        orderKey: app.key,
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
    // No room for every icon: the last slot becomes the overflow button, as on the taskbar.
    // Labelled per-window buttons when Windows is set not to combine (TaskbarGlomLevel).
    // In the order the buttons were dragged to (the dock's own: see appDrag).
    const ordered = applyOrder(items, ctx.config.order as string[] | undefined);
    const moveApp = (source: string, target: string) => {
      const keys = ordered.map((i) => i.orderKey);
      const from = keys.indexOf(source);
      const to = keys.indexOf(target);
      if (from < 0 || to < 0 || from === to) return;
      keys.splice(to, 0, keys.splice(from, 1)[0]!);
      // Apps closed now keep their remembered place for when they open again.
      const old = (ctx.config.order as string[] | undefined) ?? [];
      ctx.config.order = [...keys, ...old.filter((k) => !keys.includes(k))].slice(0, 200);
      ctx.save();
    };
    const { visible, overflow, slots } = layoutButtons(ctx.instanceId, ordered);
    // Slot offsets along the group, for the magnification and the group's room.
    const offsets = slots.map((_, i) => slots.slice(0, i).reduce((a, b) => a + b, 0));
    // While a button is dragged, the looks slide to show the order it would leave.
    const shifts = appShifts(ctx.instanceId, visible.map((b) => b.item.orderKey), slots);
    const used = slots.reduce((a, b) => a + b, 0);
    setAppCount(ctx.instanceId, used + (overflow.length ? 1 : 0));
    middleTargets.set(
      ctx.instanceId,
      visible.map(({ item, win }) => ({ id: win ? "win:" + Number(win.hwnd) : "app:" + item.key, launch: item.launch })),
    );
    const pinToDock = (item: Item) => {
      const app = desktop.apps.find((a) => a.key === item.key);
      if (!app || dockPins.some((p) => p.key === app.key)) return;
      dockPins.push({ path: app.exe, key: app.key, program: app.program, name: app.name });
      ctx.save();
    };
    const unpinFromDock = (pin: DockPin) => {
      const index = dockPins.indexOf(pin);
      if (index >= 0) dockPins.splice(index, 1);
      ctx.save();
    };
    // The entries the Windows taskbar offers, in the dock's own menu above the icon.
    const showMenu = (item: Item) => {
      const windows = desktop.apps.find((a) => a.key === item.key)?.windows ?? [];
      const icon = iconFor(item.exe, 28);
      // Shift+right-click, as on the taskbar: one window shows its own system menu; a group gets
      // the taskbar's group menu (restore, minimize or close all its windows).
      if (pressWith(2)?.shift && windows.length) {
        const at = cursorPos();
        if (showWindowSystemMenu(item.key, at.x, at.y)) return;
        if (windows.length > 1) {
          showDockMenu({
            title: item.name,
            subtitle: `${windows.length} janelas abertas`,
            image: icon,
            sections: [
              [
                { label: "Restaurar todas as janelas", icon: glyph.window, onSelect: () => restoreApp(item.key) },
                { label: "Minimizar todas as janelas", icon: glyph.window, onSelect: () => minimizeApp(item.key) },
              ],
              [{ label: "Fechar todas as janelas", icon: "x", danger: true, onSelect: () => closeApp(item.key) }],
            ],
          });
          return;
        }
      }
      const windowItems: DockMenuItem[] = windows.slice(0, 8).map((w) => ({
        label: w.title,
        icon: glyph.window,
        onSelect: () => focusWindow(w.hwnd),
      }));
      const actions: DockMenuItem[] = [
        { label: windows.length ? "Nova janela" : "Abrir", icon: "plus", onSelect: () => launch(item.launch) },
        item.pin
          ? { label: "Desafixar da barra de tarefas", icon: glyph.unpin, onSelect: () => void unpinFromTaskbar(item.pin!) }
          : item.dockPin
            ? { label: "Desafixar do dock", icon: glyph.unpin, onSelect: () => unpinFromDock(item.dockPin!) }
            : { label: "Fixar no dock", icon: glyph.pin, onSelect: () => pinToDock(item) },
        ...(/^[a-z]:\\/i.test(item.exe)
          ? [{ label: "Abrir local do arquivo", icon: "folder" as const, onSelect: () => openFileLocation(item.exe) }]
          : []),
      ];
      const close: DockMenuItem[] = windows.length
        ? [
            // Settings > System > For developers > End task: above "Close", as on the taskbar.
            ...(taskbarPrefs.endTask
              ? [{ label: "Encerrar tarefa", icon: glyph.endTask, danger: true, onSelect: () => endTask(item.key) }]
              : []),
            {
              label: windows.length > 1 ? `Fechar ${windows.length} janelas` : "Fechar janela",
              icon: "x",
              danger: true,
              onSelect: () => closeApp(item.key),
            },
          ]
        : [];
      // The app's jump list (pinned, recent/frequent, its own categories, tasks) above the app's
      // entries, as on the taskbar; pinning an item redraws the open menu in place.
      const appId = jumpAppId(item, windows);
      const menuId = `jump:${item.key}`;
      const spec = (): DockMenuSpec => {
        const jump = jumpSections(appId, () => updateDockMenu(menuId, spec()));
        return {
          id: menuId,
          title: item.name,
          subtitle: windows.length ? (windows.length > 1 ? `${windows.length} janelas abertas` : "1 janela aberta") : "Não está aberto",
          image: icon,
          sections: [...jump.sections, windowItems, actions, close],
          sectionTitles: jump.titles,
        };
      };
      showDockMenu(spec());
    };
    return (
      <View style={{ direction: dockVertical() ? "column" : "row", ...(dockVertical() ? { width: ui.tile.height } : { height: ui.tile.height }), align: "center", gap: 0, shrink: 0 }}>
        {visible.map(({ item, win }, index) =>
          win ? (
            <WindowButton key={"win:" + Number(win.hwnd)} item={item} win={win} slots={slots[index]!} onContextMenu={() => showMenu(item)} drag={appDragProps(ctx.instanceId, item, moveApp)} shift={shifts[index]!} />
          ) : (
          <AppIcon
            key={item.key}
            item={item}
            dockIndex={dockIndex(ctx.instanceId, offsets[index]!)}
            onClick={() => activateApp(item.key, item.launch)}
            onContextMenu={() => showMenu(item)}
              drag={appDragProps(ctx.instanceId, item, moveApp)}
            shift={shifts[index]!}
          />
          ),
        )}
        {overflow.length ? (
          <OverflowButton items={overflow} dockIndex={dockIndex(ctx.instanceId, used)} onContextMenu={showMenu} />
        ) : null}
      </View>
    );
  },
});
/**
 * A left click with Shift/Ctrl, as on the taskbar: Shift = new instance, Ctrl+Shift = as administrator
 * (the "runas" verb), Ctrl = the app's next window. False for a plain click.
 */
function modifiedClick(item: Item): boolean {
  const press = pressWith(0);
  if (!press || !(press.shift || press.ctrl)) return false;
  hidePreview(true);
  if (press.shift && press.ctrl) launchAsAdmin(item.launch);
  else if (press.shift) launch(item.launch);
  else cycleApp(item.key, item.launch);
  return true;
}
/** The pointer is on the dock's window (the bar), in physical screen px. */
function pointerOnDock(): boolean {
  const hwnd = DockWindow.handle();
  if (!hwnd) return false;
  const r = windowRect(hwnd);
  const p = cursorPos();
  return p.x >= r.left && p.x < r.right && p.y >= r.top && p.y < r.bottom;
}
