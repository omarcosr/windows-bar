import { Image, Pressable, View, store, type Child, type Style } from "@tarve/core";
import {
  activateDockMenu,
  FluentGlyph,
  gridCellRect,
  holdDockMenu,
  menuOpen,
  pointOnDockMenu,
  toggleDockMenu,
  updateDockMenu,
  type DockMenuItem,
  type DockMenuSpec,
} from "../../menu/dock-menu";
import { dragGhost, endDragGhost, moveDragGhost, startDragGhost } from "../../menu/drag-ghost";
import { cursorPos } from "../../native/win32";
import { windowPidOf } from "../../native/tray-host";
import { DockWindow } from "../../native/dock-window";
import {
  acquireTaskbarHost,
  clickTrayIcon,
  endTrayPopup,
  hoverTrayIcon,
  ownsPopup,
  setTrayIconPromoted,
  tray,
  type TrayIcon,
} from "../../services/taskbar-host";
import { launch, prettyName } from "../../services/windows";
import { config } from "../../config";
import { dockEdge, dockVertical } from "../../services/taskbar-prefs";
import { ui } from "../../theme";
import { HitReach, Tile } from "../ui";
import { HoverTip, hideTip, hoverTipAt } from "../../menu/hover-tip";
import { defineWidget } from "../types";

import { t } from "../../i18n";
type InlineMode = "promoted" | "all" | "none";

/** Tray icons follow the icon size setting (18 px at 100%). */
const trayIcon = () => Math.round((18 * Math.max(0.7, Math.min(1.3, Number(config.iconScale ?? 100) / 100))) / 2) * 2;

/**
 * Moving icons between the taskbar and the hidden-icons flyout by dragging, as on Windows 11: the
 * drop writes IsPromoted in the icon's NotifyIconSettings subkey (setTrayIconPromoted) and the
 * key's change notification moves it; nothing is kept here but the drag in progress.
 */
const trayDrag = store({
  /** The icon being dragged. */
  key: "",
  over: false,
  /** Where the gap is open in the row (among the icons without the dragged one); -1 none. */
  slot: -1,
  /** Dropped on the row from the flyout: the gap and the copy stay until the registry shows it there. */
  arriving: "",
  /** Dropped behind the arrow: it stays folded away, its gap closing, until the registry hides it. */
  leaving: "",
});

/** The registry answers a drop within this; past it the drop is taken as refused and undone. */
const SETTLE_MS = 1500;
let settleTimer: ReturnType<typeof setTimeout> | undefined;

/** The drop has landed: gap closed, copy gone, every icon drawn as it is. */
function settle() {
  clearTimeout(settleTimer);
  trayDrag.arriving = "";
  trayDrag.leaving = "";
  endPlacement();
  endDragGhost();
}

/** The icon left the row: done once its gap has finished closing (GAP_MOTION), so the row only ever shrinks smoothly. */
let leftAt = 0;
function settleLeft() {
  if (!trayDrag.leaving) return;
  clearTimeout(settleTimer);
  settleTimer = setTimeout(settle, Math.max(0, leftAt + 180 - performance.now()));
}

function settleLater() {
  leftAt = performance.now();
  clearTimeout(settleTimer);
  settleTimer = setTimeout(settle, SETTLE_MS);
}

/**
 * Where icons sit in the tray's row. Windows 11 lets its icons be dragged into any order there, but
 * keeps that order inside Explorer: NotifyIconSettings has no order value and no other key holds
 * it. So, as with the app buttons' order, the dock keeps it, in the widget's `order`, by an id that
 * survives the app restarting: the icon's GUID, else its executable and uID (what Windows itself
 * identifies the icon by in NotifyIconSettings).
 */
const orderId = (icon: TrayIcon) => (icon.guid ? icon.guid.toLowerCase() : `${icon.exe.toLowerCase()}|${icon.uid}`);

function applyOrder(icons: TrayIcon[], order: readonly string[] | undefined): TrayIcon[] {
  if (!order?.length) return icons;
  const rank = new Map(order.map((k, i) => [k, i]));
  const known = icons.filter((i) => rank.has(orderId(i))).sort((a, b) => rank.get(orderId(a))! - rank.get(orderId(b))!);
  let next = 0;
  return icons.map((i) => (rank.has(orderId(i)) ? known[next++]! : i));
}

/** What a drag needs of the tray it may land in: its icons in order and how to place one there. */
interface Placer {
  row: string;
  arrow: string;
  /** The row's icons as shown. */
  inline: () => TrayIcon[];
  buttonId: (icon: TrayIcon) => string;
  /** Saves `icon` at `slot` (0..n among inline() without it). */
  commit: (icon: TrayIcon, slot: number) => void;
}
/** Each tray's placer, by its arrow's node id (the flyout's drag finds its tray by that). */
const placers = new Map<string, Placer>();

/** Centres of the row's buttons along the dock when the drag reached the row (layout before the gap opens). */
let centers: { key: string; at: number }[] | null = null;

/** The slot under the pointer in `placer`'s row (-1 off the row), for the dragged icon (key). */
function slotAt(placer: Placer, dragged: string): number {
  if (!DockWindow.pointerOn(placer.row)) return -1;
  if (!centers) {
    centers = placer
      .inline()
      .filter((i) => i.key !== dragged)
      .map((i) => ({ key: i.key, at: DockWindow.nodeCenter(placer.buttonId(i)) ?? 0 }));
  }
  const at = DockWindow.along(cursorPos(), { x: 0, y: 0, width: 0, height: 0 });
  return centers.filter((c) => c.at < at).length;
}

function endPlacement() {
  centers = null;
  trayDrag.slot = -1;
}

/** The room an icon will land in opens under the pointer, as the taskbar's icons make room. */
const GAP_MOTION = { width: { duration: 160, easing: "easeOut" as const } };

function Gap(props: { closing?: boolean }) {
  return (
    <View motionFrom={{ width: 0 }} style={{ width: props.closing ? 0 : 30, height: 36, shrink: 0, transition: GAP_MOTION }} />
  );
}

/** The flyout was opened by an icon dragged over the arrow: it gets the focus after the drop. */
let openedByDrag = false;
let dragOpenTimer: ReturnType<typeof setTimeout> | undefined;

/** The tooltip lines Windows shows for an icon: its tip text, one line per line. */
const tipLines = (icon: TrayIcon) => icon.tip.split("\n").map((l) => l.trim());


function TrayButton(props: { icon: TrayIcon; preview?: boolean; movable?: boolean; placer?: Placer }) {
  const { icon } = props;
  // A version-4 icon without NIF_SHOWTIP draws its own popup (NIN_POPUPOPEN): no standard tooltip.
  const popup = ownsPopup(icon);
  const onHover = (hovered: boolean) => hoverTrayIcon(icon, hovered && !trayDrag.key);
  const drag = props.movable
    ? {
        draggable: true,
        onDragStart: () => {
          hideTip();
          endTrayPopup();
          settle();
          trayDrag.key = icon.key;
          // Its gap starts where it is: once the copy is up, the icon folds as the gap opens.
          if (props.placer) trayDrag.slot = props.placer.inline().findIndex((i) => i.key === icon.key);
          // The copy shows exactly over the icon; the icon goes only once it is up (dragGhost.ready).
          startDragGhost(icon.image, trayIcon(), props.placer ? DockWindow.nodeScreenRect(props.placer.buttonId(icon)) : null);
        },
        onDragMove: () => {
          moveDragGhost();
          if (!props.placer || !dragGhost.ready) return;
          // Off the row the gap stays where the icon was: the row keeps its length all along the
          // drag, so the dock never shrinks and grows back under it.
          let slot = slotAt(props.placer, icon.key);
          if (slot < 0) slot = props.placer.inline().findIndex((i) => i.key === icon.key);
          if (slot !== trayDrag.slot) trayDrag.slot = slot;
        },
        onDragEnd: (event: { cancelled: boolean }) => {
          clearTimeout(dragOpenTimer);
          const key = trayDrag.key;
          const slot = trayDrag.slot;
          // Released on the arrow, or over the flyout it opened (a window of its own: no drop
          // event reaches the dock from there): the icon goes behind the arrow, staying folded
          // away until the registry change takes it out. Released in the row: it takes the place
          // shown, in the same render that closes the gap. Anywhere else: back where it was.
          const hide = (props.placer && DockWindow.pointerOn(props.placer.arrow)) || pointOnDockMenu(OVERFLOW_MENU, cursorPos());
          // Every state change of the drop is made before the drag's own is cleared: a render in
          // between drew the icon back at full width for a frame (the dock grew, then shrank).
          if (key && !event.cancelled && hide) {
            trayDrag.leaving = key;
            trayDrag.key = "";
            trayDrag.over = false;
            settleLater();
            endDragGhost();
            setTrayIconPromoted(icon, false);
          } else {
            if (key && !event.cancelled && slot >= 0 && props.placer && DockWindow.pointerOn(props.placer.row)) props.placer.commit(icon, slot);
            trayDrag.key = "";
            trayDrag.over = false;
            endPlacement();
            endDragGhost();
          }
          if (openedByDrag) {
            openedByDrag = false;
            activateDockMenu(OVERFLOW_MENU);
          }
        },
      }
    : undefined;
  const onClick = () => {
    hideTip();
    clickTrayIcon(icon, "left");
  };
  const onContextMenu = () => {
    hideTip();
    clickTrayIcon(icon, "right");
  };
  const leaving = trayDrag.leaving === icon.key;
  // Lifted once its copy is up over it: folded away while the gap shows where it goes.
  const lifted = leaving || (trayDrag.key === icon.key && dragGhost.ready && trayDrag.slot >= 0);
  // As the taskbar's notification icons: hovered, a light plate behind the icon, with no zoom or lift
  // (the app icons' hover effect); the same as the overflow arrow beside them.
  const hover: Style = { transition: { background: { duration: 120, easing: "easeOut" } }, hover: { background: "rgba(255,255,255,0.07)" } };
  // The app's own tip text, shown by the taskbar on hover.
  return (
    <HoverTip id={`tip:tray:${icon.key}`} tip={() => tipLines(icon)} disabled={props.preview || popup} side="full">
    <Pressable
      id={props.placer?.buttonId(icon)}
      focusable={false}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onHover={props.preview ? undefined : onHover}
      {...drag}
      style={{
        position: "relative",
        // Stacked in a side-edge column: as wide as before, shorter along the column.
        // Lifted out while dragged: the gap under the pointer shows where it goes. It folds as the
        // gap opens (same duration and easing), so the row's length never changes; back at full
        // width at once on the drop, when the gap goes.
        width: lifted ? 0 : 30,

        height: dockVertical() && !props.preview ? 28 : 36,
        radius: 7,
        align: "center",
        justify: "center",
        cursor: "pointer",
        shrink: 0,
        overflow: "hidden",
        // Folded away it draws nothing: at zero width its hover and press backgrounds still left a
        // 1 px line where it was.
        opacity: lifted ? 0 : 1,
        ...hover,
        // After the hover effect's own transitions, which would otherwise replace these.
        transition: { ...hover.transition, ...(lifted ? GAP_MOTION : {}) },
      }}
    >
      <HitReach
        height={dockVertical() && !props.preview ? 30 : 36}
        onClick={onClick}
        onContextMenu={onContextMenu}
        onHover={props.preview ? undefined : onHover}
        drag={drag}
      />
      <Image src={icon.image} width={trayIcon()} height={trayIcon()} fit="contain" style={{ radius: 0 }} />
    </Pressable>
    </HoverTip>
  );
}

const label = (icon: TrayIcon) => icon.tip.split("\n")[0]!.trim() || (icon.exe ? prettyName(icon.exe) : t("widgets.tray.icon"));

const OVERFLOW_MENU = "tray-overflow";

/** The overflow arrow's Fluent glyph per dock edge: ChevronUp, ChevronDown, ChevronRight, ChevronLeft. */
const ARROWS = { bottom: 0xe70e, top: 0xe70d, left: 0xe76c, right: 0xe76b } as const;

/** The icons the open flyout shows; it is refreshed only when this changes (no render loop). */
let shownOverflow = "";
const overflowKey = (icons: TrayIcon[], zones: string[]) =>
  icons.map((i) => `${i.key}\u0001${i.tip}\u0001${i.showTip}\u0001${i.version}`).join("\u0002") + "\u0003" + zones.join("\u0001");

/**
 * The dock nodes of this tray (the arrow and the icon row) where an icon dragged out of the flyout
 * lands on the taskbar; [] when icons cannot be moved (the widget's "Todos" / "Nenhum" modes).
 */
function openOverflow(icons: TrayIcon[], anchor: string, zones: string[]) {
  shownOverflow = overflowKey(icons, zones);
  // A second press of the arrow puts the flyout away, as on the taskbar.
  toggleDockMenu(overflowSpec(icons, zones), anchor);
}

function overflowSpec(icons: TrayIcon[], zones: string[]): DockMenuSpec & { id: string } {
  // The same flyout as Windows: an icon grid that stays open while you click, so an app that
  // opens on a double click gets both clicks.
  const items: DockMenuItem[] = icons.map((icon, index) => ({
    label: label(icon),
    icon: { image: icon.image },
    onSelect: () => {
      hideTip();
      clickTrayIcon(icon, "left");
    },
    onDoubleSelect: () => clickTrayIcon(icon, "double"),
    onContextMenu: () => {
      hideTip();
      holdDockMenu(windowPidOf(icon.hwnd));
      clickTrayIcon(icon, "right");
    },
    // Each icon in the flyout has its popup, as in Windows' overflow: the app's own one
    // (NIN_POPUPOPEN / NIN_POPUPCLOSE) or the standard tooltip with its tip text, above the icon.
    onHover: (hovered) => {
      if (ownsPopup(icon)) return hoverTrayIcon(icon, hovered);
      hoverTipAt(`tip:tray-overflow:${icon.key}`, () => tipLines(icon), hovered, () => gridCellRect(OVERFLOW_MENU, index));
    },
    // Dragged out of the flyout and released on this tray in the bar: shown on the taskbar.
    drag: zones.length
      ? {
          start: () => {
            hideTip();
            endTrayPopup();
            settle();
            trayDrag.key = icon.key;
            // Lifted from its cell: the copy starts exactly over it (GridPanel draws icons at 20 px).
            startDragGhost(icon.image, 20, gridCellRect(OVERFLOW_MENU, index));
          },
          move: () => {
            moveDragGhost();
            if (!dragGhost.ready) return;
            const placer = placers.get(zones[0]!);
            const slot = placer ? slotAt(placer, icon.key) : -1;
            if (slot !== trayDrag.slot) trayDrag.slot = slot;
          },
          end: (cancelled) => {
            const placer = placers.get(zones[0]!);
            trayDrag.key = "";
            if (cancelled || !placer || !zones.some((id) => DockWindow.pointerOn(id))) {
              endPlacement();
              endDragGhost();
              return;
            }
            // Its place in the row first, so it shows up there once the registry says it shows. Till
            // then the gap stays open and the copy waits in it (settled by the View).
            const slot = trayDrag.slot >= 0 ? trayDrag.slot : placer.inline().length;
            trayDrag.slot = slot;
            trayDrag.arriving = icon.key;
            settleLater();
            placer.commit(icon, slot);
            setTrayIconPromoted(icon, true);
          },
        }
      : undefined,
  }));
  return { id: OVERFLOW_MENU, title: t("widgets.tray.hiddenIcons"), sections: [items], grid: true };
}

/** The row's buttons, with the gap where a dragged icon will land (slot among the others). */
function rowChildren(inline: TrayIcon[], preview: boolean | undefined, movable: boolean, placer: Placer | undefined) {
  // An icon dropped from the flyout is drawn in its place in the same render the gap goes.
  const arrived = !!trayDrag.arriving && inline.some((i) => i.key === trayDrag.arriving);
  // While a drag starts the copy is not up yet: no gap (the icon is still drawn in its place).
  const held = !!trayDrag.arriving || !!trayDrag.leaving || dragGhost.ready;
  const slot = movable && held && trayDrag.slot >= 0 && !arrived ? trayDrag.slot : -1;
  const out: Child[] = [];
  let n = 0;
  for (const icon of inline) {
    // The dragged (or leaving) icon stays in the list, folded, so its drag goes on; it is not a slot.
    if (icon.key !== trayDrag.key && icon.key !== trayDrag.leaving) {
      if (n === slot) out.push(<Gap key="tray-gap" closing={!!trayDrag.leaving} />);
      n++;
    }
    out.push(<TrayButton key={icon.key} icon={icon} preview={preview} movable={movable} placer={placer} />);
  }
  if (slot >= n) out.push(<Gap key="tray-gap" closing={!!trayDrag.leaving} />);
  return out;
}

/**
 * The notification area: icons other apps put in the system tray. Windows 11's own choice of
 * icons shown on the taskbar stays in the bar; the rest sit behind the arrow.
 */
export default defineWidget({
  type: "tray",
  sideForm: "full",
  name: t("widgets.tray.systemTray"),
  description: t("widgets.tray.iconsOfBackgroundApps"),
  category: "system",
  defaultConfig: { inline: "promoted" as InlineMode, order: [] as string[] },
  settings: [
    {
      kind: "choice",
      key: "inline",
      label: t("widgets.tray.iconsOnBar"),
      description: t("widgets.tray.whichIconsStayVisible"),
      options: [
        { value: "promoted", label: t("widgets.tray.likeWindows") },
        { value: "all", label: t("widgets.tray.all") },
        { value: "none", label: t("widgets.tray.none") },
      ],
    },
  ],
  setup(ctx) {
    ctx.onDispose(acquireTaskbarHost());
    return {};
  },
  menu() {
    return [
      [{ label: t("widgets.tray.taskbarSettings"), icon: "settings", onSelect: () => launch("ms-settings:taskbar") }],
    ];
  },
  View({ ctx, preview }) {
    const vertical = dockVertical() && !preview;
    const icons = tray.icons.filter((i) => !i.hidden && i.image);
    const mode = ctx.config.inline;
    const order = ctx.config.order;
    const inline = applyOrder(mode === "all" ? icons : mode === "none" ? [] : icons.filter((i) => i.promoted), order);
    const overflow = icons.filter((i) => !inline.includes(i));
    // A drop the registry has now applied: the icon is where it landed, so the gap and the copy go.
    if (trayDrag.arriving && inline.some((i) => i.key === trayDrag.arriving)) queueMicrotask(settle);
    if (trayDrag.leaving && !inline.some((i) => i.key === trayDrag.leaving)) queueMicrotask(settleLeft);
    // An open flyout follows the icons: one whose app quit leaves it at once, as on the taskbar.
    // Only when the hidden icons really changed: updating the menu re-renders, which renders this
    // again, so an unconditional update would loop forever.
    const arrow = `tray-overflow:${ctx.instanceId}`;
    const row = `tray-icons:${ctx.instanceId}`;
    // Moving icons only means something while Windows' own choice decides what shows.
    const movable = mode === "promoted" && !preview;
    const zones = movable ? [arrow, row] : [];
    const placer: Placer | undefined = movable
      ? {
          row,
          arrow,
          inline: () => inline,
          buttonId: (icon) => `tray-btn:${ctx.instanceId}:${icon.key}`,
          commit: (icon, slot) => {
            const ids = inline.filter((i) => i.key !== icon.key).map(orderId);
            ids.splice(Math.max(0, Math.min(slot, ids.length)), 0, orderId(icon));
            // Icons not shown now keep their remembered place for when they come back.
            const old = (ctx.config.order) ?? [];
            ctx.config.order = [...ids, ...old.filter((k) => !ids.includes(k))].slice(0, 200);
            ctx.save();
          },
        }
      : undefined;
    if (placer) placers.set(arrow, placer);
    const key = overflowKey(overflow, zones);
    if (!preview && key !== shownOverflow) {
      shownOverflow = key;
      queueMicrotask(() => updateDockMenu(OVERFLOW_MENU, overflow.length ? overflowSpec(overflow, zones) : null));
    }
    // A bar icon held over the arrow opens the flyout; dropped there it goes behind it (IsPromoted 0), as on Windows 11.
    const arrowDrop = movable
      ? {
          dropTarget: true,
          onDragEnter: () => {
            if (!trayDrag.key) return;
            trayDrag.over = true;
            // Held over the arrow, the flyout opens to take it, as on Windows 11. Not activated:
            // the focus moving to it would cancel the drag.
            clearTimeout(dragOpenTimer);
            dragOpenTimer = setTimeout(() => {
              if (!trayDrag.key || !trayDrag.over || menuOpen() || !overflow.length) return;
              openedByDrag = true;
              shownOverflow = overflowKey(overflow, zones);
              toggleDockMenu(overflowSpec(overflow, zones), arrow, { activate: false });
            }, 400);
          },
          onDragLeave: () => {
            trayDrag.over = false;
            clearTimeout(dragOpenTimer);
          },
          // The dragged button's onDragEnd hides it (it sees the pointer on the arrow), keeping it
          // folded until the registry change lands; this only ends the hover state.
          onDrop: () => {
            clearTimeout(dragOpenTimer);
            trayDrag.over = false;
          },
        }
      : {};
    return (
      <Tile padding={{ left: 4, right: 4 }} gap={0} side="full">
        <Pressable
          id={preview ? undefined : arrow}
          onClick={() => overflow.length && openOverflow(overflow, arrow, zones)}
          {...arrowDrop}
          style={{
            width: vertical ? 30 : 26,
            height: vertical ? 24 : 36,
            radius: 7,
            align: "center",
            justify: "center",
            cursor: overflow.length ? "pointer" : "default",
            shrink: 0,
            opacity: overflow.length || trayDrag.key ? 1 : 0.35,
            background: trayDrag.over ? "rgba(255,255,255,0.12)" : undefined,
            hover: { background: "rgba(255,255,255,0.07)" },
          }}
        >
          {/* The taskbar's "Mostrar ícones ocultos" arrow (ChevronUp glyph). */}
          {/* Pointing to where the flyout opens: up, or down / right / left on the other edges. */}
          <FluentGlyph code={preview ? 0xe70e : ARROWS[dockEdge()]} size={12} color={ui.text} />
        </Pressable>
        {inline.length || (movable && trayDrag.slot >= 0) ? (
          <View id={preview ? undefined : row} style={{ direction: vertical ? "column" : "row", align: "center", gap: 0 }}>
            {rowChildren(inline, preview, movable, placer)}
          </View>
        ) : (
          <View id={preview ? undefined : row} />
        )}
      </Tile>
    );
  },
});
