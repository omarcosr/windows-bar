import { Image, View, Window, darkTheme, store, type AppHandle } from "@tarve/core";
import { cursorPos, raiseTopmost, type HWND } from "../native/win32";

/**
 * The icon that follows the pointer while a tray icon is dragged between the taskbar and the
 * hidden-icons flyout, as Windows 11 draws the dragged icon under the pointer. The flyout and the
 * dock are separate windows, so the drag image lives in a window of its own: never activated (a
 * focus change would cancel the drag), moved on every drag move.
 *
 * Nothing may blink on the way: the copy first shows exactly over the icon it lifts (same place,
 * same size, fully opaque) and only then (`dragGhost.ready`) may the original go; on the drop it
 * stays up until the icon is drawn where it landed (endDragGhost after the owner's re-render).
 */

const TITLE = "WindowsBar Drag";
/** The window's logical side: the icon plus room for its lift. */
const BOX = 40;
/** Frames for the copy to be on screen before the original is hidden (two at 60 Hz). */
const SHOWN_MS = 34;

const ghost = store({ image: "", size: 20, n: 0 });
/** The copy is on screen over the icon: the owner may hide the original now. */
export const dragGhost = store({ ready: false });

let handle: AppHandle | undefined;
let scale = 1;
let active = false;
let visible = false;
/** From the pointer to the icon's centre when it was picked up (physical px), kept all along. */
let offset = { x: 0, y: 0 };
let readyTimer: ReturnType<typeof setTimeout> | undefined;
let hideTimer: ReturnType<typeof setTimeout> | undefined;

function GhostView() {
  return (
    <Window
      title={TITLE}
      width={BOX}
      height={BOX}
      frameless
      resizable={false}
      skipTaskbar
      activation="never"
      level="alwaysOnTop"
      backdrop="transparent"
      visible={false}
      chrome="none"
      theme={darkTheme}
      style={{ background: "rgba(0,0,0,0)" }}
    >
      <View style={{ flex: 1, align: "center", justify: "center" }}>
        {ghost.image ? (
          <View
            key={ghost.n}
            // Starts as the icon itself, then (once the original is hidden) lifts a little under the pointer.
            motionFrom={{ transform: "scale(1)" }}
            style={{ transform: "scale(1.12)", transition: { transform: { duration: 200, delay: SHOWN_MS + 10, easing: "easeOut" } } }}
          >
            <Image src={ghost.image} width={ghost.size} height={ghost.size} fit="contain" style={{ radius: 0 }} />
          </View>
        ) : null}
      </View>
    </Window>
  );
}

function place() {
  if (!handle) return;
  const side = Math.round(BOX * scale);
  const p = cursorPos();
  // Where the icon was picked up, relative to the pointer, so it never jumps off its slot. The drag
  // keeps the mouse capture in its own window and its targets are found by position, so this
  // window being under the pointer changes nothing.
  const cx = p.x + offset.x;
  const cy = p.y + offset.y;
  handle.setBounds({ x: Math.round(cx - side / 2), y: Math.round(cy - side / 2), width: side, height: side, physical: true });
  raise();
}

/** The z-order is set when shown and when a topmost window opened over it, not on every move. */
let needsRaise = false;
function raise() {
  if (!needsRaise || !handle) return;
  needsRaise = false;
  const native = handle.nativeHandle();
  if (native) raiseTopmost(Number(native) as HWND);
}

/** Another topmost window (the flyout the arrow opens under a drag) came up: keep the copy above it. */
export function raiseDragGhost() {
  if (!visible) return;
  needsRaise = true;
  raise();
}

/**
 * A drag began: the icon `image` (logical `size` px), now at `rect` on screen (physical px; its
 * centre is where the copy appears), is lifted under the pointer.
 */
export function startDragGhost(image: string, size: number, rect: { x: number; y: number; width: number; height: number } | null) {
  if (!handle || !image) return;
  clearTimeout(hideTimer);
  clearTimeout(readyTimer);
  active = true;
  dragGhost.ready = false;
  const p = cursorPos();
  offset = rect ? { x: rect.x + rect.width / 2 - p.x, y: rect.y + rect.height / 2 - p.y } : { x: 0, y: 0 };
  ghost.image = image;
  ghost.size = size;
  ghost.n++;
  needsRaise = true;
  // The scale is known from the last answer (screens() at start-up and on every drag), so the
  // window is sized right at once; a screen of another scale corrects it a moment later.
  place();
  handle.show();
  visible = true;
  readyTimer = setTimeout(() => {
    if (active) dragGhost.ready = true;
  }, SHOWN_MS);
  void measure();
}

/** The pointer moved during the drag. */
export function moveDragGhost() {
  if (active) place();
}

/**
 * The drag ended. The copy stays where it was released for `after` ms (or until the next call with
 * 0): long enough for the icon to be drawn where it landed, so the two never both miss a frame.
 */
export function endDragGhost(after = SHOWN_MS) {
  if (!visible) return;
  active = false;
  clearTimeout(readyTimer);
  clearTimeout(hideTimer);
  const hide = () => {
    visible = false;
    dragGhost.ready = false;
    ghost.image = "";
    handle?.hide();
  };
  if (after > 0) hideTimer = setTimeout(hide, after);
  else hide();
}

async function measure() {
  if (!handle) return;
  const { screens, cursor } = await handle.screens();
  const screen = cursor && screens.find((s) => cursor.x >= s.x && cursor.x < s.x + s.width && cursor.y >= s.y && cursor.y < s.y + s.height);
  const next = (screen || screens.find((s) => s.primary) || screens[0])?.scale || 1;
  if (next === scale) return;
  scale = next;
  if (active) place();
}

export async function initDragGhost(app: AppHandle) {
  handle = app.openWindow(GhostView, { id: "drag-ghost", closeBehavior: "hide" });
  await handle.ready;
  await measure();
}
