import { Image, View, Window, darkTheme, store, type AppHandle } from "@tarve/core";
import { cursorPos, raiseTopmost, type HWND } from "../native/win32";

/**
 * The icon that follows the pointer while a tray icon is dragged between the taskbar and the
 * hidden-icons flyout, as Windows 11 draws the dragged icon under the pointer. The flyout and the
 * dock are separate windows, so the drag image lives in a window of its own: never
 * activated (a focus change would cancel the drag), moved on every drag move.
 */

const TITLE = "WindowsBar Drag";
/** The window's logical side: the icon plus room for its shadow. */
const BOX = 40;

const ghost = store({ image: "", size: 20, n: 0 });

let handle: AppHandle | undefined;
let scale = 1;
let active = false;
/** The screen's scale for this drag is known (screens() answered): only then is the window sized. */
let measured = false;

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
            // Lifted off its slot: it grows into the pointer and goes a little see-through.
            motionFrom={{ opacity: 0, transform: "scale(0.7)" }}
            style={{
              opacity: 0.85,
              transform: "scale(1.15)",
              transition: { opacity: { duration: 120 }, transform: { duration: 220, easing: "spring" } },
            }}
          >
            <Image src={ghost.image} width={ghost.size} height={ghost.size} fit="contain" style={{ radius: 0 }} />
          </View>
        ) : null}
      </View>
    </Window>
  );
}

function place() {
  // Sized with another screen's scale, the window cut the icon and showed it off the pointer for
  // the first frames of a drag.
  if (!handle || !active || !measured) return;
  const side = Math.round(BOX * scale);
  const p = cursorPos();
  // Centred on the pointer, where the icon was picked up, so it does not jump off its slot. The
  // drag keeps the mouse capture in its own window and its targets are found by position, so this
  // window being under the pointer changes nothing.
  handle.setBounds({ x: p.x - Math.round(side / 2), y: p.y - Math.round(side / 2), width: side, height: side, physical: true });
  // Over the flyout too, which the arrow may open (another topmost window) during the drag.
  const native = handle.nativeHandle();
  if (native) raiseTopmost(Number(native) as HWND);
}

/** A drag began: the icon `image` (logical `size` px) appears under the pointer. */
export function startDragGhost(image: string, size: number) {
  if (!handle || !image) return;
  active = true;
  measured = false;
  ghost.image = image;
  ghost.size = size;
  ghost.n++;
  const h = handle;
  void h.screens().then(({ screens, cursor }) => {
    if (!active) return;
    const screen = cursor && screens.find((s) => cursor.x >= s.x && cursor.x < s.x + s.width && cursor.y >= s.y && cursor.y < s.y + s.height);
    scale = (screen || screens.find((s) => s.primary) || screens[0])?.scale || 1;
    measured = true;
    place();
    h.show();
  });
}

/** The pointer moved during the drag. */
export function moveDragGhost() {
  place();
}

/** The drag ended (dropped or cancelled). */
export function endDragGhost() {
  if (!active) return;
  active = false;
  measured = false;
  ghost.image = "";
  handle?.hide();
}

export async function initDragGhost(app: AppHandle) {
  handle = app.openWindow(GhostView, { id: "drag-ghost", closeBehavior: "hide" });
  await handle.ready;
}
