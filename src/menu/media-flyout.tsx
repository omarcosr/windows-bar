import { Image, Pressable, Row, Slider, Text, View, Window, darkTheme, store, type AppHandle, type Child, type ScreenInfo } from "@tarve/core";
import { dockUi, widgetDrag } from "../dock/state";
import { DockWindow } from "../native/dock-window";
import { cursorPos, windowRect, type HWND } from "../native/win32";
import { cycleSource, media, mediaControls, mediaPosition, openPlayer, playerIcon, selectSource, sourceName } from "../services/media";
import { changeVolume, status, statusPoller, toggleMute } from "../services/status";
import { ui } from "../theme";
import { glyphs } from "../widgets/ui";
import { hideTip } from "./hover-tip";
import { menuOpen } from "./dock-menu";
import { previewOpen } from "./window-preview";

/**
 * The media flyout over the now-playing tile, like the one Windows 11 shows in quick settings:
 * the player and its sessions, artwork, timeline, transport buttons and the master volume. It opens
 * a moment after the pointer rests on the tile and stays while the pointer is on the tile or on it.
 */

const TITLE = "WindowsBar Media";
const WIDTH = 340;
const ART = 84;
const GAP = 8;
const FONT = "Segoe Fluent Icons, Segoe MDL2 Assets";

const flyout = store({ anchor: "", showVolume: true });

let handle: AppHandle | undefined;
let hwnd: HWND | null = null;
let shown = false;
let size = { width: 0, height: 0 };
let scale = 1;
let area = { x: 0, y: 0, width: 1920, height: 1080 };
let cursorX = 0;
let hovered = "";
let showTimer: ReturnType<typeof setTimeout> | undefined;
let leaveTimer: ReturnType<typeof setTimeout> | undefined;
/** Last bounds sent, so a re-render that changes nothing does not move the window again. */
let lastBounds = "";
let releaseStatus: (() => void) | undefined;

const time = (seconds: number) => {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
};

function Fluent(props: { code: number; size?: number; color?: string }) {
  return (
    <Text size={props.size ?? 14} color={props.color ?? ui.text} style={{ fontFamily: FONT, lineHeight: 1 }}>
      {String.fromCharCode(props.code)}
    </Text>
  );
}

function IconButton(props: { onClick: () => void; size?: number; background?: string; disabled?: boolean; children: Child }) {
  const size = props.size ?? 32;
  return (
    <Pressable
      onClick={props.disabled ? undefined : props.onClick}
      style={{
        width: size,
        height: size,
        radius: size / 2,
        align: "center",
        justify: "center",
        shrink: 0,
        opacity: props.disabled ? 0.35 : 1,
        background: props.background ?? "rgba(255,255,255,0)",
        cursor: props.disabled ? "default" : "pointer",
        hover: props.disabled ? undefined : { background: props.background ? props.background : "rgba(255,255,255,0.08)", transform: "scale(1.05)" },
        active: props.disabled ? undefined : { transform: "scale(0.92)" },
      }}
    >
      {props.children}
    </Pressable>
  );
}

function Artwork() {
  if (media.art) return <Image src={media.art} width={ART} height={ART} fit="cover" style={{ radius: 8, shrink: 0 }} />;
  const icon = playerIcon(media.app, 48);
  return (
    <View style={{ width: ART, height: ART, radius: 8, shrink: 0, background: "rgba(255,255,255,0.06)", align: "center", justify: "center" }}>
      {icon ? <Image src={icon} width={44} height={44} fit="contain" /> : <Fluent code={0xe8d6 /* MusicNote */} size={30} color={ui.muted} />}
    </View>
  );
}

/** The player's icon and name, with the arrows that page through sessions when there are several. */
function Header() {
  const icon = playerIcon(media.app, 16);
  const count = media.sources.length;
  const index = media.sources.findIndex((s) => s.appId === media.app);
  return (
    <Row style={{ align: "center", gap: 8, height: 24 }}>
      <Pressable onClick={() => openPlayer()} style={{ direction: "row", align: "center", gap: 8, flex: 1, minWidth: 0, cursor: "pointer", radius: 4 }}>
        {icon ? <Image src={icon} width={16} height={16} fit="contain" /> : null}
        <Text size={12} color={ui.muted} style={{ flex: 1, whiteSpace: "nowrap", textOverflow: "ellipsis", overflow: "hidden" }}>
          {media.app ? sourceName(media.app) : ""}
        </Text>
      </Pressable>
      {count > 1 ? (
        <Row style={{ align: "center", gap: 2 }}>
          <IconButton size={24} onClick={() => cycleSource(-1)}>
            <Fluent code={0xe76b /* ChevronLeft */} size={10} />
          </IconButton>
          <Text size={11} color={ui.muted}>{`${index + 1}/${count}`}</Text>
          <IconButton size={24} onClick={() => cycleSource(1)}>
            <Fluent code={0xe76c /* ChevronRight */} size={10} />
          </IconButton>
        </Row>
      ) : null}
    </Row>
  );
}

/** Moves with `mediaClock` (services/media.ts), which mediaPosition() reads: once a second while playing. */
function Timeline() {
  if (!media.duration) return null;
  const position = mediaPosition();
  const ratio = Math.min(1, position / media.duration);
  return (
    <View style={{ gap: 4 }}>
      <View style={{ height: 4, radius: 2, background: "rgba(255,255,255,0.14)" }}>
        <View style={{ width: `${Math.round(ratio * 1000) / 10}%`, height: 4, radius: 2, background: ui.blue }} />
      </View>
      <Row style={{ justify: "between" }}>
        <Text size={11} color={ui.muted}>{time(position)}</Text>
        <Text size={11} color={ui.muted}>{time(media.duration)}</Text>
      </Row>
    </View>
  );
}

/** Volume0-3 (E992-E995) or Mute (E74F), the glyphs of the quick settings speaker button. */
function volumeGlyph() {
  if (!status.hasAudio || status.muted) return 0xe74f;
  const v = status.volume;
  return v === 0 ? 0xe992 : v <= 33 ? 0xe993 : v <= 66 ? 0xe994 : 0xe995;
}

function Volume() {
  if (!status.hasAudio) return null;
  return (
    <Row style={{ align: "center", gap: 8 }}>
      <IconButton size={30} onClick={toggleMute}>
        <Fluent code={volumeGlyph()} size={15} />
      </IconButton>
      <View style={{ flex: 1, minWidth: 0 }}>
        {/* The whole row between the speaker and the number: Tarve's Slider is 160 px wide unless told. */}
        <Slider value={status.muted ? 0 : status.volume} min={0} max={100} step={1} onValueChange={changeVolume} style={{ width: "100%" }} />
      </View>
      <Text size={12} color={ui.muted} style={{ width: 26, textAlign: "right" }}>
        {String(status.muted ? 0 : status.volume)}
      </Text>
    </Row>
  );
}

function FlyoutView() {
  const active = media.active && !!media.title;
  // Instead of a 500 ms check: this view renders again when what blocks the flyout changes (a menu,
  // the window preview, edit mode, a drag) and when the dock lays out again (the tile may move).
  if (shown) {
    const block = blocked();
    queueMicrotask(() => {
      if (!shown) return;
      if (block) hideMediaFlyout();
      else place();
    });
  }
  return (
    <Window
      title={TITLE}
      width={WIDTH + 40}
      height={400}
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
        onPointerMove={() => clearTimeout(leaveTimer)}
        onPointerLeave={checkPointer}
        onSize={({ borderBox }) => {
          size = { width: borderBox.width, height: borderBox.height };
          if (shown) place();
        }}
        style={{
          alignSelf: "start",
          shrink: 0,
          width: WIDTH,
          gap: 10,
          padding: 12,
          radius: 10,
          background: "#202022",
          borderWidth: 1,
          borderColor: "rgba(255,255,255,0.09)",
        }}
      >
        <Header />
        <Row style={{ gap: 12, align: "center" }}>
          <Pressable onClick={() => openPlayer()} style={{ cursor: "pointer", radius: 8 }}>
            <Artwork />
          </Pressable>
          <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
            <Text size={14} weight={650} color={ui.text} style={{ whiteSpace: "nowrap", textOverflow: "ellipsis", overflow: "hidden" }}>
              {active ? media.title : "Nada tocando"}
            </Text>
            {media.artist ? (
              <Text size={12} color={ui.muted} style={{ whiteSpace: "nowrap", textOverflow: "ellipsis", overflow: "hidden" }}>
                {media.artist}
              </Text>
            ) : null}
            {media.album && media.album !== media.title ? (
              <Text size={12} color={ui.muted} style={{ whiteSpace: "nowrap", textOverflow: "ellipsis", overflow: "hidden", opacity: 0.8 }}>
                {media.album}
              </Text>
            ) : null}
          </View>
        </Row>
        <Timeline />
        <Row style={{ align: "center", justify: "center", gap: 14 }}>
          <IconButton size={36} disabled={!active} onClick={mediaControls.previous}>
            {glyphs.previous(16)}
          </IconButton>
          <IconButton size={44} background={ui.blue} disabled={!active} onClick={mediaControls.playPause}>
            {media.playing ? glyphs.pause(18) : glyphs.play(18)}
          </IconButton>
          <IconButton size={36} disabled={!active} onClick={mediaControls.next}>
            {glyphs.next(16)}
          </IconButton>
        </Row>
        {flyout.showVolume ? <Volume /> : null}
        {media.sources.length > 1 ? <Sources /> : null}
      </View>
    </Window>
  );
}

/** Every player with a session, to switch which one the tile and the buttons follow. */
function Sources() {
  return (
    <View style={{ gap: 2 }}>
      <View style={{ height: 1, background: "rgba(255,255,255,0.07)", margin: { bottom: 4 } }} />
      {media.sources.map((s, i) => {
        const icon = playerIcon(s.appId, 16);
        const selected = s.appId === media.app;
        return (
          <Pressable
            // One app can hold several sessions (two YouTube Music players): a duplicate key makes the
            // renderer fail and retry on every frame (measured ~45% of a core).
            key={`${s.appId}#${i}`}
            onClick={() => selectSource(s.appId)}
            style={{
              direction: "row",
              align: "center",
              gap: 8,
              height: 30,
              padding: { left: 8, right: 8 },
              radius: 6,
              cursor: "pointer",
              background: selected ? "rgba(255,255,255,0.07)" : "rgba(255,255,255,0)",
              hover: { background: "rgba(255,255,255,0.1)" },
            }}
          >
            {icon ? <Image src={icon} width={16} height={16} fit="contain" /> : <Fluent code={0xe8d6} size={14} color={ui.muted} />}
            <Text size={12} color={ui.text} style={{ flex: 1, whiteSpace: "nowrap", textOverflow: "ellipsis", overflow: "hidden" }}>
              {s.title ? `${s.title}${s.artist ? " · " + s.artist : ""}` : sourceName(s.appId)}
            </Text>
            {s.playing ? <Fluent code={0xe768 /* Play */} size={10} color={ui.blue} /> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

/** Above the dock, centred on the tile, kept on screen. */
function place() {
  if (!handle || !size.width) return;
  const width = Math.ceil(size.width * scale);
  const height = Math.ceil(size.height * scale);
  const gap = Math.round(GAP * scale);
  const top = DockWindow.topEdge() ?? area.y + area.height - Math.round(56 * scale);
  const center = DockWindow.nodeCenterX(flyout.anchor) ?? cursorX;
  const x = Math.max(area.x + gap, Math.min(Math.round(center - width / 2), area.x + area.width - width - gap));
  const y = Math.max(area.y + gap, top - gap - height);
  const key = `${x},${y},${width},${height}`;
  if (key === lastBounds) return;
  lastBounds = key;
  handle.setBounds({ x, y, width, height, physical: true });
}

function blocked() {
  return menuOpen() || previewOpen() || dockUi.editing || !!widgetDrag.source;
}

function pointerInside() {
  if (!hwnd || !shown) return false;
  const p = cursorPos();
  const r = windowRect(hwnd);
  return p.x >= r.left && p.x < r.right && p.y >= r.top && p.y < r.bottom;
}

function screenAt(screens: ScreenInfo[], p: { x: number; y: number } | null) {
  const hit = p && screens.find((s) => p.x >= s.x && p.x < s.x + s.width && p.y >= s.y && p.y < s.y + s.height);
  return hit || screens.find((s) => s.primary) || screens[0];
}

/** Closes a moment after the pointer left both the tile and the flyout (the moment covers the gap). */
function checkPointer() {
  clearTimeout(leaveTimer);
  if (!shown || hovered || pointerInside()) return;
  leaveTimer = setTimeout(() => {
    if (!hovered && !pointerInside()) hideMediaFlyout();
  }, 300);
}

async function open(id: string) {
  if (!handle || blocked() || hovered !== id) return;
  const { screens, cursor } = await handle.screens();
  if (hovered !== id || blocked()) return;
  const screen = screenAt(screens, cursor);
  if (screen) {
    scale = screen.scale || 1;
    area = { x: screen.x, y: screen.y, width: screen.width, height: screen.height };
  }
  cursorX = cursor?.x ?? area.x + area.width / 2;
  flyout.anchor = id;
  releaseStatus ??= statusPoller.acquire();
  hideTip();
  // Let the content lay out (onSize) before placing, so it never flashes at the old size.
  setTimeout(() => {
    if (flyout.anchor !== id || blocked()) return;
    shown = true;
    place();
    handle?.show();
  }, 30);
}

export function hideMediaFlyout() {
  clearTimeout(showTimer);
  clearTimeout(leaveTimer);
  releaseStatus?.();
  releaseStatus = undefined;
  flyout.anchor = "";
  if (!shown) return;
  shown = false;
  lastBounds = "";
  handle?.hide();
}

export function mediaFlyoutOpen() {
  return shown;
}

/** The pointer entered (or left) a now-playing tile. */
function hoverMedia(id: string, on: boolean, delay: number) {
  if (!on) {
    if (hovered === id) hovered = "";
    clearTimeout(showTimer);
    checkPointer();
    return;
  }
  clearTimeout(leaveTimer);
  if (hovered === id) return;
  hovered = id;
  if (shown && flyout.anchor === id) return;
  clearTimeout(showTimer);
  showTimer = setTimeout(() => void open(id), shown ? 0 : delay);
}

export async function initMediaFlyout(app: AppHandle) {
  handle = app.openWindow(FlyoutView, { id: "media", closeBehavior: "hide", keyboardEvents: true });
  await handle.ready;
  const native = handle.nativeHandle();
  hwnd = native ? (Number(native) as unknown as HWND) : null;
  handle.onEvent((event) => {
    if (event.type === "keyboard" && (event as { key?: string }).key === "Escape") hideMediaFlyout();
  });
}

/**
 * Wraps the now-playing tile so resting the pointer on it opens the flyout. `id` must be unique in
 * the dock (it anchors the flyout); `disabled` (the gallery preview, the option off) draws the child as is.
 */
export function MediaHover(props: { id: string; disabled?: boolean; showVolume?: boolean; delay?: number; children: Child }) {
  if (props.disabled) return <>{props.children}</>;
  return (
    <View
      id={props.id}
      onPointerMove={() => {
        if (flyout.showVolume !== (props.showVolume ?? true)) flyout.showVolume = props.showVolume ?? true;
        hoverMedia(props.id, true, props.delay ?? 450);
      }}
      onPointerLeave={() => hoverMedia(props.id, false, 0)}
      style={{ direction: "row", align: "center", shrink: 0 }}
    >
      {props.children}
    </View>
  );
}
