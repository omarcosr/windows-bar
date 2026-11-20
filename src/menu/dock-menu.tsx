import {
  Column,
  Icon,
  Image,
  Pressable,
  Row,
  Text,
  View,
  Window,
  darkTheme,
  store,
  type AppHandle,
  type IconName,
  type ImageSource,
  type ScreenInfo,
  type SvgNode,
} from "@tarve/core";
import { DockWindow } from "../native/dock-window";
import { raiseDragGhost } from "./drag-ghost";
import { activateDesktop, activateWindow, foregroundWindow, isWindowVisible, popupMenuVisible, windowPid, type HWND } from "../native/win32";
import { ui } from "../theme";
import { onShellEvent, watchMenuPopups } from "../native/shell-events";

export interface DockMenuItem {
  label: string;
  /** A built-in icon name, a Lucide-style node list, or an image path. */
  icon?: IconName | readonly SvgNode[] | FluentIcon | { image: ImageSource };
  danger?: boolean;
  onSelect: () => void;
  /** Right-click on the row. */
  onContextMenu?: () => void;
  /** Grid menus only: a second click on the same item within a moment. */
  onDoubleSelect?: () => void;
  /** Grid menus only: the pointer entered (true) or left (false) the item. */
  onHover?: (hovered: boolean) => void;
  /**
   * Grid menus only: the item can be dragged out of the menu (the hidden-icons flyout's icons onto
   * the taskbar). `end` gets the release (cancelled: Esc or the menu lost the focus); where it
   * landed is the owner's to check (the pointer, in screen px).
   */
  drag?: { start?: () => void; move?: () => void; end: (cancelled: boolean) => void };
  /** A small button at the row's end (the jump list's pin), run instead of onSelect. */
  trailing?: { icon: FluentIcon; label: string; onSelect: () => void };
}

export interface DockMenuSpec {
  title: string;
  subtitle?: string;
  image?: ImageSource;
  sections: DockMenuItem[][];
  /** A heading per section (same index as sections), like the jump list's "Fixado" / "Tarefas". */
  sectionTitles?: (string | undefined)[];
  /**
   * Icons only, five per row, no header, like the Windows hidden-icons flyout. Clicks do not
   * close it; it closes when something else comes to the front, a press lands outside or Esc.
   */
  grid?: boolean;
  /** Names a live menu, so its owner can refresh it while open (updateDockMenu). */
  id?: string;
}

const MENU_TITLE = "WindowsBar Menu";
const PANEL_WIDTH = 288;

const menu = store({ spec: null as DockMenuSpec | null });

let handle: AppHandle | undefined;
let size = { width: PANEL_WIDTH, height: 200 };
/** Where the menu opens, in physical screen px: the pointer's x and the monitor under it. */
let anchorX = 0;
let scale = 1;
let area = { x: 0, y: 0, width: 1920, height: 1080 };
/** Bumped on every open and close; a pending open whose number moved on is dropped. */
let opening = 0;
let pending = false;

/** A character of Windows' icon font (Segoe Fluent Icons), as the shell's own menus and flyouts draw icons. */
export interface FluentIcon {
  fluent: number;
}
const fluent = (code: number): FluentIcon => ({ fluent: code });
const FLUENT_FONT = "Segoe Fluent Icons, Segoe MDL2 Assets";

/** Menu glyphs: the same Segoe Fluent Icons characters Windows uses for these actions. */
export const glyph = {
  pin: fluent(0xe718),
  unpin: fluent(0xe77a),
  window: fluent(0xe737),
  grid: fluent(0xe80a),
  activity: fluent(0xe9d9),
  eye: fluent(0xe7b3),
  bar: fluent(0xe7f4),
  /** "Encerrar tarefa": the circle with a slash the taskbar menu shows (Blocked). */
  endTask: fluent(0xe733),
  /** Settings sliders, as a menu entry. */
  settings: fluent(0xe9e9),
  /** Settings badge on widgets (an outline drawing: it reads at 12 px where a glyph blurs). */
  sliders: [
    ["path", { d: "M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3" }],
    ["path", { d: "M14 2v4M8 10v4M16 18v4" }],
  ] as readonly SvgNode[],
};

/** The icon names the dock's menus use, as their Segoe Fluent Icons characters. */
const NAMED: Record<string, number> = {
  plus: 0xe710,
  folder: 0xe8b7,
  x: 0xe711,
  settings: 0xe713,
  bell: 0xea8f,
  search: 0xe721,
  star: 0xe734,
  info: 0xe946,
  play: 0xe768,
  pause: 0xe769,
  "chevron-right": 0xe76c,
  "chevron-left": 0xe76b,
  "skip-forward": 0xe893,
  "skip-back": 0xe892,
  download: 0xe896,
  check: 0xe73e,
};

/**
 * One Segoe Fluent Icons character, drawn as the shell draws its own buttons' glyphs (the preview's
 * close button, the tray arrow): use this instead of outline drawings anywhere Windows has a glyph.
 */
export function FluentGlyph(props: { code: number; size: number; color?: string }) {
  return (
    <View style={{ width: props.size, height: props.size, align: "center", justify: "center", shrink: 0 }}>
      <Text size={props.size} color={props.color ?? ui.text} style={{ fontFamily: FLUENT_FONT, lineHeight: 1 }}>
        {String.fromCharCode(props.code)}
      </Text>
    </View>
  );
}

function ItemIcon(props: { icon: DockMenuItem["icon"]; color: string; size?: number }) {
  const { icon } = props;
  const size = props.size ?? 16;
  if (!icon) return <View style={{ width: size, height: size }} />;
  if (typeof icon === "object" && "image" in icon) return <Image src={icon.image} width={size} height={size} fit="contain" style={{ radius: 0 }} />;
  const code = typeof icon === "object" && "fluent" in icon ? icon.fluent : typeof icon === "string" ? NAMED[icon] : undefined;
  if (code !== undefined) {
    return (
      <View style={{ width: size, height: size, align: "center", justify: "center" }}>
        <Text size={size} color={props.color} style={{ fontFamily: FLUENT_FONT, lineHeight: 1 }}>
          {String.fromCharCode(code)}
        </Text>
      </View>
    );
  }
  if (typeof icon === "string") return <Icon name={icon} size={size} color={props.color} strokeWidth={2} />;
  return <Icon iconNode={icon as readonly SvgNode[]} size={size} color={props.color} strokeWidth={2} />;
}

function MenuRow(props: { item: DockMenuItem }) {
  const { item } = props;
  const color = item.danger ? "#ff6961" : ui.text;
  const trailing = item.trailing;
  if (trailing) {
    // The jump list's pin button: beside the row, not inside it, so its click is its own.
    return (
      <Row style={{ align: "center", gap: 2 }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <MenuRow item={{ ...item, trailing: undefined }} />
        </View>
        <Pressable
          onClick={trailing.onSelect}
          style={{
            width: 30,
            height: 34,
            align: "center",
            justify: "center",
            radius: 8,
            cursor: "pointer",
            hover: { background: "rgba(255,255,255,0.08)" },
            active: { background: "rgba(255,255,255,0.12)" },
          }}
        >
          <FluentGlyph code={trailing.icon.fluent} size={14} color="#c7c7cc" />
        </Pressable>
      </Row>
    );
  }
  return (
    <Pressable
      // The action runs before the menu closes: while the menu is in front, this process may
      // still hand the foreground to the app the action opens.
      onClick={() => {
        item.onSelect();
        closeDockMenu();
      }}
      onContextMenu={
        item.onContextMenu
          ? () => {
              item.onContextMenu!();
              closeDockMenu();
            }
          : undefined
      }
      style={{
        direction: "row",
        align: "center",
        gap: 10,
        height: 34,
        padding: { left: 10, right: 10 },
        radius: 8,
        cursor: "pointer",
        hover: { background: item.danger ? "rgba(255,105,97,0.14)" : "rgba(255,255,255,0.08)" },
        active: { background: "rgba(255,255,255,0.12)" },
      }}
    >
      <ItemIcon icon={item.icon} color={item.danger ? color : "#c7c7cc"} />
      <Text size={13} color={color} style={{ flex: 1, whiteSpace: "nowrap", textOverflow: "ellipsis", overflow: "hidden" }}>
        {item.label}
      </Text>
    </Pressable>
  );
}

let lastGridClick = { item: null as DockMenuItem | null, at: 0 };

function GridCell(props: { item: DockMenuItem }) {
  const { item } = props;
  return (
    <Pressable
      onClick={() => {
        const now = Date.now();
        const double = lastGridClick.item === item && now - lastGridClick.at < 450;
        lastGridClick = { item: double ? null : item, at: now };
        if (double && item.onDoubleSelect) item.onDoubleSelect();
        else item.onSelect();
      }}
      onContextMenu={item.onContextMenu}
      onHover={item.onHover}
      draggable={!!item.drag}
      onDragStart={item.drag?.start}
      onDragMove={item.drag?.move}
      onDragEnd={item.drag ? (event) => item.drag!.end(event.cancelled) : undefined}
      style={{
        width: GRID.cell,
        height: GRID.cell,
        radius: 8,
        align: "center",
        justify: "center",
        cursor: "pointer",
        hover: { background: "rgba(255,255,255,0.08)" },
        active: { background: "rgba(255,255,255,0.12)", transform: "scale(0.94)" },
      }}
    >
      <ItemIcon icon={item.icon} color="#c7c7cc" size={20} />
    </Pressable>
  );
}

function GridPanel(props: { items: DockMenuItem[] }) {
  const rows: DockMenuItem[][] = [];
  for (let i = 0; i < props.items.length; i += GRID.columns) rows.push(props.items.slice(i, i + GRID.columns));
  return (
    <Column style={{ padding: GRID.padding, gap: GRID.gap, radius: 14, background: "#1c1c1f" }}>
      {rows.map((row, i) => (
        <Row key={i} style={{ gap: GRID.gap }}>
          {row.map((item, j) => (
            <GridCell key={j} item={item} />
          ))}
        </Row>
      ))}
    </Column>
  );
}

function MenuView() {
  const spec = menu.spec;
  return (
    <Window
      title={MENU_TITLE}
      width={PANEL_WIDTH}
      height={420}
      frameless
      resizable={false}
      skipTaskbar
      level="alwaysOnTop"
      backdrop="transparent"
      visible={false}
      chrome="none"
      theme={darkTheme}
      style={{ background: "rgba(0,0,0,0)" }}
    >
      <View style={{ flex: 1, align: "start", justify: "start" }}>
        <View onSize={({ width, height }) => resize(width, height)} style={{ shrink: 0 }}>
          {spec?.grid ? (
            <GridPanel items={spec.sections.flat()} />
          ) : spec ? (
            <Column
              style={{
                width: PANEL_WIDTH,
                padding: 6,
                gap: 2,
                radius: 14,
                background: "#1c1c1f",
              }}
            >
              <Row style={{ align: "center", gap: 10, padding: { left: 10, right: 10, top: 8, bottom: 8 } }}>
                {spec.image ? <Image src={spec.image} width={28} height={28} fit="contain" style={{ radius: 0 }} /> : null}
                <Column style={{ flex: 1, gap: 1, minWidth: 0 }}>
                  <Text
                    size={13}
                    weight={650}
                    color={ui.text}
                    style={{ whiteSpace: "nowrap", textOverflow: "ellipsis", overflow: "hidden" }}
                  >
                    {spec.title}
                  </Text>
                  {spec.subtitle ? (
                    <Text size={11} color={ui.muted}>
                      {spec.subtitle}
                    </Text>
                  ) : null}
                </Column>
              </Row>
              {spec.sections
                .map((section, index) => ({ section, title: spec.sectionTitles?.[index] }))
                .filter((s) => s.section.length)
                .map(({ section, title }, index) => (
                  <Column key={index} style={{ gap: 0 }}>
                    <View style={{ height: 1, margin: { left: 8, right: 8, top: 3, bottom: 3 }, background: "rgba(255,255,255,0.07)" }} />
                    {title ? (
                      <Text size={11} weight={600} color={ui.muted} style={{ padding: { left: 10, right: 10, top: 4, bottom: 2 } }}>
                        {title}
                      </Text>
                    ) : null}
                    {section.map((item, i) => (
                      <MenuRow key={i} item={item} />
                    ))}
                  </Column>
                ))}
            </Column>
          ) : null}
        </View>
      </View>
    </Window>
  );
}

function place() {
  if (!handle) return;
  const width = Math.ceil(size.width * scale);
  const height = Math.ceil(size.height * scale);
  const gap = Math.round(8 * scale);
  const { x, y } = DockWindow.placePopup(width, height, gap, area, anchorX, 80);
  handle.setBounds({ x, y, width, height, physical: true });
  bounds = { x, y, width, height };
}

/** Where the open menu sits, in physical screen px (set by place). */
let bounds = { x: 0, y: 0, width: 0, height: 0 };
let shown = false;

/** GridPanel's layout: padding, cell size and gap, five cells per row (logical px). */
const GRID = { padding: 8, cell: 40, gap: 4, columns: 5 };

/**
 * The physical screen box of item `index` of open grid menu `id` (a hidden-icons flyout icon), for
 * popups that point at it; null when that menu is not up.
 */
export function gridCellRect(id: string, index: number) {
  if (!shown || !menu.spec?.grid || menu.spec.id !== id || index < 0) return null;
  const step = GRID.cell + GRID.gap;
  const col = index % GRID.columns;
  const row = Math.floor(index / GRID.columns);
  return {
    x: Math.round(bounds.x + (GRID.padding + col * step) * scale),
    y: Math.round(bounds.y + (GRID.padding + row * step) * scale),
    width: Math.round(GRID.cell * scale),
    height: Math.round(GRID.cell * scale),
  };
}

/** Whether the point (physical screen px) is over open menu `id`. */
export function pointOnDockMenu(id: string, p: { x: number; y: number }) {
  if (!shown || menu.spec?.id !== id) return false;
  return p.x >= bounds.x && p.x < bounds.x + bounds.width && p.y >= bounds.y && p.y < bounds.y + bounds.height;
}

/** True from an open until the new content's size is known (onSize only fires on a change). */
let awaitingSize = false;
/** Shows the opening menu once both its screen and its size are known. */
let reveal: (() => void) | null = null;

function resize(width: number, height: number) {
  if (width <= 0 || height <= 0) return;
  size = { width, height };
  awaitingSize = false;
  if (reveal) reveal();
  else if (menu.spec) place();
}

function screenAt(screens: ScreenInfo[], p: { x: number; y: number } | null) {
  const hit = p && screens.find((s) => p.x >= s.x && p.x < s.x + s.width && p.y >= s.y && p.y < s.y + s.height);
  return hit || screens.find((s) => s.primary) || screens[0];
}

/**
 * The menu window stays shown for Tarve all along and is put away by moving it off every screen:
 * Tarve's show also activates it, which ends a drag in progress (the tray's flyout opens under
 * one), and a window hidden by any means is no longer painted, so showing it again without Tarve
 * drew nothing. place() brings it back; activation is asked for separately.
 */
function setShown(visible: boolean) {
  if (!handle || visible) return;
  const focused = handle.isFocused();
  handle.setBounds({ x: -32000, y: -32000, width: Math.ceil(size.width * scale), height: Math.ceil(size.height * scale), physical: true });
  // Closed while it has the keyboard (Esc, a choice): the window that had it before the menu
  // opened gets it back, as when a taskbar flyout closes; a window moved away would keep it.
  // With none to go back to (it closed, or was a hidden window), the desktop takes it, as when the
  // last window goes.
  if (!focused) return;
  if (previousForeground && isWindowVisible(previousForeground)) activateWindow(previousForeground);
  else activateDesktop();
}
/** The foreground window when the open menu took the focus. */
let previousForeground: HWND | null = null;

/** Creates the menu window once, hidden, so right-clicks open it without delay. */
export async function initDockMenu(app: AppHandle) {
  handle = app.openWindow(MenuView, { id: "menu", keyboardEvents: true, closeBehavior: "hide" });
  await handle.ready;
  // Shown for Tarve (it paints it from now on), hidden on screen until a menu opens.
  setShown(false);
  // Tarve's show also activates it: the app the user is in gets the foreground straight back.
  const before = foregroundWindow();
  if (before && windowPid(before) !== process.pid) {
    const off = handle.onFocusChange((focused) => {
      if (!focused) return;
      off();
      clearTimeout(giveUp);
      if (isWindowVisible(before)) activateWindow(before);
    });
    // It may not take the foreground at all (another app holds it): nothing to give back then.
    const giveUp = setTimeout(off, 2000);
  }
  handle.show();
  handle.onEvent((event) => {
    if (event.type === "keyboard" && (event as { key?: string }).key === "Escape") closeDockMenu();
  });
  // Light dismiss: the menu is activated when it opens, so a click anywhere else (another app,
  // the desktop, the dock itself) takes the focus from it. An open still waiting for the
  // screen query ignores the blur of the menu it replaces. A press on the dock button that opened
  // it leaves it open: that click's toggleDockMenu puts it away, as the taskbar's flyouts do.
  handle.onFocusChange((focused, change) => {
    if (focused || pending || hold) return;
    if (change.to === "main" && menuAnchor && DockWindow.pressedOn(menuAnchor, change.pointerTarget)) return;
    // No target reported: the pointer on the opening button is the same press.
    if (!change.to && menuAnchor && DockWindow.pointerOn(menuAnchor)) return;
    closeDockMenu();
  });
}

/** Opens the dock's popup menu above the pointer. */
let hold: { owner: number; seen: boolean; until: number; stop: () => void } | null = null;

function stopHold() {
  if (!hold) return;
  hold.stop();
  hold = null;
}

/**
 * Keeps the menu open while an app answers a right-click on one of its items with its own
 * context menu, as the Windows tray overflow does. The menu loses the focus to that context
 * menu, so the light dismiss waits until the context menu is gone and the foreground has moved
 * on to something other than the owner's hidden menu window (or back to the dock).
 */
export function holdDockMenu(ownerPid: number) {
  stopHold();
  if (!menu.spec) return;
  let settle: ReturnType<typeof setTimeout> | undefined;
  const check = () => {
    if (!menu.spec || hold !== state) return stopHold();
    if (popupMenuVisible()) {
      state.seen = true;
      return;
    }
    // No standard menu yet: the app may still be building it, or draws a custom one.
    if (!state.seen && Date.now() < state.until) return;
    const fg = foregroundWindow();
    const pid = fg ? windowPid(fg) : 0;
    if (pid === process.pid) {
      stopHold();
      handle?.activate();
    } else if (fg && pid === state.owner && (!state.seen || !isWindowVisible(fg))) {
      // Menu dismissed without a choice (or a custom menu still up): stay open.
    } else {
      closeDockMenu();
    }
  };
  // A menu closing and the foreground moving on arrive as a burst: decide once it settles.
  const soon = () => {
    clearTimeout(settle);
    settle = setTimeout(check, 50);
  };
  // EVENT_SYSTEM_MENUPOPUPSTART/END and EVENT_SYSTEM_FOREGROUND from the shell-events worker, plus one
  // timer at the end of the grace period an app gets to show its menu.
  const releaseMenus = watchMenuPopups();
  const off = onShellEvent((event) => {
    if (event.type === "menuPopup") {
      if (event.start) state.seen = true;
      soon();
    } else if (event.type === "foreground") soon();
  });
  const grace = setTimeout(check, 1500);
  const state = {
    owner: ownerPid,
    seen: false,
    until: Date.now() + 1500,
    stop: () => {
      clearTimeout(settle);
      clearTimeout(grace);
      off();
      releaseMenus();
    },
  };
  hold = state;
}

export function showDockMenu(spec: DockMenuSpec, options: { activate?: boolean } = {}) {
  const h = handle;
  if (!h) return;
  stopHold();
  menuAnchor = null;
  const ticket = ++opening;
  pending = true;
  awaitingSize = true;
  reveal = null;
  menu.spec = spec;
  void h.screens().then(({ screens, cursor }) => {
    if (ticket !== opening) return;
    const screen = screenAt(screens, cursor);
    if (screen) {
      scale = screen.scale || 1;
      area = { x: screen.x, y: screen.y, width: screen.width, height: screen.height };
    }
    anchorX = DockWindow.along(cursor, area);
    // Shown at the old menu's size, the window jumped when the new size came in a frame later:
    // wait for it. A menu of the same size reports none, so a short timeout shows it anyway.
    const show = () => {
      if (reveal !== show) return;
      reveal = null;
      if (ticket !== opening) return;
      pending = false;
      place();
      shown = true;
      setShown(true);
      // Opened under a drag (an icon brought over the tray's arrow): not activated, since a
      // window coming to the front ends the drag's mouse capture; activateDockMenu() hands it the
      // focus after the drop. The dragged icon's copy stays above it.
      if (options.activate === false) return void raiseDragGhost();
      rememberForeground();
      h.activate();
    };
    reveal = show;
    if (!awaitingSize) show();
    else setTimeout(show, 50);
  });
}

/**
 * Replaces the open menu's content when it is still menu `id` (its items changed while open, e.g.
 * a tray icon whose app quit); null closes it. Does nothing when another menu, or none, is open.
 */
export function updateDockMenu(id: string, spec: DockMenuSpec | null) {
  if (!menu.spec || menu.spec.id !== id) return;
  if (!spec) closeDockMenu();
  else menu.spec = { ...spec, id };
}

/** Gives an open menu the focus it did not take when opened under a drag, for its light dismiss. */
export function activateDockMenu(id: string) {
  if (!shown || menu.spec?.id !== id) return;
  rememberForeground();
  handle?.activate();
}

function rememberForeground() {
  const fg = foregroundWindow();
  // The app the user was in, or the dock when the click on it took the foreground (as the taskbar
  // keeps it when its flyout closes); never the menu itself.
  const own = Number(handle?.nativeHandle() ?? 0);
  previousForeground = fg && Number(fg) !== own && isWindowVisible(fg) ? fg : null;
}

export function menuOpen() {
  return !!menu.spec;
}

/** The dock node (id) whose press opened the menu that is open, for the light dismiss. */
let menuAnchor: string | null = null;

/**
 * Opens menu `spec.id` from dock button `anchor` (its node id), or closes it when it is open: a
 * second press of that button puts it away, as the taskbar's flyouts do.
 */
export function toggleDockMenu(spec: DockMenuSpec & { id: string }, anchor: string, options: { activate?: boolean } = {}) {
  if (menu.spec?.id === spec.id) return closeDockMenu();
  showDockMenu(spec, options);
  menuAnchor = anchor;
}

export function closeDockMenu() {
  stopHold();
  opening++;
  pending = false;
  reveal = null;
  menuAnchor = null;
  if (!menu.spec) return;
  menu.spec = null;
  shown = false;
  setShown(false);
}
