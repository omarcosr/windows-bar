import { Pressable, Row, Text, View, Window, darkTheme, store } from "@tarve/core";
import { config, type WidgetInstance } from "../config";
import { dockBackground, ui } from "../theme";
import { mountWidget } from "../widgets/host";
import { taskbarPrefs } from "../services/taskbar-prefs";
import { appColor } from "../services/app-color";
import { dockUi, removeWidget } from "./state";
import { openWidgetMenu } from "./widget-menu";

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
  if (!color || !sweep.next) {
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
  return (
    <Pressable onContextMenu={() => openWidgetMenu(widget)} style={{ position: "relative", shrink: 0 }}>
      <WidgetView state={widget.state} ctx={widget.ctx} preview={false} />
      {props.editing ? <RemoveBadge onClick={() => removeWidget(instance.id)} /> : null}
    </Pressable>
  );
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
  const widgets = config.widgets;
  // Start and Apps form one group, placed like the Windows taskbar's icons: centred or on the
  // left, following Windows' own taskbar alignment. Other widgets keep their side of the group.
  const slot = (instance: WidgetInstance) => <WidgetSlot key={instance.id} instance={instance} editing={editing} />;
  const inGroup = (w: WidgetInstance) => w.type === "start" || w.type === "apps";
  const firstGroup = widgets.findIndex(inGroup);
  const group = widgets.filter(inGroup);
  const before = widgets.filter((w, i) => !inGroup(w) && (firstGroup < 0 || i < firstGroup));
  const after = widgets.filter((w, i) => !inGroup(w) && firstGroup >= 0 && i > firstGroup);
  const left = taskbarPrefs.align === "left";
  const side = (list: WidgetInstance[], justify: "start" | "end") => (
    <Row style={{ flex: 1, basis: 0, gap: ui.dock.gap, align: "center", justify }}>{list.map(slot)}</Row>
  );
  // Start and the app icons share one row with no gap, so their 44 px slots space evenly.
  const groupRow = group.length ? (
    <Row key="group" style={{ align: "center", gap: 0, shrink: 0 }}>
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
      <View
        style={
          inStrip
            ? {
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
            : { flex: 1, align: "start", justify: "start", direction: "row" }
        }
      >
        {strip ? <Sweep height={stripHeight} /> : null}
        {/* A free dock's window hugs this box; the edit-mode room for the remove badges is its padding. */}
        <View
          onSize={({ borderBox }) => props.onSize(borderBox.width, borderBox.height)}
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
              direction: "row",
              align: "center",
              height: ui.dock.height,
              gap: ui.dock.gap,
              padding: full ? { left: 8, right: 8, top: ui.dock.padding, bottom: ui.dock.padding } : ui.dock.padding,
              radius: full ? 0 : ui.dock.radius,
              background: dockBackground(config.opacity),
              boxSizing: "border-box",
              width: full ? "100%" : undefined,
              shrink: 0,
            }}
          >
            {content}
          </Pressable>
        </View>
      </View>
    </Window>
  );
}
