import { Text, View, Window, darkTheme, store, type AppHandle, type Child, type ScreenInfo } from "@tarve/core";
import { dockUi, widgetDrag } from "../dock/state";
import { DockWindow } from "../native/dock-window";
import { menuOpen } from "./dock-menu";
import { previewOpen } from "./window-preview";

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
  const top = DockWindow.topEdge() ?? area.y + area.height - Math.round(56 * scale);
  const center = DockWindow.nodeCenterX(anchor) ?? cursorX;
  const x = Math.max(area.x + gap, Math.min(Math.round(center - width / 2), area.x + area.width - width - gap));
  handle.setBounds({ x, y: top - gap - height, width, height, physical: true });
}

function blocked() {
  return menuOpen() || previewOpen() || dockUi.editing || !!widgetDrag.source;
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
  cursorX = cursor?.x ?? area.x + area.width / 2;
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
  showTimer = setTimeout(() => void open(id, get), shown ? 0 : DELAY);
}

export async function initHoverTip(app: AppHandle) {
  handle = app.openWindow(TipView, { id: "tip", closeBehavior: "hide" });
  await handle.ready;
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
 * popup); `disabled` (the gallery preview) draws the child as is.
 */
export function HoverTip(props: { id: string; tip: () => string[]; disabled?: boolean; children: Child }) {
  if (props.disabled) return <>{props.children}</>;
  return (
    <View
      id={props.id}
      onPointerMove={() => hoverTip(props.id, props.tip, true)}
      onPointerLeave={() => hoverTip(props.id, props.tip, false)}
      style={{ direction: "row", align: "center", shrink: 0 }}
    >
      {props.children}
    </View>
  );
}
