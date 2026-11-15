import { Pressable, Row, Text, View, Window, darkTheme } from "@tarve/core";
import { config, type WidgetInstance } from "../config";
import { dockBackground, ui } from "../theme";
import { mountWidget } from "../widgets/host";
import { taskbarPrefs } from "../services/taskbar-prefs";
import { appColor } from "../services/app-color";
import { dockUi, removeWidget } from "./state";

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
    <View style={{ position: "relative", shrink: 0 }}>
      <WidgetView state={widget.state} ctx={widget.ctx} preview={false} />
      {props.editing ? <RemoveBadge onClick={() => removeWidget(instance.id)} /> : null}
    </View>
  );
}

export function DockView(props: { onSize: (width: number, height: number) => void; onContextMenu: () => void }) {
  const editing = dockUi.editing;
  const full = config.mode === "full";
  // Floating dock over a reserved strip: the window spans the strip and paints it in the colour
  // of the app in front, so the app seems to continue under the dock.
  const strip = !full && config.reserveSpace && config.stripFollowsApp;
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
      resizable={false}
      skipTaskbar
      level="alwaysOnTop"
      backdrop="transparent"
      position="bottom"
      theme={darkTheme}
      // Transparent black, not the theme's white: antialiased edges blend toward this colour.
      style={{ background: "rgba(0,0,0,0)" }}
    >
      <View
        style={
          strip
            ? {
                // The strip colour fills the whole window, including the few px it overlaps the
                // app above (to cover that app's bottom frame line); the dock sits at the bottom.
                flex: 1,
                direction: "column",
                justify: "end",
                align: "stretch",
                background: appColor.color ?? "rgba(0,0,0,0)",
                transition: { background: { duration: 220, easing: "easeOut" } },
              }
            : { flex: 1, align: "start", justify: "start", direction: "row" }
        }
      >
        {/* onSize reports the content box, so the padded box sits inside the measured one. */}
        <View
          onSize={({ width, height }) => props.onSize(width, height)}
          style={strip ? { shrink: 0 } : full ? { flex: 1 } : { shrink: 0 }}
        >
          {/* onSize reports the content box, so the strip's margins live one level down. */}
          <View
            style={
              strip
                ? {
                    direction: "row",
                    justify: taskbarPrefs.align === "left" ? "start" : "center",
                    padding: stripMargin,
                  }
                : {}
            }
          >
            <View
              style={{
                shrink: 0,
                width: full ? "100%" : undefined,
                padding: { top: editing ? 9 : 0, left: editing && !full ? 9 : 0, right: editing && !full ? 2 : 0 },
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
                  width: full ? "100%" : undefined,
                  shrink: 0,
                }}
              >
                {content}
              </Pressable>
            </View>
          </View>
        </View>
      </View>
    </Window>
  );
}
