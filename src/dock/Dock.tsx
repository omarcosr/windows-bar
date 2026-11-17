import { Icon, Pressable, Row, Text, View, Window, darkTheme, store } from "@tarve/core";
import { config, type WidgetInstance } from "../config";
import { dockBackground, ui } from "../theme";
import { mountWidget } from "../widgets/host";
import { dockAlign } from "../services/taskbar-prefs";
import { appColor } from "../services/app-color";
import { dockUi, dropSide, removeWidget, widgetDrag, widgetDragProps } from "./state";
import { openWidgetMenu, openWidgetSettings } from "./widget-menu";
import { glyph } from "../menu/dock-menu";
import { toggleDesktop } from "../native/desktop";
import { currentExtra, dockCount, dockMetrics, inDockGroup, magnifying, magnifyRowProps, maxExtra } from "../widgets/magnify";

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
  if (!color || !sweep.next || !config.colorTransition) {
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

function SettingsBadge(props: { onClick: () => void }) {
  return (
    <Pressable
      onClick={props.onClick}
      style={{
        // Bottom-right, inside the tile: diagonal from the remove badge, so even a narrow widget
        // keeps the two apart.
        position: "absolute",
        bottom: 3,
        right: 3,
        width: 20,
        height: 20,
        radius: 10,
        background: "rgba(58,58,64,0.92)",
        borderWidth: 1,
        borderColor: "rgba(255,255,255,0.14)",
        align: "center",
        justify: "center",
        cursor: "pointer",
        zIndex: 10,
        boxShadow: { y: 1, blur: 3, color: "#0008" },
        hover: { transform: "scale(1.1)", background: ui.blue },
      }}
    >
      <Icon iconNode={glyph.sliders} size={12} color="#fff" strokeWidth={2.4} />
    </Pressable>
  );
}

function RemoveBadge(props: { onClick: () => void }) {
  return (
    <Pressable
      onClick={props.onClick}
      style={{
        position: "absolute",
        top: -7,
        left: -7,
        width: 18,
        height: 18,
        radius: 9,
        background: ui.danger,
        align: "center",
        justify: "center",
        cursor: "pointer",
        zIndex: 10,
        boxShadow: { y: 1, blur: 3, color: "#0008" },
        hover: { transform: "scale(1.12)" },
      }}
    >
      <View style={{ width: 8, height: 2, radius: 1, background: "#fff" }} />
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
  return (
    <Pressable
      {...(props.editing ? {} : drag)}
      onContextMenu={() => openWidgetMenu(widget)}
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
        <View style={{ position: "absolute", top: 6, bottom: 6, width: 3, radius: 2, background: ui.blue, [side]: -5, zIndex: 20 }} />
      ) : null}
      {props.editing ? <RemoveBadge onClick={() => removeWidget(instance.id)} /> : null}
      {props.editing && widget.definition.settings?.length ? <SettingsBadge onClick={() => openWidgetSettings(instance.id)} /> : null}
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
  const base = measured.width - (reserving ? currentExtra("dock", count, m.slot) : 0);
  report(base + reserve, measured.height);
}

export function DockView(props: { onSize: (width: number, height: number) => void; onContextMenu: () => void }) {
  const editing = dockUi.editing;
  const full = config.mode === "full";
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
  const side = (list: WidgetInstance[], justify: "start" | "end") => (
    <Row style={{ flex: 1, basis: 0, gap: ui.dock.gap, align: "center", justify }}>{list.map(slot)}</Row>
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
  report = props.onSize;
  queueMicrotask(reportSize);
  const groupRow = group.length ? (
    <Row key="group" {...magnify} style={{ align: "center", gap: 0, shrink: 0 }}>
      {group.map(slot)}
    </Row>
  ) : null;
  const content = !full
    ? [...(left ? [groupRow] : []), ...before.map(slot), ...(left ? [] : [groupRow]), ...after.map(slot)]
    : left
      ? [groupRow, ...before.map(slot), side(after, "end")]
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
      level="alwaysOnTop"
      backdrop="transparent"
      position="bottom"
      theme={darkTheme}
    >
      {/* The whole window answers a right-click with the bar menu: the strip around a floating
          dock and any empty space, not only the dock itself. */}
      <Pressable
        onContextMenu={props.onContextMenu}
        style={
          inStrip
            ? {
                // Only right-click does something here: no hand cursor.
                cursor: "default",
                flex: 1,
                direction: "row",
                align: "center",
                justify: left ? "start" : "center",
                // The window reaches 2 px over the app above (stripOverlap); the dock stays put.
                padding: {
                  left: stripMargin,
                  right: stripMargin,
                  bottom: stripMargin,
                  top: stripMargin + (strip ? 2 : 0),
                },
                background: strip ? (sweep.base ?? "rgba(0,0,0,0)") : undefined,
                overflow: "hidden",
              }
            : { flex: 1, align: "start", justify: reserving && !left ? "center" : "start", direction: "row", cursor: "default" }
        }
      >
        {strip ? <Sweep height={stripHeight} /> : null}
        {/* A free dock's window hugs this box; the edit-mode room for the remove badges is its padding. */}
        <View
          onSize={({ borderBox }) => {
            measured.width = borderBox.width;
            measured.height = borderBox.height;
            reportSize();
          }}
          style={{
            ...(full ? { flex: 1 } : { shrink: 0 }),
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
              direction: "row",
              align: "center",
              height: ui.dock.height,
              gap: 0,
              padding: 0,
              radius: full ? 0 : ui.dock.radius,
              background: dockBackground(config.opacity),
              boxSizing: "border-box",
              width: full ? "100%" : undefined,
              shrink: 0,
            }}
          >
            <Row style={{
              ...(full ? { flex: 1, basis: 0 } : { shrink: 0 }),
              align: "center",
              gap: ui.dock.gap,
              padding: full ? { left: 8, right: 8, top: ui.dock.padding, bottom: ui.dock.padding } : ui.dock.padding,
            }}>
              {content}
            </Row>
            {config.showDesktop && !editing ? (
              <Pressable
                aria-label="Mostrar área de trabalho"
                onClick={() => { toggleDesktop(); }}
                onContextMenu={props.onContextMenu}
                style={{
                  width: 8,
                  height: ui.dock.height,
                  shrink: 0,
                  justify: "center",
                  cursor: "default",
                  hover: { background: ui.tile.hover },
                }}
              >
                <View style={{ width: 1, height: 16, background: ui.text, opacity: 0.2 }} />
              </Pressable>
            ) : null}
          </Pressable>
        </View>
      </Pressable>
    </Window>
  );
}
