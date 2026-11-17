import { dlopen } from "../native/ffi";
import { Icon, Image, Pressable, Row, Text, View, Window, darkTheme, store, type AppHandle, type ScreenInfo } from "@tarve/core";
import { config } from "../config";
import { DockWindow } from "../native/dock-window";
import { onShellEvent } from "../native/shell-events";
import {
  closeWindow,
  cursorPos,
  peekWindow,
  placeThumbnail,
  registerThumbnail,
  thumbnailSourceSize,
  unregisterThumbnail,
  visibleFrame,
  windowRect,
  type HWND,
  type Thumbnail,
} from "../native/win32";
import { iconFor } from "../services/icons";
import { desktop, focusWindow, scheduleRefresh } from "../services/windows";
import { ui } from "../theme";
const TITLE = "WindowsBar Preview";
// Fixed geometry: DWM paints each live thumbnail into a rectangle we compute from these.
const BORDER = 1;
const PAD = 8;
const GAP = 8;
const CARD_PAD = 6;
const HEADER = 24;
/** Thumbnails share one height and take their window's shape, as on the taskbar. */
const THUMB_H = 126;
const THUMB_W = 224;
/** Narrow (portrait) windows still leave room for a readable title. */
const THUMB_MIN_W = 150;
const THUMB_MAX_W = 300;
const CARD_H = CARD_PAD + HEADER + CARD_PAD + THUMB_H + CARD_PAD;
/** Too many windows for one row of thumbnails: a list of titles instead, as the taskbar does. */
const ROW_H = 36;
const LIST_W = 320;

const preview = store({
  key: "",
  /** Thumbnail width per card, in logical px. */
  widths: [] as number[],
  list: false,
  /** Windows just closed from the preview: hidden until the next window scan drops them. */
  closed: [] as number[],
});

let handle: AppHandle | undefined;
let hwnd: HWND | null = null;
let thumbs: { source: HWND; thumb: Thumbnail }[] = [];
let showTimer: ReturnType<typeof setTimeout> | undefined;
/** Where the preview opens, in physical screen px: the pointer's x and the monitor under it. */
let anchorX = 0;
/** Opened by a click on the icon: stays until picked or dismissed, not by the pointer leaving. */
let pinned = false;
let scale = 1;
let area = { x: 0, y: 0, width: 1920, height: 1080 };
/** The app icon under the pointer, as reported by the icons' hover events. */
let hoveredKey = "";
let leaveTimer: ReturnType<typeof setTimeout> | undefined;
let peekTimer: ReturnType<typeof setTimeout> | undefined;
let peeking = false;

// The thumbnails and the peek are DWM features Tarve does not wrap, so they stay on FFI; so does
// keeping the preview itself out of the peek (DWMWA_EXCLUDED_FROM_PEEK).
const dwm = dlopen("dwmapi.dll", { DwmSetWindowAttribute: { args: ["ptr", "u32", "ptr", "u32"], returns: "i32" } });

function excludeFromPeek(window: HWND) {
    dwm.symbols.DwmSetWindowAttribute(window, 12 /* DWMWA_EXCLUDED_FROM_PEEK */, new Uint32Array([1]), 4);
}

function startPeek(target: HWND) {
  clearTimeout(peekTimer);
  peekTimer = setTimeout(() => {
    peeking = true;
    // Exclusion keeps a window visible, but only keepOnTop keeps it above the peek target.
    const dock = DockWindow.handle();
    if (dock) excludeFromPeek(dock);
    peekWindow(target, hwnd);
  }, 350);
}

function stopPeek() {
  clearTimeout(peekTimer);
  if (!peeking) return;
  peeking = false;
  peekWindow(null);
}

function windowsOf(key: string) {
  const windows = desktop.apps.find((a) => a.key === key)?.windows ?? [];
  return preview.closed.length ? windows.filter((w) => !preview.closed.includes(Number(w.hwnd))) : windows;
}

/** Closes one window and keeps the preview up for the others, as the taskbar does. */
function closeFromPreview(target: HWND) {
  stopPeek();
  closeWindow(target);
  const id = Number(target);
  preview.closed = [...preview.closed, id];
  // A window that asks first (unsaved changes) is still there afterwards: show it again.
  setTimeout(() => (preview.closed = preview.closed.filter((h) => h !== id)), 2500);
  scheduleRefresh();
  layout();
}

function CloseButton(props: { hwnd: HWND }) {
  return (
    <Pressable
      onClick={() => closeFromPreview(props.hwnd)}
      style={{
        width: 22,
        height: 22,
        radius: 6,
        align: "center",
        justify: "center",
        opacity: 0,
        groupHover: { opacity: 1 },
        hover: { background: "#c42b1c" },
      }}
    >
      <Icon name="x" size={13} color="#fff" strokeWidth={2.2} />
    </Pressable>
  );
}

function pick(target: HWND) {
  stopPeek();
  hidePreview(true);
  focusWindow(target);
}

function Card(props: { hwnd: HWND; title: string; exe: string; width: number }) {
  const icon = iconFor(props.exe, 16);
  return (
    <Pressable
      onHover={(hovered) => (hovered ? startPeek(props.hwnd) : stopPeek())}
      onClick={() => pick(props.hwnd)}
      style={{
        width: props.width + CARD_PAD * 2,
        height: CARD_H,
        padding: CARD_PAD,
        gap: CARD_PAD,
        radius: 8,
        cursor: "pointer",
        group: true,
        hover: { background: "rgba(255,255,255,0.08)" },
      }}
    >
      <Row style={{ height: HEADER, align: "center", gap: 8 }}>
        {icon ? <Image src={icon} width={16} height={16} fit="contain" /> : null}
        <Text size={12} color={ui.text} style={{ flex: 1, whiteSpace: "nowrap", textOverflow: "ellipsis", overflow: "hidden" }}>
          {props.title}
        </Text>
        <CloseButton hwnd={props.hwnd} />
      </Row>
      {/* DWM draws the live window here; nothing painted under it, so no frame shows around it. */}
      <View style={{ width: props.width, height: THUMB_H }} />
    </Pressable>
  );
}

function ListRow(props: { hwnd: HWND; title: string; exe: string }) {
  const icon = iconFor(props.exe, 16);
  return (
    <Pressable
      onHover={(hovered) => (hovered ? startPeek(props.hwnd) : stopPeek())}
      onClick={() => pick(props.hwnd)}
      style={{
        width: LIST_W,
        height: ROW_H,
        padding: { left: 10, right: 7 },
        direction: "row",
        align: "center",
        gap: 10,
        radius: 6,
        cursor: "pointer",
        group: true,
        hover: { background: "rgba(255,255,255,0.08)" },
      }}
    >
      {icon ? <Image src={icon} width={16} height={16} fit="contain" /> : null}
      <Text size={12} color={ui.text} style={{ flex: 1, whiteSpace: "nowrap", textOverflow: "ellipsis", overflow: "hidden" }}>
        {props.title}
      </Text>
      <CloseButton hwnd={props.hwnd} />
    </Pressable>
  );
}

function PreviewView() {
  const app = desktop.apps.find((a) => a.key === preview.key);
  const windows = windowsOf(preview.key);
  return (
    <Window
      title={TITLE}
      width={(BORDER + PAD) * 2 + (THUMB_W + CARD_PAD * 2) * 4 + GAP * 3}
      height={CARD_H + (BORDER + PAD) * 2}
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
      <View
        onPointerMove={checkPointer}
        onPointerLeave={checkPointer}
        onSize={() => layout()}
        style={{
          alignSelf: "start",
          direction: preview.list ? "column" : "row",
          gap: preview.list ? 2 : GAP,
          padding: PAD,
          radius: 12,
          background: "#1c1c1f",
          borderWidth: BORDER,
          borderColor: "rgba(255,255,255,0.09)",
        }}
      >
        {app
          ? windows.map((w, i) =>
              preview.list ? (
                <ListRow key={String(w.hwnd)} hwnd={w.hwnd} title={w.title} exe={app.exe} />
              ) : (
                <Card key={String(w.hwnd)} hwnd={w.hwnd} title={w.title} exe={app.exe} width={preview.widths[i] ?? THUMB_W} />
              ),
            )
          : null}
      </View>
    </Window>
  );
}

function pointerInsidePreview() {
  if (!hwnd || !preview.key) return false;
  const p = cursorPos();
  const r = windowRect(hwnd);
  return p.x >= r.left && p.x < r.right && p.y >= r.top && p.y < r.bottom;
}

function clearThumbs() {
  for (const t of thumbs) unregisterThumbnail(t.thumb);
  thumbs = [];
}

/** The visible size of a window (its invisible resize borders cropped) and the crop itself. */
function sourceOf(source: HWND, thumb: Thumbnail) {
  const crop = visibleFrame(source);
  if (crop) return { crop, width: crop.right - crop.left, height: crop.bottom - crop.top };
  return { crop: null, ...thumbnailSourceSize(thumb) };
}

/** Sizes and places the window above the pointer, then lays the live thumbnails into their cards. */
function layout(reanchor = true) {
  if (!hwnd || !preview.key) return;
  const windows = windowsOf(preview.key);
  if (!windows.length) return hidePreview(true);
  const gap = Math.round(8 * scale);
  const room = area.width / scale - 16;

  const sources = windows.map((w) => w.hwnd);
  if (thumbs.length !== sources.length || thumbs.some((t, i) => t.source !== sources[i])) {
    clearThumbs();
    for (const source of sources) {
      const thumb = registerThumbnail(hwnd, source);
      if (thumb !== null) thumbs.push({ source, thumb });
    }
  }
  const shapes = thumbs.map((t) => sourceOf(t.source, t.thumb));
  const widths = sources.map((source) => {
    const shape = shapes[thumbs.findIndex((t) => t.source === source)];
    const natural = shape && shape.width && shape.height ? (THUMB_H * shape.width) / shape.height : THUMB_W;
    return Math.round(Math.max(THUMB_MIN_W, Math.min(THUMB_MAX_W, natural)));
  });
  const rowWidth = (BORDER + PAD) * 2 + widths.reduce((sum, w) => sum + w + CARD_PAD * 2, 0) + GAP * (widths.length - 1);
  const list = rowWidth > room;
  if (preview.list !== list) preview.list = list;
  if (!list && widths.join() !== preview.widths.join()) preview.widths = widths;

  const width = Math.ceil((list ? (BORDER + PAD) * 2 + LIST_W : rowWidth) * scale);
  const height = Math.ceil(
    (list ? (BORDER + PAD) * 2 + windows.length * ROW_H + 2 * (windows.length - 1) : CARD_H + (BORDER + PAD) * 2) * scale,
  );
  const top = DockWindow.topEdge() ?? area.y + area.height - Math.round(80 * scale);
  // Centred on the app's icon, as the taskbar does, wherever on the icon the pointer was; it
  // follows the icon when the dock re-centres (an app opened or closed).
  // nodeCenterX is a synchronous round trip to the renderer that can block up to 1 s when it is
  // busy (measured 1000 ms): only on open and on resize, not on the periodic refresh.
  if (reanchor) {
    const iconX = DockWindow.nodeCenterX("app:" + preview.key);
    if (iconX !== null) anchorX = iconX;
  }
  const x = Math.max(area.x + gap, Math.min(Math.round(anchorX - width / 2), area.x + area.width - width - gap));
  handle?.setBounds({ x, y: Math.max(area.y + gap, top - gap - height), width, height, physical: true });

  let left = (BORDER + PAD + CARD_PAD) * scale;
  sources.forEach((source, i) => {
    const index = thumbs.findIndex((t) => t.source === source);
    const t = thumbs[index];
    const boxW = widths[i]! * scale;
    if (t) {
      const shape = shapes[index]!;
      const boxH = THUMB_H * scale;
      const fit = shape.width && shape.height ? Math.min(boxW / shape.width, boxH / shape.height, 1) : 1;
      const w = (shape.width || boxW) * fit;
      const h = (shape.height || boxH) * fit;
      const x0 = left + (boxW - w) / 2;
      const y0 = (BORDER + PAD + CARD_PAD + HEADER + CARD_PAD) * scale + (boxH - h) / 2;
      placeThumbnail(t.thumb, { left: x0, top: y0, right: x0 + w, bottom: y0 + h }, !list, shape.crop);
    }
    left += boxW + (CARD_PAD * 2 + GAP) * scale;
  });
}

/**
 * The preview stays while the pointer is on its icon or on the preview itself, and closes a
 * moment after it leaves both: the moment covers the gap between the dock and the preview. On a
 * neighbouring icon it stays too (on the way to the first or last card); hoverApp switches it
 * only if the pointer rests there.
 */
function checkPointer() {
  clearTimeout(leaveTimer);
  // DWM transitions can invalidate hover events without the physical pointer leaving.
  if (!preview.key || pinned || hoveredKey || pointerInsidePreview()) return;
  leaveTimer = setTimeout(() => {
    if (!hoveredKey && !pointerInsidePreview()) hidePreview(true);
  }, 300);
}

function screenAt(screens: ScreenInfo[], p: { x: number; y: number } | null) {
  const hit = p && screens.find((s) => p.x >= s.x && p.x < s.x + s.width && p.y >= s.y && p.y < s.y + s.height);
  return hit || screens.find((s) => s.primary) || screens[0];
}

export async function initWindowPreview(app: AppHandle) {
  handle = app.openWindow(PreviewView, { id: "preview", closeBehavior: "hide", keyboardEvents: true });
  await handle.ready;
  const native = handle.nativeHandle();
  hwnd = native ? (Number(native) as unknown as HWND) : null;
  if (hwnd) excludeFromPeek(hwnd);
  handle.onEvent((event) => {
    if (event.type === "keyboard" && (event as { key?: string }).key === "Escape") hidePreview(true);
  });
  handle.onFocusChange((focused) => {
    // A list opened by a click closes when something else is clicked (it lost focus). Clicking
    // its own icon again is handled by clickApp, which runs after this; let it see the state.
    if (!focused && pinned) setTimeout(() => {
      if (pinned && !(peeking && pointerInsidePreview())) hidePreview(true);
    }, 120);
  });
}

/** Places the preview for `key` above the pointer and shows it, unless `still()` turned false meanwhile. */
async function showFor(key: string, still: () => boolean) {
  if (!handle) return;
  const { screens, cursor } = await handle.screens();
  if (!still()) return;
  const screen = screenAt(screens, cursor);
  if (screen) {
    scale = screen.scale || 1;
    area = { x: screen.x, y: screen.y, width: screen.width, height: screen.height };
  }
  anchorX = cursor?.x ?? area.x + area.width / 2;
  if (preview.key !== key) clearThumbs();
  preview.key = key;
  layout();
  handle.show();
}

/**
 * A click on the icon of an app with several windows, as on the Windows taskbar: the list of its
 * windows opens and stays (whatever the hover setting) until a window is picked, the icon is
 * clicked again, Esc, or a click elsewhere. Returns false when the click should go on as usual.
 */
export function clickApp(key: string): boolean {
  clearTimeout(showTimer);
  if (windowsOf(key).length < 2 || config.multiWindowClick === "recent") {
    hidePreview(true);
    return false;
  }
  if (pinned && preview.key === key) {
    hidePreview(true);
    return true;
  }
  pinned = true;
  void showFor(key, () => pinned).then(() => {
    // Focus lets a click elsewhere (focus loss) or Esc close it, like the taskbar's list.
    if (pinned && preview.key === key) handle?.activate();
  });
  return true;
}

/** The pointer entered (or left) an app icon. */
export function hoverApp(key: string, hovered: boolean) {
  clearTimeout(showTimer);
  if (!hovered) {
    if (hoveredKey === key) hoveredKey = "";
    checkPointer();
    return;
  }
  hoveredKey = key;
  checkPointer();
  if (key === preview.key) return;
  const open = async () => {
    // The pointer may have only crossed this icon on its way up to the open preview.
    if (hoveredKey !== key || !handle || pinned) return;
    if (!config.hoverPreview || !windowsOf(key).length) return hidePreview(true);
    await showFor(key, () => hoveredKey === key && !pinned);
  };
  // With a preview up, another icon takes over only if the pointer rests on it a moment, so
  // reaching for the first or last window across neighbouring icons keeps the preview.
  showTimer = setTimeout(() => void open(), preview.key ? 220 : Math.max(0, Number(config.previewDelay ?? 450)));
}

export function previewOpen() {
  return !!preview.key;
}

export function hidePreview(now = false) {
  clearTimeout(showTimer);
  if (!now) return;
  stopPeek();
  pinned = false;
  if (!preview.key) return;
  preview.key = "";
  clearTimeout(leaveTimer);
  clearThumbs();
  handle?.hide();
}

// Windows open, close, resize or minimize while a preview is up: the shell events keep the cards'
// thumbnails in step (one layout per burst), instead of a timer.
let relayout: ReturnType<typeof setTimeout> | undefined;
onShellEvent((event) => {
  if (!preview.key || event.type === "setting" || event.type === "changed" || event.type === "power") return;
  clearTimeout(relayout);
  relayout = setTimeout(() => preview.key && layout(false), 60);
});
