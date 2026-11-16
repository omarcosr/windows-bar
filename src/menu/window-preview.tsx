import { dlopen } from "bun:ffi";
import { Icon, Image, Pressable, Row, Text, View, Window, darkTheme, store, type AppHandle, type ScreenInfo } from "@tarve/core";
import { config } from "../config";
import { DockWindow } from "../native/dock-window";
import {
  closeWindow,
  peekWindow,
  placeThumbnail,
  registerThumbnail,
  thumbnailSourceSize,
  unregisterThumbnail,
  type HWND,
  type Thumbnail,
} from "../native/win32";
import { iconFor } from "../services/icons";
import { desktop, focusWindow } from "../services/windows";
import { ui } from "../theme";

const TITLE = "WindowsBar Preview";
// Fixed geometry: DWM paints each live thumbnail into a rectangle we compute from these.
const PAD = 8;
const GAP = 8;
const CARD_PAD = 6;
const HEADER = 24;
const THUMB_W = 224;
const THUMB_H = 126;
const CARD_W = THUMB_W + CARD_PAD * 2;
const CARD_H = CARD_PAD + HEADER + CARD_PAD + THUMB_H + CARD_PAD;
const MAX_WINDOWS = 5;

const preview = store({ key: "" });

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
/** The pointer is over the preview's panel, as reported by its own pointer events. */
let overPreview = false;
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
    // The dock is the window kept on top, as the taskbar is; the preview is excluded from peek.
    peekWindow(target, DockWindow.handle());
  }, 350);
}

function stopPeek() {
  clearTimeout(peekTimer);
  if (!peeking) return;
  peeking = false;
  peekWindow(null);
}

function windowsOf(key: string) {
  return desktop.apps.find((a) => a.key === key)?.windows.slice(0, MAX_WINDOWS) ?? [];
}

function Card(props: { hwnd: HWND; title: string; exe: string }) {
  const icon = iconFor(props.exe, 16);
  return (
    <Pressable
      onHover={(hovered) => (hovered ? startPeek(props.hwnd) : stopPeek())}
      onClick={() => {
        stopPeek();
        hidePreview(true);
        focusWindow(props.hwnd);
      }}
      style={{
        width: CARD_W,
        height: CARD_H,
        padding: CARD_PAD,
        gap: CARD_PAD,
        radius: 10,
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
        <Pressable
          onClick={() => {
            closeWindow(props.hwnd);
            hidePreview(true);
          }}
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
      </Row>
      {/* DWM draws the live window here, on top of this placeholder. */}
      <View style={{ width: THUMB_W, height: THUMB_H, radius: 6, background: "rgba(255,255,255,0.04)" }} />
    </Pressable>
  );
}

function PreviewView() {
  const app = desktop.apps.find((a) => a.key === preview.key);
  const windows = windowsOf(preview.key);
  return (
    <Window
      title={TITLE}
      width={PAD * 2 + CARD_W * MAX_WINDOWS + GAP * (MAX_WINDOWS - 1)}
      height={CARD_H + PAD * 2}
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
        onPointerMove={() => {
          if (overPreview) return;
          overPreview = true;
          checkPointer();
        }}
        onPointerLeave={() => {
          overPreview = false;
          checkPointer();
        }}
        onSize={() => layout()}
        style={{ alignSelf: "start", direction: "row", gap: GAP, padding: PAD, radius: 14, background: "#1c1c1f" }}
      >
        {app ? windows.map((w) => <Card key={String(w.hwnd)} hwnd={w.hwnd} title={w.title} exe={app.exe} />) : null}
      </View>
    </Window>
  );
}

function clearThumbs() {
  for (const t of thumbs) unregisterThumbnail(t.thumb);
  thumbs = [];
}

/** Sizes and places the window above the pointer, then lays the live thumbnails into their cards. */
function layout() {
  if (!hwnd || !preview.key) return;
  const windows = windowsOf(preview.key);
  if (!windows.length) return hidePreview(true);
  const width = Math.ceil((PAD * 2 + CARD_W * windows.length + GAP * (windows.length - 1)) * scale);
  const height = Math.ceil((CARD_H + PAD * 2) * scale);
  const top = DockWindow.topEdge() ?? area.y + area.height - Math.round(80 * scale);
  const gap = Math.round(8 * scale);
  // Centred on the app's icon, as the taskbar does, wherever on the icon the pointer was; it
  // follows the icon when the dock re-centres (an app opened or closed).
  const iconX = DockWindow.nodeCenterX("app:" + preview.key);
  if (iconX !== null) anchorX = iconX;
  const x = Math.max(area.x + gap, Math.min(Math.round(anchorX - width / 2), area.x + area.width - width - gap));
  handle?.setBounds({ x, y: top - gap - height, width, height, physical: true });

  const sources = windows.map((w) => w.hwnd);
  if (thumbs.length !== sources.length || thumbs.some((t, i) => t.source !== sources[i])) {
    clearThumbs();
    for (const source of sources) {
      const thumb = registerThumbnail(hwnd, source);
      if (thumb !== null) thumbs.push({ source, thumb });
    }
  }
  thumbs.forEach((t) => {
    const i = sources.indexOf(t.source);
    const size = thumbnailSourceSize(t.thumb);
    const boxW = THUMB_W * scale;
    const boxH = THUMB_H * scale;
    const fit = size.width && size.height ? Math.min(boxW / size.width, boxH / size.height, 1) : 1;
    const w = (size.width || boxW) * fit;
    const h = (size.height || boxH) * fit;
    const left = (PAD + i * (CARD_W + GAP) + CARD_PAD) * scale + (boxW - w) / 2;
    const top = (PAD + CARD_PAD + HEADER + CARD_PAD) * scale + (boxH - h) / 2;
    placeThumbnail(t.thumb, { left, top, right: left + w, bottom: top + h });
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
  if (!preview.key || pinned || overPreview || hoveredKey) return;
  leaveTimer = setTimeout(() => {
    if (!overPreview && !hoveredKey) hidePreview(true);
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
    if (!focused && pinned) setTimeout(() => pinned && hidePreview(true), 120);
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
  if (windowsOf(key).length < 2) {
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
  showTimer = setTimeout(() => void open(), preview.key ? 220 : 450);
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
  overPreview = false;
  clearTimeout(leaveTimer);
  clearThumbs();
  handle?.hide();
}

// Windows open, close and resize while a preview is up: keeps the cards' thumbnails in step.
setInterval(() => {
  if (preview.key) layout();
}, 700);
