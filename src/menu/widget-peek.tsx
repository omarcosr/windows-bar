import { View, Window, darkTheme, store, type AppHandle, type ScreenInfo } from "@tarve/core";
import { config } from "../config";
import { WIDGET_DRAG, dockUi, widgetDrag } from "../dock/state";
import { DockWindow } from "../native/dock-window";
import { mountWidget } from "../widgets/host";
import { setFullForm } from "../widgets/form";
import { onShellEvent, watchPointerLeave } from "../native/shell-events";
import { dockVertical, onTaskbarPrefsChange } from "../services/taskbar-prefs";
import { menuOpen } from "./dock-menu";
import { previewOpen } from "./window-preview";

/**
 * On a side edge the dock draws its widgets minimal (their icon, ring or number); resting the
 * pointer on one shows the whole widget beside the dock, live and clickable, the way the taskbar
 * shows a button's details on hover. It stays while the pointer is on the widget or on the peek.
 */

const TITLE = "WindowsBar Peek";
const DELAY = 300;
const GAP = 8;

const peek = store({ id: "" });

let handle: AppHandle | undefined;
let shown = false;
let overPeek = false;
let hovered = "";
let size = { width: 0, height: 0 };
let scale = 1;
let area = { x: 0, y: 0, width: 1920, height: 1080 };
let showTimer: ReturnType<typeof setTimeout> | undefined;
let leaveTimer: ReturnType<typeof setTimeout> | undefined;

function PeekView() {
  // This window draws the widget in full (see widgets/form.ts).
  setFullForm(true);
  const instance = config.widgets.find((w) => w.id === peek.id);
  const widget = instance ? mountWidget(instance) : undefined;
  const WidgetView = widget?.definition.View;
  return (
    <Window
      title={TITLE}
      width={480}
      height={200}
      frameless
      resizable={false}
      skipTaskbar
      // Clickable, but it never takes the foreground from the app in use, like the dock.
      activation="never"
      level="alwaysOnTop"
      backdrop="transparent"
      visible={false}
      chrome="none"
      theme={darkTheme}
      style={{ background: "rgba(0,0,0,0)" }}
    >
      <View
        onPointerMove={() => {
          overPeek = true;
          clearTimeout(leaveTimer);
          watchLeave(peekHwnd());
        }}
        onPointerLeave={() => {
          overPeek = false;
          scheduleLeave();
        }}
        onSize={({ borderBox }) => {
          size = { width: borderBox.width, height: borderBox.height };
          if (shown) place();
        }}
        style={{
          alignSelf: "start",
          shrink: 0,
          padding: 6,
          radius: 14,
          background: "#0c0c0e",
          borderWidth: 1,
          borderColor: "rgba(255,255,255,0.09)",
        }}
      >
        {widget && WidgetView ? <WidgetView state={widget.state} ctx={widget.ctx} preview={false} /> : null}
      </View>
    </Window>
  );
}

/** Beside the dock, centred on the widget, kept on screen. */
function place() {
  if (!handle || !size.width || !peek.id) return;
  const width = Math.ceil(size.width * scale);
  const height = Math.ceil(size.height * scale);
  const { x, y } = DockWindow.placePopup(width, height, Math.round(GAP * scale), area, DockWindow.nodeCenter(WIDGET_DRAG + peek.id));
  handle.setBounds({ x, y, width, height, physical: true });
}

function blocked() {
  return menuOpen() || previewOpen() || dockUi.editing || !!widgetDrag.source;
}

function screenAt(screens: ScreenInfo[], p: { x: number; y: number } | null) {
  const hit = p && screens.find((s) => p.x >= s.x && p.x < s.x + s.width && p.y >= s.y && p.y < s.y + s.height);
  return hit || screens.find((s) => s.primary) || screens[0];
}

async function open(id: string) {
  if (!handle || blocked() || hovered !== id) return;
  const { screens, cursor } = await handle.screens();
  if (hovered !== id) return;
  const screen = screenAt(screens, cursor);
  if (screen) {
    scale = screen.scale || 1;
    area = { x: screen.workArea.x, y: screen.workArea.y, width: screen.workArea.width, height: screen.workArea.height };
  }
  const switching = peek.id !== id;
  peek.id = id;
  // A new widget lays out (onSize) before the window moves, so it never shows at the old size.
  setTimeout(() => {
    if (hovered !== id || peek.id !== id || blocked()) return;
    shown = true;
    place();
    handle?.show();
  }, switching ? 40 : 0);
}

function scheduleLeave() {
  clearTimeout(leaveTimer);
  // The moment covers the gap between the dock and the peek.
  leaveTimer = setTimeout(() => {
    if (!hovered && !overPeek) hidePeek();
  }, 250);
}

/**
 * A pointer that leaves fast (off the screen edge, onto another window) may not deliver the
 * hover-out, which left the peek on screen. While it is up, the shell-events worker reports the
 * pointer moving off the dock or the peek (watchPointerLeave, hooked only meanwhile).
 */
const watching = new Map<number, () => void>();

function watchLeave(owner: number | null) {
  if (!owner || watching.has(owner)) return;
  watching.set(owner, watchPointerLeave(owner));
}

function stopWatching() {
  for (const stop of watching.values()) stop();
  watching.clear();
}

function peekHwnd() {
  const native = handle?.nativeHandle();
  return native ? Number(native) : null;
}

onShellEvent((event) => {
  if (event.type !== "pointerLeft" || !watching.has(event.owner)) return;
  watching.delete(event.owner);
  if (event.owner === peekHwnd()) overPeek = false;
  else hovered = "";
  scheduleLeave();
});

/** Puts the peek away now (a click on a widget, a menu, the dock leaving the side edge). */
export function hidePeek() {
  clearTimeout(showTimer);
  clearTimeout(leaveTimer);
  stopWatching();
  hovered = "";
  overPeek = false;
  if (!shown) return;
  shown = false;
  handle?.hide();
}

export function peekOpen() {
  return shown;
}

/** The pointer entered (or left) the dock widget `id`; another peek already up switches at once. */
export function peekWidget(id: string, over: boolean) {
  if (!over) {
    if (hovered !== id) return;
    hovered = "";
    clearTimeout(showTimer);
    scheduleLeave();
    return;
  }
  watchLeave(Number(DockWindow.handle() ?? 0));
  if (hovered === id) return;
  hovered = id;
  clearTimeout(showTimer);
  clearTimeout(leaveTimer);
  showTimer = setTimeout(() => void open(id), shown ? 0 : DELAY);
}

export async function initWidgetPeek(app: AppHandle) {
  handle = app.openWindow(PeekView, { id: "peek", closeBehavior: "hide" });
  await handle.ready;
  // The peek belongs to a side-edge dock: the bar moving to the top or bottom puts it away.
  onTaskbarPrefsChange(() => {
    if (!dockVertical()) hidePeek();
  });
}
