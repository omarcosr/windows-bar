
import { Image, Pressable, Row, Text, View, Window, darkTheme, peekWindow, setWindowPeek, store, windowThumbnail, type AppHandle, type ScreenInfo, type WindowThumbnail } from "@tarve/core";
import { config } from "../config";
import { FluentGlyph } from "./dock-menu";
import { DockWindow } from "../native/dock-window";
import { onShellEvent } from "../native/shell-events";
import {
  activateWindow,
  closeWindow,
  cursorPos,
  foregroundWindow,
  
  visibleFrame,
  windowRect,
  type HWND,
  clientRectInWindow, mouseHoverTime } from "../native/win32";
import { iconFor } from "../services/icons";
import { desktop, focusWindow, scheduleRefresh } from "../services/windows";
import { ui } from "../theme";
import { thumbBars, thumbButtonImage, type ThumbBar, type ThumbButton } from "../services/taskbar-host";
import { clickThumbButton } from "../native/tray-host";

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

/** The thumbnail toolbar's row under the picture, and one button of it. */
const BAR_H = 32;
const BAR_BUTTON_W = 34;
const BAR_BUTTON_H = 28;

function cardHeight() {
  return CARD_H + (preview.bar ? BAR_H : 0);
}

/** The buttons an app shows under its window's thumbnail (THBF_HIDDEN ones left out). */
function visibleButtons(bar: ThumbBar | undefined): ThumbButton[] {
  return bar ? bar.buttons.filter((b) => !(b.flags & 0x8)) : [];
}

/** The pointer is on a window's thumbnail (button null) or on one of its toolbar buttons. */
function showTip(target: HWND, button: number | null, hovered: boolean) {
  const id = Number(target);
  if (hovered) {
    if (preview.tip.hwnd !== id || preview.tip.button !== button) preview.tip = { hwnd: id, button };
  } else if (preview.tip.hwnd === id && preview.tip.button === button) {
    preview.tip = { hwnd: 0, button: null };
  }
}

/** The text the header shows instead of the title: SetThumbnailTooltip's, or the hovered button's tip (kept current by UpdateButtons). */
function tipText(target: HWND): string {
  if (preview.tip.hwnd !== Number(target)) return "";
  const bar = thumbBars[String(target)];
  if (!bar) return "";
  if (preview.tip.button === null) return bar.tooltip;
  return bar.buttons.find((b) => b.id === preview.tip.button)?.tip ?? "";
}

function clickThumb(target: HWND, button: ThumbButton) {
  if (button.flags & 0x11) return; // THBF_DISABLED, THBF_NONINTERACTIVE
  clickThumbButton(Number(target), button.id);
  if (button.flags & 0x2) hidePreview(true); // THBF_DISMISSONCLICK
}

/** ITaskbarList3's thumbnail toolbar: the app's buttons, centred under the picture, as Explorer draws them. */
function ThumbBarRow(props: { hwnd: HWND }) {
  const bar = thumbBars[String(props.hwnd)];
  const buttons = visibleButtons(bar);
  return (
    <Row style={{ height: BAR_H, align: "center", justify: "center", gap: 2 }}>
      {bar
        ? buttons.map((b) => {
            const image = thumbButtonImage(bar, b);
            const inert = !!(b.flags & 0x11);
            // The app's pixels, one to one: the size it drew them at, in logical px.
            const size = image && image.size ? image.size / scale : 16;
            return (
              <Pressable
                key={b.id}
                onHover={(hovered) => showTip(props.hwnd, b.id, hovered)}
                onClick={() => clickThumb(props.hwnd, b)}
                style={{
                  width: BAR_BUTTON_W,
                  height: BAR_BUTTON_H,
                  radius: 4,
                  align: "center",
                  justify: "center",
                  opacity: b.flags & 0x1 ? 0.4 : 1,
                  hover: inert || b.flags & 0x4 ? {} : { background: "rgba(255,255,255,0.12)" },
                }}
              >
                {image ? <Image src={image.src} width={size} height={size} fit="contain" style={{ radius: 0 }} /> : null}
              </Pressable>
            );
          })
        : null}
    </Row>
  );
}

const preview = store({
  key: "",
  /** Thumbnail width per card, in logical px. */
  widths: [] as number[],
  list: false,
  /** Windows just closed from the preview: hidden until the next window scan drops them. */
  closed: [] as number[],
  /** Some window has a thumbnail toolbar (ThumbBarAddButtons): every card gets its row, as on the taskbar. */
  bar: false,
  /** The thumbnail tooltip or toolbar button tip under the pointer, shown in its card's header. */
  tip: { hwnd: 0, button: null as number | null },
});

let handle: AppHandle | undefined;
/** The window in front before a click opened the list: it gets the keyboard back when the list goes. */
let beforeList: HWND | null = null;
let hwnd: HWND | null = null;
let thumbs: { source: HWND; thumb: WindowThumbnail }[] = [];
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
/** The monitors, kept current by the app's screen events: opening a preview asks nothing of the renderer. */
let screens: ScreenInfo[] = [];
/** Last bounds given to the window, so a relayout that changes nothing sends nothing. */
let placed = "";
/** The hovered icon's centre, asked of the dock's renderer as the pointer arrives (during the hover delay). */
let center: { key: string; at: Promise<number | null> } | null = null;

/** Stays visible while a window is peeked from the preview (DWMWA_EXCLUDED_FROM_PEEK). */
function excludeFromPeek(window: HWND) {
  setWindowPeek(window, { excluded: true });
}

/**
 * Shows and hides at once, as the taskbar's thumbnail window does: without this DWM plays its
 * window open/close animation on every show(), which held the preview back after the hover delay.
 */
function disableTransitions(window: HWND) {
  setWindowPeek(window, { transitions: false });
}

function startPeek(target: HWND) {
  clearTimeout(peekTimer);
  peekTimer = setTimeout(() => {
    peeking = true;
    // Exclusion keeps a window visible, but only keepOnTop keeps it above the peek target.
    const dock = DockWindow.handle();
    if (dock) excludeFromPeek(dock);
    try {
      peekWindow(target, hwnd ? { keepVisible: hwnd } : {});
    } catch (error) {
      console.error("[preview] peek", error);
    }
  }, 350);
}

function stopPeek() {
  clearTimeout(peekTimer);
  if (!peeking) return;
  peeking = false;
  try {
    peekWindow(null);
  } catch {}
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
        // Windows 11's thumbnail close button: a small square with the ChromeClose glyph, red on hover.
        width: 24,
        height: 24,
        radius: 4,
        align: "center",
        justify: "center",
        opacity: 0,
        groupHover: { opacity: 1 },
        hover: { background: "#c42b1c" },
      }}
    >
      <FluentGlyph code={0xe8bb} size={10} color="#ffffff" />
    </Pressable>
  );
}

/** The card or row under the pointer: a middle click closes its window, as on the taskbar's thumbnails. */
let hoveredWindow: HWND | null = null;

function hoverWindow(target: HWND, hovered: boolean) {
  if (hovered) {
    hoveredWindow = target;
    startPeek(target);
  } else {
    if (hoveredWindow === target) hoveredWindow = null;
    stopPeek();
  }
}

function pick(target: HWND) {
  stopPeek();
  hidePreview(true);
  focusWindow(target);
}


/** The app icon files are dragged over, and the card they rest on (see dragOverApp). */
let dragKey = "";
let dragCard: HWND | null = null;
let dragCardTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Files dragged over the icon of an app with several windows, once they rested there for the
 * hover time: its thumbnails open without taking the foreground, as on the taskbar, so the files
 * can go on to one of its windows. They close a moment after the files leave the icon and cards.
 */
export function dragOverApp(key: string, hovered: boolean) {
  if (hovered) {
    clearTimeout(leaveTimer);
    dragKey = key;
    void showFor(key, () => dragKey === key || dragCard !== null);
    return;
  }
  if (dragKey === key) dragKey = "";
  dragLeft();
}

function dragLeft() {
  if (!preview.key || pinned) return;
  clearTimeout(leaveTimer);
  leaveTimer = setTimeout(() => {
    if (!dragKey && !dragCard && !hoveredKey) hidePreview(true);
  }, 300);
}

/** Files resting on a card for the hover time bring its window forward, as the taskbar's thumbnails do. */
function dragOverCard(target: HWND, hovered: boolean) {
  clearTimeout(dragCardTimer);
  if (!hovered) {
    if (dragCard === target) dragCard = null;
    dragLeft();
    return;
  }
  dragCard = target;
  clearTimeout(leaveTimer);
  dragCardTimer = setTimeout(() => {
    if (dragCard !== target) return;
    dragCard = null;
    pick(target);
  }, mouseHoverTime());
}

function Card(props: { hwnd: HWND; title: string; exe: string; width: number }) {
  const icon = iconFor(props.exe, 16);
  return (
    <Pressable
      onHover={(hovered) => hoverWindow(props.hwnd, hovered)}
      onClick={() => pick(props.hwnd)}
      onFileDragEnter={() => dragOverCard(props.hwnd, true)}
      onFileDragLeave={() => dragOverCard(props.hwnd, false)}
      style={{
        width: props.width + CARD_PAD * 2,
        height: cardHeight(),
        padding: CARD_PAD,
        gap: CARD_PAD,
        radius: 8,
        cursor: "pointer",
        group: true,
        hover: { background: "rgba(255,255,255,0.08)" },
      }}
    >
      <Row style={{ height: HEADER, align: "center", gap: 8 }}>
        {icon ? <Image src={icon} width={16} height={16} fit="contain" style={{ radius: 0 }} /> : null}
        <Text size={12} color={ui.text} style={{ flex: 1, whiteSpace: "nowrap", textOverflow: "ellipsis", overflow: "hidden" }}>
          {tipText(props.hwnd) || props.title}
        </Text>
        <CloseButton hwnd={props.hwnd} />
      </Row>
      {/* DWM draws the live window here; nothing painted under it, so no frame shows around it. */}
      <View
          onPointerMove={() => showTip(props.hwnd, null, true)}
          onPointerLeave={() => showTip(props.hwnd, null, false)}
          style={{ width: props.width, height: THUMB_H }}
        />
        {preview.bar ? <ThumbBarRow hwnd={props.hwnd} /> : null}
    </Pressable>
  );
}

function ListRow(props: { hwnd: HWND; title: string; exe: string }) {
  const icon = iconFor(props.exe, 16);
  return (
    <Pressable
      onHover={(hovered) => hoverWindow(props.hwnd, hovered)}
      onClick={() => pick(props.hwnd)}
      onFileDragEnter={() => dragOverCard(props.hwnd, true)}
      onFileDragLeave={() => dragOverCard(props.hwnd, false)}
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
      {icon ? <Image src={icon} width={16} height={16} fit="contain" style={{ radius: 0 }} /> : null}
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
      height={cardHeight() + (BORDER + PAD) * 2}
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
  for (const t of thumbs) t.thumb.dispose();
  thumbs = [];
}

/** The visible size of a window (its invisible resize borders cropped) and the crop itself. */
function sourceOf(source: HWND, thumb: WindowThumbnail) {
  // SetThumbnailClip: only that part of the client area, as Explorer shows it.
  const clip = thumbBars[String(source)]?.clip;
  const crop = (clip && clientRectInWindow(source, clip)) || visibleFrame(source);
  if (crop) return { crop, width: crop.right - crop.left, height: crop.bottom - crop.top };
  return { crop: null, ...thumb.sourceSize };
}

/** Sizes and places the window above its icon, then lays the live thumbnails into their cards. */
function layout() {
  if (!hwnd || !preview.key) return;
  const windows = windowsOf(preview.key);
  if (!windows.length) return hidePreview(true);
  const gap = Math.round(8 * scale);
  const room = area.width / scale - 16;

  const sources = windows.map((w) => w.hwnd);
  const bar = sources.some((s) => visibleButtons(thumbBars[String(s)]).length > 0);
  if (preview.bar !== bar) preview.bar = bar;
  if (thumbs.length !== sources.length || thumbs.some((t, i) => t.source !== sources[i])) {
    clearThumbs();
    for (const source of sources) {
      try {
          thumbs.push({ source, thumb: windowThumbnail(hwnd, source) });
        } catch {
          // The window went away between the scan and now: its card shows no picture.
        }
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
    (list ? (BORDER + PAD) * 2 + windows.length * ROW_H + 2 * (windows.length - 1) : cardHeight() + (BORDER + PAD) * 2) * scale,
  );
  // Centred on the app's icon (anchorX, see centerOf), as the taskbar does, wherever on the icon the pointer was.
  const { x, y } = DockWindow.placePopup(width, height, gap, area, anchorX, 80);
  const bounds = `${x},${y},${width},${height}`;
  if (bounds !== placed) {
    placed = bounds;
    handle?.setBounds({ x, y, width, height, physical: true });
  }

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
      const c = shape.crop;
        t.thumb.update({
          rect: { x: Math.round(x0), y: Math.round(y0), width: Math.round(x0 + w) - Math.round(x0), height: Math.round(y0 + h) - Math.round(y0) },
          source: c ? { x: c.left, y: c.top, width: c.right - c.left, height: c.bottom - c.top } : null,
          visible: !list,
        });
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

/**
 * The centre of `key`'s dock icon in physical px. Asked of the dock's renderer without blocking
 * (a synchronous layout read waited up to 1 s while it was busy); hoverApp asks as the pointer
 * arrives, so the answer is usually in by the time the preview opens. A slow answer does not hold
 * the preview: it opens at the pointer and moves over the icon when the answer comes.
 */
function centerOf(key: string, fresh = false): Promise<number | null> {
  if (fresh || center?.key !== key) center = { key, at: DockWindow.nodeCenterAsync("app:" + key).catch(() => null) };
  const at = center.at;
  return Promise.race([at, new Promise<null>((resolve) => setTimeout(() => resolve(null), 80))]).then((x) => {
    if (x === null)
      void at.then((late) => {
        if (late === null || preview.key !== key) return;
        anchorX = late;
        layout();
      });
    return x;
  });
}

function screenAt(screens: ScreenInfo[], p: { x: number; y: number } | null) {
  const hit = p && screens.find((s) => p.x >= s.x && p.x < s.x + s.width && p.y >= s.y && p.y < s.y + s.height);
  return hit || screens.find((s) => s.primary) || screens[0];
}

export async function initWindowPreview(app: AppHandle) {
  handle = app.openWindow(PreviewView, { id: "preview", closeBehavior: "hide", keyboardEvents: true, pointerEvents: true });
  await handle.ready;
  // Screens once here, then from the change events: opening a preview needs no round trip for them.
  handle.onScreensChange((list) => (screens = list));
  screens = (await handle.screens()).screens;
  const native = handle.nativeHandle();
  hwnd = native ? (Number(native) as unknown as HWND) : null;
  if (hwnd) {
    excludeFromPeek(hwnd);
    disableTransitions(hwnd);
  }
  handle.onEvent((event) => {
    if (event.type === "keyboard" && (event as { key?: string }).key === "Escape") hidePreview(true);
    // Middle button released over a card or row: close that window, as the taskbar's thumbnails do.
    const pointer = event as { type: string; phase?: string; button?: number };
    if (pointer.type === "pointer" && pointer.phase === "up" && pointer.button === 1 && hoveredWindow) closeFromPreview(hoveredWindow);
  });
  handle.onFocusChange((focused, change) => {
    // A list opened by a click closes when something else is clicked (it lost focus). A press on
    // its own icon leaves it to clickApp, which closes it when that click arrives.
    if (focused || !pinned || (peeking && pointerInsidePreview())) return;
    if (change.to === "main" && DockWindow.pressedOn("app:" + preview.key, change.pointerTarget)) return;
    // No target reported: the pointer on the app's icon is the same press.
    if (!change.to && DockWindow.pointerOn("app:" + preview.key)) return;
    hidePreview(true);
  });
}

/** Places the preview for `key` above the pointer and shows it, unless `still()` turned false meanwhile. */
async function showFor(key: string, still: () => boolean) {
  if (!handle) return;
  const cursor = cursorPos();
  const iconX = await centerOf(key);
  if (!still() || !handle) return;
  const screen = screenAt(screens, cursor);
  if (screen) {
    scale = screen.scale || 1;
    area = { x: screen.x, y: screen.y, width: screen.width, height: screen.height };
  }
  anchorX = iconX ?? DockWindow.along(cursor, area);
  if (preview.key !== key) clearThumbs();
  preview.key = key;
  // This app's cards render now, before the window moves and shows: no frame of the previous
  // app's cards (or of none) at the new place.
  handle.flush();
  layout();
  // activation="never": shown without taking the foreground, as the taskbar shows its thumbnails.
  handle?.show();
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
    // Focus lets a click elsewhere (focus loss) or Esc close it, like the taskbar's list. The dock
    // never takes the foreground, so this does not take the pointer's hover from it.
    if (!pinned || preview.key !== key) return;
    beforeList = foregroundWindow();
    handle?.activate();
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
  if (config.hoverPreview) void centerOf(key, true);
  const open = async () => {
    // The pointer may have only crossed this icon on its way up to the open preview.
    if (hoveredKey !== key || !handle || pinned) return;
    if (!config.hoverPreview || !windowsOf(key).length) return hidePreview(true);
    await showFor(key, () => hoveredKey === key && !pinned);
  };
  // With a preview up, another icon takes over only if the pointer rests on it a moment, so
  // reaching for the first or last window across neighbouring icons keeps the preview.
  // The user's delay caps the switch too, so a short delay is short everywhere.
  const delay = Math.max(0, Number(config.previewDelay ?? 450));
  showTimer = setTimeout(() => void open(), preview.key ? Math.min(220, delay) : delay);
}

export function previewOpen() {
  return !!preview.key;
}

export function hidePreview(now = false) {
  clearTimeout(showTimer);
  if (!now) return;
  stopPeek();
  // Closed with Esc or a second click on the icon, the list still has the keyboard: give it back.
  if (pinned && hwnd && beforeList && beforeList !== hwnd && foregroundWindow() === hwnd) activateWindow(beforeList);
  beforeList = null;
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
  // The icon may have moved too (the dock re-centres when an app opens or closes).
  relayout = setTimeout(() => {
    const key = preview.key;
    if (!key) return;
    layout();
    void centerOf(key, true).then((x) => {
      if (x === null || preview.key !== key || x === anchorX) return;
      anchorX = x;
      layout();
    });
  }, 60);
});
