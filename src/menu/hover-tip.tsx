import { Text, View, Window, darkTheme, store, type AppHandle, type Child, type ScreenInfo } from "@tarve/core";
import { dockUi, widgetDrag } from "../dock/state";
import { DockWindow } from "../native/dock-window";
import { menuOpen } from "./dock-menu";
import { previewOpen } from "./window-preview";
import { dockVertical } from "../services/taskbar-prefs";
import { mouseButtonDown } from "../native/win32";

/**
 * The small info popup the Windows taskbar shows over the clock, network, volume, battery,
 * language and tray icons: a moment after the pointer rests on one, above the dock, centred on
 * it. It follows its source while up (the clock ticks) and goes on leave, click or a menu.
 */

const TITLE = "WindowsBar Tip";
const DELAY = 500;
const GAP = 8;

const tip = store({ lines: [] as string[] });

let handle: AppHandle | undefined;
let anchor = "";
let source: (() => string[]) | null = null;
let shown = false;
let size = { width: 0, height: 0 };
let scale = 1;
let area = { x: 0, y: 0, width: 1920, height: 1080 };
let cursorX = 0;
let showTimer: ReturnType<typeof setTimeout> | undefined;
/** A click puts the tip away until the pointer leaves that node, as on the taskbar. */
let dismissed = "";
/** Physical screen box of a source outside the dock (an icon in the hidden-icons flyout). */
type Rect = { x: number; y: number; width: number; height: number };
let anchorRect: (() => Rect | null) | null = null;
/** What each HoverTip shows, by its id, as of its last render. */
const tipSources = new Map<string, () => string[]>();
/** HoverTip's onPointerLeave: it only makes the node report the pointer, which initHoverTip reads. */
const reportPointer = () => {};

function TipView() {
  return (
    <Window
      title={TITLE}
      width={480}
      height={160}
      frameless
      resizable={false}
      skipTaskbar
      // A tip never takes the foreground from the app in use.
      activation="never"
      level="alwaysOnTop"
      backdrop="transparent"
      visible={false}
      chrome="none"
      theme={darkTheme}
      style={{ background: "rgba(0,0,0,0)" }}
    >
      <View
        onSize={({ borderBox }) => {
          size = { width: borderBox.width, height: borderBox.height };
          if (shown) place();
        }}
        style={{
          alignSelf: "start",
          shrink: 0,
          gap: 3,
          padding: { left: 10, right: 10, top: 7, bottom: 8 },
          radius: 8,
          background: "#2b2b2d",
          borderWidth: 1,
          borderColor: "rgba(255,255,255,0.09)",
        }}
      >
        {tip.lines.map((line, i) => (
          <Text key={i} size={12} color={i === 0 ? "#ffffff" : "#c9c9ce"} style={{ whiteSpace: "nowrap" }}>
            {line}
          </Text>
        ))}
      </View>
    </Window>
  );
}

/** Above the dock, centred on the hovered node, kept on screen. */
function place() {
  if (!handle || !size.width) return;
  const width = Math.ceil(size.width * scale);
  const height = Math.ceil(size.height * scale);
  const gap = Math.round(GAP * scale);
  const rect = anchorRect?.();
  if (rect) {
    // Above the flyout icon, centred on it, kept on its screen (below it when there is no room).
    const x = Math.round(Math.min(Math.max(rect.x + rect.width / 2 - width / 2, area.x), area.x + area.width - width));
    const above = rect.y - gap - height;
    const y = above >= area.y ? above : rect.y + rect.height + gap;
    handle.setBounds({ x, y, width, height, physical: true });
    return;
  }
  const { x, y } = DockWindow.placePopup(width, height, gap, area, DockWindow.nodeCenter(anchor) ?? cursorX);
  handle.setBounds({ x, y, width, height, physical: true });
}

function blocked() {
  // A tip for an icon inside the flyout shows while that flyout (a dock menu) is open.
  // A held button (a press, the start of a drag) puts tips away, as the taskbar's tooltips go on button down.
  return (!anchorRect && menuOpen()) || previewOpen() || dockUi.editing || !!widgetDrag.source || mouseButtonDown();
}

function screenAt(screens: ScreenInfo[], p: { x: number; y: number } | null) {
  const hit = p && screens.find((s) => p.x >= s.x && p.x < s.x + s.width && p.y >= s.y && p.y < s.y + s.height);
  return hit || screens.find((s) => s.primary) || screens[0];
}

function read(get: () => string[]) {
  try {
    return get().filter(Boolean);
  } catch (error) {
    console.error("[hover-tip]", error);
    return [];
  }
}

async function open(id: string, get: () => string[]) {
  if (!handle || blocked() || anchor !== id) return;
  const lines = read(get);
  if (!lines.length) return;
  const { screens, cursor } = await handle.screens();
  if (anchor !== id) return;
  const screen = screenAt(screens, cursor);
  if (screen) {
    scale = screen.scale || 1;
    area = { x: screen.x, y: screen.y, width: screen.width, height: screen.height };
  }
  cursorX = DockWindow.along(cursor, area);
  source = get;
  tip.lines = lines;
  // Let the new text lay out (onSize) before placing, so it never flashes at the old size.
  setTimeout(() => {
    if (anchor !== id || source !== get || blocked()) return;
    shown = true;
    place();
    handle?.show();
    startRefresh();
  }, 30);
}

let leaveTimer: ReturnType<typeof setTimeout> | undefined;

function close() {
  stopRefresh();
  source = null;
  anchorRect = null;
  if (!shown) return;
  shown = false;
  handle?.hide();
}

/** Puts the tip away now (a click, a menu); it stays away until the pointer leaves that node. */
export function hideTip() {
  clearTimeout(showTimer);
  clearTimeout(leaveTimer);
  if (anchor) dismissed = anchor;
  anchor = "";
  close();
}

/** The pointer entered (or left) a node with a tip. Another tip already up switches at once. */
export function hoverTip(id: string, get: () => string[], hovered: boolean) {
  hoverTipAt(id, get, hovered, null);
}

/**
 * hoverTip for something drawn outside the dock window (the hidden-icons flyout): `rect` gives its
 * physical screen box, and the tip goes above it, as Windows shows the tooltips of overflow icons.
 */
export function hoverTipAt(id: string, get: () => string[], hovered: boolean, rect: (() => Rect | null) | null) {
  if (!hovered) {
    if (dismissed === id) dismissed = "";
    if (anchor !== id) return;
    clearTimeout(showTimer);
    anchor = "";
    // A short grace: moving onto the next icon switches the tip instead of closing it.
    leaveTimer = setTimeout(close, 150);
    return;
  }
  if (anchor === id || dismissed === id) return;
  clearTimeout(showTimer);
  clearTimeout(leaveTimer);
  anchor = id;
  anchorRect = rect;
  showTimer = setTimeout(() => void open(id, get), shown ? 0 : DELAY);
}

export async function initHoverTip(app: AppHandle) {
  handle = app.openWindow(TipView, { id: "tip", closeBehavior: "hide" });
  await handle.ready;
  // The tips follow the dock's pointer events here, not with element handlers: Tarve re-renders the
  // whole dock after every handler call (~11 ms under txiki), and pointerMove fires on every mouse
  // move over a clock or a status icon.
  app.onEvent((event) => {
    if (event.type !== "pointerMove" && event.type !== "pointerLeave") return;
    const get = tipSources.get(event.id);
    if (get) hoverTip(event.id, get, event.type === "pointerMove");
  });
}

let refreshTimer: ReturnType<typeof setInterval> | undefined;

/**
 * Keeps the text current while the tip is up (the minute turning, the volume) and puts it away
 * for menus and drags. Runs only while shown; it repaints only when the text changed.
 */
function startRefresh() {
  if (refreshTimer) return;
  refreshTimer = setInterval(() => {
    if (!shown || !source) return stopRefresh();
    if (blocked()) return hideTip();
    const lines = read(source);
    if (!lines.length) return hideTip();
    if (lines.join("\n") !== tip.lines.join("\n")) tip.lines = lines;
  }, 1000);
}

function stopRefresh() {
  clearInterval(refreshTimer);
  refreshTimer = undefined;
}

/**
 * Wraps a part of a widget with its hover tip. `id` must be unique in the dock (it anchors the
 * popup); `disabled` (the gallery preview) draws the child as is. On a side edge a widget's
 * details are its hover peek (menu/widget-peek.tsx), so only the taskbar's own items (`side`:
 * tray and status icons) keep their tips there.
 */
export function HoverTip(props: { id: string; tip: () => string[]; disabled?: boolean; side?: "full"; children: Child }) {
  if (props.disabled || (dockVertical() && props.side !== "full")) return <>{props.children}</>;
  tipSources.set(props.id, props.tip);
  // onPointerLeave only marks the node to report the pointer (reportPointer): its pointerMove and
  // pointerLeave events are read by the dock's event listener (initHoverTip). An onPointerMove
  // handler would re-render the whole dock on every mouse move over it.
  return (
    <View id={props.id} onPointerLeave={reportPointer} style={{ direction: "row", align: "center", shrink: 0 }}>
      {props.children}
    </View>
  );
}
