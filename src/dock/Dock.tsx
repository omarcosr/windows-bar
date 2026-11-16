import { Pressable, Row, Text, View, Window, darkTheme } from "@tarve/core";
import { config, type WidgetInstance } from "../config";
import { darken, dockBackground, ui } from "../theme";
import { mountWidget } from "../widgets/host";
import { taskbarPrefs } from "../services/taskbar-prefs";
import { appColor } from "../services/app-color";
import { dockUi, removeWidget } from "./state";
import { openWidgetMenu } from "./widget-menu";

export const DOCK_TITLE = "WindowsBar Dock";

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
                // A 1 px top edge 15% darker than the strip marks where it starts; it also covers
                // the frame line the app above draws on its bottom edge.
                padding: {
                  left: stripMargin,
                  right: stripMargin,
                  bottom: stripMargin,
                  top: stripMargin + (strip ? 1 : 0),
                },
                borderWidth: strip ? { top: 1 } : 0,
                borderColor: strip && appColor.color ? darken(appColor.color) : "rgba(0,0,0,0)",
                background: strip ? (appColor.color ?? "rgba(0,0,0,0)") : undefined,
                transition: { background: { duration: 220, easing: "easeOut" }, borderColor: { duration: 220, easing: "easeOut" } },
              }
            : { flex: 1, align: "start", justify: "start", direction: "row" }
        }
      >
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
              // The full-width bar gets the same darker top edge as the strip.
              borderWidth: full ? { top: 1 } : 0,
              boxSizing: "border-box",
              borderColor: full ? darken(dockBackground(config.opacity)) : "rgba(0,0,0,0)",
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
