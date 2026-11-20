import { Image, Pressable, View, store, type Child } from "@tarve/core";
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
import { endDragGhost, moveDragGhost, startDragGhost } from "../../menu/drag-ghost";
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
import { HitReach, iconHover, Tile } from "../ui";
import { HoverTip, hideTip, hoverTipAt } from "../../menu/hover-tip";
import { defineWidget } from "../types";

type InlineMode = "promoted" | "all" | "none";

/** Tray icons follow the icon size setting (18 px at 100%). */
const trayIcon = () => Math.round((18 * Math.max(0.7, Math.min(1.3, Number(config.iconScale ?? 100) / 100))) / 2) * 2;

/**
 * Moving icons between the taskbar and the hidden-icons flyout by dragging, as on Windows 11: the
 * drop writes IsPromoted in the icon's NotifyIconSettings subkey (setTrayIconPromoted) and the
 * key's change notification moves it; nothing is kept here but the drag in progress.
 */
const trayDrag = store({ key: "", over: false, arrived: "", slot: -1 });

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

function Gap() {
  return <View motionFrom={{ width: 0 }} style={{ width: 30, height: 36, shrink: 0, transition: GAP_MOTION }} />;
}

/** The flyout was opened by an icon dragged over the arrow: it gets the focus after the drop. */
let openedByDrag = false;
let dragOpenTimer: ReturnType<typeof setTimeout> | undefined;

/** The tooltip lines Windows shows for an icon: its tip text, one line per line. */
const tipLines = (icon: TrayIcon) => icon.tip.split("\n").map((l) => l.trim());

/** An icon that just moved onto the taskbar grows into its slot (only that one, not every mount). */
const ARRIVE = { opacity: 0, transform: "scale(0.4)" };
const ARRIVE_MOTION = { opacity: { duration: 160 }, transform: { duration: 260, easing: "spring" as const } };

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
          trayDrag.key = icon.key;
          trayDrag.arrived = "";
          startDragGhost(icon.image, trayIcon());
        },
        onDragMove: () => {
          moveDragGhost();
          if (!props.placer) return;
          // Off the row the gap stays where the icon was: the row keeps its length all along the
          // drag, so the dock never shrinks and grows back under it.
          let slot = slotAt(props.placer, icon.key);
          if (slot < 0) slot = props.placer.inline().findIndex((i) => i.key === icon.key);
          if (slot !== trayDrag.slot) trayDrag.slot = slot;
        },
        onDragEnd: (event: { cancelled: boolean }) => {
          endDragGhost();
          clearTimeout(dragOpenTimer);
          const key = trayDrag.key;
          const slot = trayDrag.slot;
          trayDrag.key = "";
          trayDrag.over = false;
          endPlacement();
          // Released on the arrow, or over the flyout it opened (a window of its own: no drop
          // event reaches the dock from there): the icon goes behind the arrow. Released in the
          // row: it takes the place shown.
          const hide = (props.placer && DockWindow.pointerOn(props.placer.arrow)) || pointOnDockMenu(OVERFLOW_MENU, cursorPos());
          if (key && !event.cancelled && hide) setTrayIconPromoted(icon, false);
          else if (key && !event.cancelled && slot >= 0 && props.placer && DockWindow.pointerOn(props.placer.row)) props.placer.commit(icon, slot);
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
  const arrived = !props.preview && trayDrag.arrived === icon.key;
  const dragging = trayDrag.key === icon.key;
  const lifted = dragging && trayDrag.slot >= 0;
  const hover = iconHover();
  // The app's own tip text, shown by the taskbar on hover.
  return (
    <HoverTip id={`tip:tray:${icon.key}`} tip={() => tipLines(icon)} disabled={props.preview || popup} side="full">
    <Pressable
      id={props.placer?.buttonId(icon)}
      motionFrom={arrived ? ARRIVE : undefined}
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
        opacity: lifted ? 0 : dragging ? 0.4 : 1,
        ...hover,
        // After the hover effect's own transitions, which would otherwise replace these.
        transition: { ...hover.transition, ...(arrived ? ARRIVE_MOTION : {}), ...(lifted ? GAP_MOTION : {}) },
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

const label = (icon: TrayIcon) => icon.tip.split("\n")[0]!.trim() || (icon.exe ? prettyName(icon.exe) : "Ícone");

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
            trayDrag.arrived = "";
            startDragGhost(icon.image, 20);
          },
          move: () => {
            moveDragGhost();
            const placer = placers.get(zones[0]!);
            const slot = placer ? slotAt(placer, icon.key) : -1;
            if (slot !== trayDrag.slot) trayDrag.slot = slot;
          },
          end: (cancelled) => {
            endDragGhost();
            const slot = trayDrag.slot;
            endPlacement();
            if (cancelled || !zones.some((id) => DockWindow.pointerOn(id))) return;
            trayDrag.arrived = icon.key;
            // Its place in the row first, so it shows up there once the registry says it shows.
            const placer = placers.get(zones[0]!);
            if (placer) placer.commit(icon, slot >= 0 ? slot : placer.inline().length);
            setTrayIconPromoted(icon, true);
          },
        }
      : undefined,
  }));
  return { id: OVERFLOW_MENU, title: "Ícones ocultos", sections: [items], grid: true };
}

/** The row's buttons, with the gap where a dragged icon will land (slot among the others). */
function rowChildren(inline: TrayIcon[], preview: boolean | undefined, movable: boolean, placer: Placer | undefined) {
  const slot = movable && trayDrag.slot >= 0 ? trayDrag.slot : -1;
  const out: Child[] = [];
  let n = 0;
  for (const icon of inline) {
    // The dragged icon stays in the list (collapsed) so its drag goes on; it is not a slot.
    if (icon.key !== trayDrag.key) {
      if (n === slot) out.push(<Gap key="tray-gap" />);
      n++;
    }
    out.push(<TrayButton key={icon.key} icon={icon} preview={preview} movable={movable} placer={placer} />);
  }
  if (slot >= n) out.push(<Gap key="tray-gap" />);
  return out;
}

/**
 * The notification area: icons other apps put in the system tray. Windows 11's own choice of
 * icons shown on the taskbar stays in the bar; the rest sit behind the arrow.
 */
export default defineWidget({
  type: "tray",
  sideForm: "full",
  name: "Bandeja do sistema",
  description: "Ícones dos apps em segundo plano. A seta mostra os ocultos.",
  category: "system",
  defaultConfig: { inline: "promoted" as InlineMode, order: [] as string[] },
  settings: [
    {
      kind: "choice",
      key: "inline",
      label: "Ícones na barra",
      description: "Quais ícones ficam visíveis; o resto fica atrás da seta.",
      options: [
        { value: "promoted", label: "Como o Windows" },
        { value: "all", label: "Todos" },
        { value: "none", label: "Nenhum" },
      ],
    },
  ],
  setup(ctx) {
    ctx.onDispose(acquireTaskbarHost());
    return {};
  },
  menu() {
    return [
      [{ label: "Configurações da barra de tarefas", icon: "settings", onSelect: () => launch("ms-settings:taskbar") }],
    ];
  },
  View({ ctx, preview }) {
    const vertical = dockVertical() && !preview;
    const icons = tray.icons.filter((i) => !i.hidden && i.image);
    const mode = ctx.config.inline;
    const order = ctx.config.order;
    const inline = applyOrder(mode === "all" ? icons : mode === "none" ? [] : icons.filter((i) => i.promoted), order);
    const overflow = icons.filter((i) => !inline.includes(i));
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
    // A bar icon dropped on the arrow goes behind it (IsPromoted 0), as on Windows 11.
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
          onDrop: () => {
            clearTimeout(dragOpenTimer);
            const icon = tray.icons.find((i) => i.key === trayDrag.key);
            trayDrag.key = "";
            trayDrag.over = false;
            if (icon) setTrayIconPromoted(icon, false);
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
