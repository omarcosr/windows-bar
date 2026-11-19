import { Pressable, Row, Text, View, Window, darkTheme, store, type Child } from "@tarve/core";
import { config, type WidgetInstance } from "../config";
import { dockBackground, ui } from "../theme";
import { mountWidget } from "../widgets/host";
import { COMPACT_PAD } from "../widgets/ui";
import { setFullForm } from "../widgets/form";
import { hidePeek, peekWidget } from "../menu/widget-peek";
import { dockAlign, dockEdge, dockVertical } from "../services/taskbar-prefs";
import { appColor } from "../services/app-color";
import { dockUi, dropSide, removeWidget, widgetDrag, widgetDragProps } from "./state";
import { openWidgetMenu, openWidgetSettings } from "./widget-menu";
import { FluentGlyph } from "../menu/dock-menu";
import { toggleDesktop } from "../native/desktop";
import { currentExtra, dockCount, dockMetrics, dockRoom, fixedGroupSlots, inDockGroup, magnifying, magnifyRowProps, maxExtra, noteSlotWidth } from "../widgets/magnify";

export const DOCK_TITLE = "WindowsBar Dock";

/**
 * The strip's colour change: the new colour wipes down from the top over the old one.
 * `base` is what the strip shows; `next` is drawn on top, growing from height 0, and becomes
 * the base when it has covered the strip. `n` keys the wipe so each change starts from the top.
 */
const sweep = store({ base: null as string | null, next: null as string | null, n: 0 });
const SWEEP_MS = 380;

function followColor(color: string | null) {
  if (color === sweep.next) return;
  // The wipe runs down from the top edge of a bottom strip; on the other edges the colour switches at once.
  if (!color || !sweep.next || !config.colorTransition || dockEdge() !== "bottom") {
    // From or to no colour: nothing to wipe over, switch at once.
    Object.assign(sweep, { base: color, next: color, n: sweep.n + 1 });
    return;
  }
  // A wipe still running settles first, so the new one starts over the colour now on screen.
  Object.assign(sweep, { base: sweep.next, next: color, n: sweep.n + 1 });
}

/** Height of the soft edge at the front of the wipe, in logical px. */
const SWEEP_FEATHER = 48;

/** The same colour fully transparent, so the gradient fades out without darkening. */
function clear(color: string) {
  const m = /^rgba?\(([^,]+),([^,]+),([^,)]+)/i.exec(color);
  return m ? `rgba(${m[1]},${m[2]},${m[3]},0)` : "rgba(0,0,0,0)";
}

/**
 * The new colour as a gradient: solid at the top, fading out over SWEEP_FEATHER at its lower
 * edge. The whole band slides down from above the strip, so its soft edge leads the change.
 */
function Sweep(props: { height: number }) {
  if (!sweep.next || sweep.next === sweep.base) return null;
  const total = props.height + SWEEP_FEATHER;
  const solid = Math.round((props.height / total) * 100);
  return (
    <View
      key={`sweep-${sweep.n}`}
      motionFrom={{ top: -total }}
      onTransitionEnd={({ property }) => {
        if (property === "top") sweep.base = sweep.next;
      }}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        height: total,
        background: `linear-gradient(to bottom, ${sweep.next} 0%, ${sweep.next} ${solid}%, ${clear(sweep.next)} 100%)`,
        transition: { top: { duration: SWEEP_MS, easing: "easeInOut" } },
      }}
    />
  );
}

// Edit-mode controls: one small bar centred on the widget's edge facing away from the screen
// edge (above the tiles of a bottom dock). Centred, the controls of two neighbours are a whole
// widget apart instead of meeting in the gap between them, as corner badges did.
// How far the controls may stick out of the widget without leaving the window, set by DockView:
// the dock's own padding plus whatever room the window leaves on that side. A docked or full bar
// has only the padding, so the controls overlap the widget's edge instead of being cut off.
let badgeOut = 9;

function EditBadges(props: { onRemove: () => void; onSettings?: () => void }) {
  const edge = dockEdge();
  const vertical = dockVertical();
  const out = -badgeOut;
  const place =
    edge === "bottom" ? { top: out, left: 0, right: 0 }
    : edge === "top" ? { bottom: out, left: 0, right: 0 }
    : edge === "left" ? { right: out, top: 0, bottom: 0 }
    : { left: out, top: 0, bottom: 0 };
  return (
    <View
      style={{
        position: "absolute",
        ...place,
        direction: vertical ? "column" : "row",
        align: "center",
        justify: "center",
        gap: 6,
        zIndex: 10,
        // The strip spans the widget; only the buttons take the pointer, the rest drags as before.
        pointerEvents: "none",
      }}
    >
      <EditBadge label="remove" background={ui.danger} hoverBackground={ui.danger} onClick={props.onRemove}>
        <View style={{ width: 8, height: 2, radius: 1, background: "#fff" }} />
      </EditBadge>
      {props.onSettings ? (
        <EditBadge label="settings" background="rgba(58,58,64,0.92)" hoverBackground={ui.blue} onClick={props.onSettings}>
          {/* Settings gear, the glyph Windows uses for settings. */}
          <FluentGlyph code={0xe713} size={11} color="#ffffff" />
        </EditBadge>
      ) : null}
    </View>
  );
}

function EditBadge(props: { label: string; background: string; hoverBackground: string; onClick: () => void; children: Child }) {
  return (
    <Pressable
      onClick={props.onClick}
      style={{
        pointerEvents: "auto",
        width: 18,
        height: 18,
        radius: 9,
        background: props.background,
        borderWidth: 1,
        borderColor: "rgba(255,255,255,0.18)",
        align: "center",
        justify: "center",
        cursor: "pointer",
        boxShadow: { y: 1, blur: 3, color: "#0008" },
        hover: { transform: "scale(1.12)", background: props.hoverBackground },
      }}
    >
      {props.children}
    </Pressable>
  );
}

function WidgetSlot(props: { instance: WidgetInstance; editing: boolean }) {
  const { instance } = props;
  const widget = mountWidget(instance);
  if (!widget) {
    return (
      <View style={{ height: ui.tile.height, padding: 8, justify: "center", radius: ui.tile.radius, background: ui.tile.background }}>
        <Text size={11} color={ui.muted}>{`? ${instance.type}`}</Text>
      </View>
    );
  }
  const { View: WidgetView } = widget.definition;
  // Drag a widget onto another to move it there; a blue bar marks where it will land. Widgets
  // with buttons of their own take the press, so while the widgets window is open (edit mode) a
  // cover over each widget makes the whole of it draggable.
  const side = dropSide(instance.id);
  const drag = widgetDragProps(instance.id);
  // On a side edge a minimal widget shows in full beside the dock while the pointer rests on it.
  // Not where the widget opens its own flyout on hover (now playing).
  const peeks =
    dockVertical() && !props.editing && !inDockGroup(instance.id) && widget.definition.sideForm !== "full" && instance.config.hoverFlyout !== true;
  const peekProps = peeks
    ? { onPointerMove: () => peekWidget(instance.id, true), onPointerLeave: () => peekWidget(instance.id, false) }
    : {};
  return (
    <Pressable
      {...(props.editing ? {} : drag)}
      {...peekProps}
      onContextMenu={() => {
        hidePeek();
        openWidgetMenu(widget);
      }}
      onSize={({ borderBox }) => noteSlotWidth(instance.id, dockVertical() ? borderBox.height : borderBox.width)}
      style={{
        position: "relative",
        shrink: 0,
        // The widget's own buttons show the hand; the rest of it is only draggable.
        cursor: "default",
        opacity: widgetDrag.source === instance.id ? 0.4 : 1,
        transition: { opacity: { duration: 120, easing: "easeOut" } },
      }}
    >
      <WidgetView state={widget.state} ctx={widget.ctx} preview={false} />
      {props.editing ? (
        <Pressable
          {...drag}
          onContextMenu={() => openWidgetMenu(widget)}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            radius: ui.tile.radius,
            cursor: "grab",
            zIndex: 5,
            hover: { background: "rgba(255,255,255,0.06)" },
          }}
        />
      ) : null}
      {side ? (
        dockVertical() ? (
            <View style={{ position: "absolute", left: 6, right: 6, height: 3, radius: 2, background: ui.blue, [side === "left" ? "top" : "bottom"]: -5, zIndex: 20 }} />
        ) : (
          <View style={{ position: "absolute", top: 6, bottom: 6, width: 3, radius: 2, background: ui.blue, [side]: -5, zIndex: 20 }} />
        )
      ) : null}
      {props.editing ? (
        <EditBadges
          onRemove={() => removeWidget(instance.id)}
          onSettings={widget.definition.settings?.length ? () => openWidgetSettings(instance.id) : undefined}
        />
      ) : null}
    </Pressable>
  );
}

/**
 * The dock's size for its window. With the macOS effect a free-floating dock's window keeps the
 * room the magnified icons can take, all the time: resizing the window on every frame of the
 * animation (async, a frame behind the content) made the dock jump and clip. The content is
 * centred in that room, so it grows on both sides like the Dock.
 */
const measured = { width: 0, height: 0 };
let reserving = false;
let report: ((width: number, height: number) => void) | null = null;

function reportSize() {
  if (!report || !measured.width) return;
  // Counted here, not at render: the apps widget reports its icon count when it renders.
  const count = dockCount();
  const m = dockMetrics();
  const reserve = reserving ? maxExtra(count, m) : 0;
  // Along the dock: its width in a row, its height down a side-edge column.
  if (dockVertical()) {
    const base = measured.height - (reserving ? currentExtra("dock", count, m.slot) : 0);
    report(measured.width, base + reserve);
    return;
  }
  const base = measured.width - (reserving ? currentExtra("dock", count, m.slot) : 0);
  report(base + reserve, measured.height);
}

export function DockView(props: { onSize: (width: number, height: number) => void; onContextMenu: () => void }) {
  // The dock draws its widgets in their dock form (see widgets/form.ts).
  setFullForm(false);
  const editing = dockUi.editing;
  const full = config.mode === "full";
  // The edge Windows' taskbar is set to: a row at the top or bottom, a column on the left or right.
  const edge = dockEdge();
  const vertical = edge === "left" || edge === "right";
  const dir = vertical ? ("column" as const) : ("row" as const);
  // With reserveSpace the window is an AppBar spanning the whole strip. A floating dock then
  // sits inside it with its margins, over a strip painted in the colour of the app in front
  // (stripFollowsApp), so the app seems to continue under the dock.
  const docked = config.reserveSpace;
  const inStrip = docked && !full;
  const strip = inStrip && config.stripFollowsApp;
  const stripMargin = config.bottomMargin;
  // Read during render, so a new colour renders the dock again.
  const stripColor = strip ? appColor.color : null;
  if (strip) queueMicrotask(() => followColor(stripColor));
  const stripHeight = stripMargin * 2 + 2 + ui.dock.height + 4;
  // Widgets with nothing to show step aside; edit mode shows them all so they can be reached.
  const shown = (w: WidgetInstance) => {
    if (editing) return true;
    const m = mountWidget(w);
    return !m?.definition.hidden?.({ state: m.state, ctx: m.ctx });
  };
  const widgets = config.widgets.filter(shown);
  // Start and Apps form one group, placed like the Windows taskbar's icons: centred or on the
  // left, following Windows' own taskbar alignment. Other widgets keep their side of the group.
  const slot = (instance: WidgetInstance) => <WidgetSlot key={instance.id} instance={instance} editing={editing} />;
  const inGroup = (w: WidgetInstance) => inDockGroup(w.id);
  const firstGroup = widgets.findIndex(inGroup);
  const group = widgets.filter(inGroup);
  const before = widgets.filter((w, i) => !inGroup(w) && (firstGroup < 0 || i < firstGroup));
  const after = widgets.filter((w, i) => !inGroup(w) && firstGroup >= 0 && i > firstGroup);
  const left = dockAlign() === "left";
  // "Juntar widgets": the widgets on each side of the group share one card, with thin dividers.
  const run = (list: WidgetInstance[]) => {
    if (!config.joinWidgets || list.length === 0) return list.map(slot);
    return [
      <View
        key={`join-${list[0]!.id}`}
        style={{ direction: dir, align: "center", gap: 0, shrink: 0, radius: ui.tile.radius, background: ui.tile.background }}
      >
        {list.flatMap((w, i) =>
          i === 0
            ? [slot(w)]
            : [
                <View
                    key={`div-${w.id}`}
                    style={{
                      width: vertical ? Math.round(ui.tile.height * 0.5) : 1,
                      height: vertical ? 1 : Math.round(ui.tile.height * 0.5),
                    shrink: 0,
                    background: "rgba(255,255,255,0.1)",
                  }}
                />,
                slot(w),
              ],
        )}
      </View>,
    ];
  };
  const side = (list: WidgetInstance[], justify: "start" | "end") => (
    <View style={{ direction: dir, flex: 1, basis: 0, gap: ui.dock.gap, align: "center", justify }}>{run(list)}</View>
  );
  // Start and the app icons share one row with no gap, so their 44 px slots space evenly.
  // macOS magnification follows the pointer over the whole group. A centred group grows on both
  // sides, a left-aligned one to the right only.
  const magnify =
    magnifying() && !editing
      ? magnifyRowProps("dock", () => ({ count: dockCount(), slot: ui.app.slot, inset: 0, anchor: left ? 0 : 0.5 }), reportSize)
      : {};
  // Only a window that hugs the dock needs the room; the strip and the full bar already span the screen.
  // Read at render (effect, intensity, bar height), so changing them sizes the window again.
  reserving = magnifying() && !editing && !docked && !full;
  if (reserving) maxExtra(1, dockMetrics());
  // Room past the widgets' edge facing away from the screen edge, for the edit controls.
  const windowRoom = editing && !docked ? ({ bottom: 9, top: 0, left: full ? 0 : 2, right: full ? 0 : 9 })[edge] : 0;
  const barRoom = vertical ? COMPACT_PAD : ui.dock.padding;
  badgeOut = Math.max(0, Math.min(9, barRoom + (inStrip ? stripMargin : windowRoom) - 1));
  report = props.onSize;
  queueMicrotask(reportSize);
  // Room left for the group's app icons; the rest go behind the apps widget's "•••" button.
  if (dockRoom.screen && group.length) {
    const others = widgets.filter((w) => !inGroup(w));
    const used = others.reduce((sum, w) => sum + (dockRoom.widths[w.id] ?? 0) + ui.dock.gap, 0);
    const m = dockMetrics();
    const chrome =
      (full ? 16 : ui.dock.padding * 2) +
      (config.showDesktop && !editing ? 8 : 0) +
      (full ? 0 : 2 * (Number(config.bottomMargin) || 0)) +
      (editing ? 11 : 0) +
      (reserving ? maxExtra(7, m) : 0);
    const slots = Math.max(1, Math.floor((dockRoom.screen - chrome - used) / m.slot) - fixedGroupSlots());
    if (slots !== dockRoom.appSlots) queueMicrotask(() => (dockRoom.appSlots = slots));
  }
  const groupRow = group.length ? (
    <View key="group" {...magnify} style={{ direction: dir, align: "center", gap: 0, shrink: 0 }}>
      {group.map(slot)}
    </View>
  ) : null;
  const content = !full
    ? [...(left ? [groupRow] : []), ...run(before), ...(left ? [] : [groupRow]), ...run(after)]
    : left
      ? [groupRow, ...run(before), side(after, "end")]
      : [side(before, "start"), groupRow, side(after, "end")];
  return (
    <Window
      title={DOCK_TITLE}
      width={1600}
      height={90}
      frameless
      chrome="none"
      resizable={false}
      skipTaskbar
      // A click on the dock leaves the foreground with the app in use, as the taskbar's buttons do:
      // the app in front stays known (a click on its icon minimizes it), and the dock keeps the
      // pointer's hover (a deactivated window lost it and dropped the next click until the pointer
      // moved). A text field in a widget still takes the keyboard while it is edited.
      activation="normal"
      level="alwaysOnTop"
      backdrop="transparent"
      position={edge}
      theme={darkTheme}
    >
      {/* The whole window answers a right-click with the bar menu: the strip around a floating
          dock and any empty space, not only the dock itself. */}
      <Pressable
        onContextMenu={props.onContextMenu}
        style={{
          // Invisible while the dock starts (sizes, place and icons still settling), then one
          // native fade and rise, run by the renderer: no intermediate frame is seen.
          opacity: dockUi.shown ? 1 : 0,
          // Rises in from the screen edge it sits on.
          transform: dockUi.shown
            ? vertical ? "translateX(0px)" : "translateY(0px)"
            : { bottom: "translateY(12px)", top: "translateY(-12px)", left: "translateX(-12px)", right: "translateX(12px)" }[edge],
          transition: { opacity: { duration: 180, easing: "easeOut" }, transform: { duration: 260, easing: "easeOut" } },
          ...(inStrip
            ? {
                // Only right-click does something here: no hand cursor.
                cursor: "default",
                flex: 1,
                direction: dir,
                align: "center",
                justify: left ? "start" : "center",
                // At the bottom the window reaches 2 px over the app above (stripOverlap); the dock stays put.
                padding: {
                  left: stripMargin,
                  right: stripMargin,
                  bottom: stripMargin,
                  top: stripMargin + (strip && edge === "bottom" ? 2 : 0),
                },
                background: strip ? (sweep.base ?? "rgba(0,0,0,0)") : undefined,
                overflow: "hidden",
              }
            : { flex: 1, align: "start", justify: reserving && !left ? "center" : "start", direction: dir, cursor: "default" }),
        }}
      >
        {strip && edge === "bottom" ? <Sweep height={stripHeight} /> : null}
        {/* A free dock's window hugs this box; the edit-mode room for the remove badges is its padding. */}
        <View
          onSize={({ borderBox }) => {
            measured.width = borderBox.width;
            measured.height = borderBox.height;
            reportSize();
          }}
          style={{
            ...(full ? { flex: 1, ...(vertical ? { width: "100%" } : {}) } : { shrink: 0 }),
            padding: {
              top: editing && !docked ? 9 : 0,
              left: editing && !full && !docked ? 9 : 0,
              right: editing && !full && !docked ? 2 : 0,
            },
          }}
        >
          <Pressable
            onContextMenu={props.onContextMenu}
            style={{
              cursor: "default",
              direction: dir,
              align: "center",
              // The bar's thickness across its edge: its height, or its width on a side edge.
              ...(vertical ? { width: ui.dock.height, height: full ? "100%" : undefined } : { height: ui.dock.height, width: full ? "100%" : undefined }),
              ...(full && vertical ? { flex: 1 } : {}),
              gap: 0,
              padding: 0,
              radius: full ? 0 : ui.dock.radius,
              background: dockBackground(config.opacity),
              boxSizing: "border-box",
              shrink: 0,
            }}
          >
            <View style={{
              ...(full ? { flex: 1, basis: 0 } : { shrink: 0 }),
              direction: dir,
              align: "center",
              gap: ui.dock.gap,
              // A side-edge column keeps 3 px across (COMPACT_PAD) so its compact tiles get the room.
              padding: vertical
                ? { top: full ? 8 : ui.dock.padding, bottom: full ? 8 : ui.dock.padding, left: COMPACT_PAD, right: COMPACT_PAD }
                : full
                  ? { left: 8, right: 8, top: ui.dock.padding, bottom: ui.dock.padding }
                  : ui.dock.padding,
            }}>
              {content}
            </View>
            {config.showDesktop && !editing ? (
              <Pressable
                aria-label="Mostrar área de trabalho"
                onClick={() => { toggleDesktop(); }}
                onContextMenu={props.onContextMenu}
                style={{
                  width: vertical ? ui.dock.height : 8,
                  height: vertical ? 8 : ui.dock.height,
                  shrink: 0,
                  justify: "center",
                  align: "center",
                  cursor: "default",
                  hover: { background: ui.tile.hover },
                }}
              >
                <View style={{ width: vertical ? 16 : 1, height: vertical ? 1 : 16, background: ui.text, opacity: 0.2 }} />
              </Pressable>
            ) : null}
          </Pressable>
        </View>
      </Pressable>
    </Window>
  );
}
