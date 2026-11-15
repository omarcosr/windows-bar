import { Column, Icon, Image, Pressable, Row, Text, View, Window, darkTheme, store, type AppHandle } from "@tarve/core";
import { config } from "../config";
import { DockWindow } from "../native/dock-window";
import {
  closeWindow,
  cursorPos,
  dpiOf,
  findWindow,
  monitorOf,
  moveWindow,
  peekWindow,
  placeThumbnail,
  windowRect,
  registerThumbnail,
  stripWindowChrome,
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
let anchorX = 0;
/** The app icon under the pointer, as reported by the icons' hover events. */
let hoveredKey = "";
let outsideSince = 0;
let peekTimer: ReturnType<typeof setTimeout> | undefined;
let peeking = false;

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
  const icon = iconFor(props.exe);
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
      position={{ x: -4000, y: -4000 }}
      theme={darkTheme}
      style={{ background: "rgba(0,0,0,0)" }}
    >
      <View style={{ alignSelf: "start", direction: "row", gap: GAP, padding: PAD, radius: 14, background: "#1c1c1f" }}>
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
  const scale = dpiOf(hwnd) / 96;
  const width = Math.ceil((PAD * 2 + CARD_W * windows.length + GAP * (windows.length - 1)) * scale);
  const height = Math.ceil((CARD_H + PAD * 2) * scale);
  const { monitor } = monitorOf(hwnd);
  const top = DockWindow.topEdge() ?? monitor.bottom - 80;
  const gap = Math.round(8 * scale);
  const x = Math.max(monitor.left + gap, Math.min(anchorX - width / 2, monitor.right - width - gap));
  moveWindow(hwnd, x, top - gap - height, width, height);

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
 * The preview stays while the pointer is on its icon or on the preview itself (with the gap
 * between them), and closes a moment after it leaves both. Polling the pointer works the same
 * whichever of the two windows it is over, unlike hover events.
 */
function watchPointer() {
  if (!preview.key || !hwnd) return;
  const p = cursorPos();
  const r = windowRect(hwnd);
  const bridge = DockWindow.topEdge() ?? r.bottom;
  const overPreview = p.x >= r.left && p.x < r.right && p.y >= r.top && p.y < Math.max(r.bottom, bridge + 2);
  if (overPreview || hoveredKey === preview.key) {
    outsideSince = 0;
    return;
  }
  if (hoveredKey && hoveredKey !== preview.key) return; // another icon: hoverApp switches it
  outsideSince ||= Date.now();
  if (Date.now() - outsideSince > 250) hidePreview(true);
}

export async function initWindowPreview(app: AppHandle) {
  handle = app.openWindow(PreviewView, { id: "preview", closeBehavior: "hide" });
  await handle.ready;
  for (let i = 0; i < 50 && !hwnd; i++) {
    hwnd = findWindow(TITLE);
    if (!hwnd) await Bun.sleep(40);
  }
  if (hwnd) stripWindowChrome(hwnd);
  handle.hide();
}

/** The pointer entered (or left) an app icon. */
export function hoverApp(key: string, hovered: boolean) {
  clearTimeout(showTimer);
  if (!hovered) {
    if (hoveredKey === key) hoveredKey = "";
    return;
  }
  hoveredKey = key;
  if (key === preview.key) return;
  const open = () => {
    // The pointer may have only crossed this icon on its way up to the open preview.
    if (hoveredKey !== key) return;
    if (!config.hoverPreview || !windowsOf(key).length) return hidePreview(true);
    anchorX = cursorPos().x;
    preview.key = key;
    layout();
    handle?.show();
  };
  // With a preview up, another icon takes over only if the pointer rests on it a moment, so
  // reaching for the first or last window across neighbouring icons keeps the preview.
  showTimer = setTimeout(open, preview.key ? 220 : 450);
}

export function hidePreview(now = false) {
  clearTimeout(showTimer);
  if (!now) return;
  stopPeek();
  if (!preview.key) return;
  preview.key = "";
  outsideSince = 0;
  clearThumbs();
  handle?.hide();
}

// Windows open and close while a preview is up.
setInterval(() => {
  if (preview.key) layout();
}, 700);
setInterval(watchPointer, 80);
