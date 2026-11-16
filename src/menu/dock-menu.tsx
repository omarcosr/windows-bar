import {
  Column,
  Icon,
  Image,
  Pressable,
  Row,
  Text,
  View,
  Window,
  darkTheme,
  store,
  type AppHandle,
  type IconName,
  type ImageSource,
  type ScreenInfo,
  type SvgNode,
} from "@tarve/core";
import { DockWindow } from "../native/dock-window";
import { ui } from "../theme";

export interface DockMenuItem {
  label: string;
  /** A built-in icon name, a Lucide-style node list, or an image path. */
  icon?: IconName | readonly SvgNode[] | { image: ImageSource };
  danger?: boolean;
  onSelect: () => void;
  /** Right-click on the row. */
  onContextMenu?: () => void;
  /** Grid menus only: a second click on the same item within a moment. */
  onDoubleSelect?: () => void;
}

export interface DockMenuSpec {
  title: string;
  subtitle?: string;
  image?: ImageSource;
  sections: DockMenuItem[][];
  /**
   * Icons only, five per row, no header, like the Windows hidden-icons flyout. Clicks do not
   * close it; it closes when something else comes to the front, a press lands outside or Esc.
   */
  grid?: boolean;
}

const MENU_TITLE = "WindowsBar Menu";
const PANEL_WIDTH = 288;

const menu = store({ spec: null as DockMenuSpec | null });

let handle: AppHandle | undefined;
let size = { width: PANEL_WIDTH, height: 200 };
/** Where the menu opens, in physical screen px: the pointer's x and the monitor under it. */
let anchorX = 0;
let scale = 1;
let area = { x: 0, y: 0, width: 1920, height: 1080 };
/** Bumped on every open and close; a pending open whose number moved on is dropped. */
let opening = 0;
let pending = false;

export const glyph = {
  pin: [
    ["path", { d: "M12 17v5" }],
    [
      "path",
      {
        d: "M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z",
      },
    ],
  ] as readonly SvgNode[],
  unpin: [
    ["path", { d: "M12 17v5" }],
    ["path", { d: "M15 9.34V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H7.89" }],
    ["path", { d: "m2 2 20 20" }],
    ["path", { d: "M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h11" }],
  ] as readonly SvgNode[],
  window: [
    ["rect", { x: 3, y: 4, width: 18, height: 16, rx: 2.5 }],
    ["path", { d: "M3 9h18" }],
  ] as readonly SvgNode[],
  grid: [
    ["rect", { x: 3, y: 3, width: 7, height: 7, rx: 1.5 }],
    ["rect", { x: 14, y: 3, width: 7, height: 7, rx: 1.5 }],
    ["rect", { x: 3, y: 14, width: 7, height: 7, rx: 1.5 }],
    ["rect", { x: 14, y: 14, width: 7, height: 7, rx: 1.5 }],
  ] as readonly SvgNode[],
  activity: [["path", { d: "M22 12h-4l-3 9L9 3l-3 9H2" }]] as readonly SvgNode[],
  eye: [
    ["path", { d: "M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0" }],
    ["circle", { cx: 12, cy: 12, r: 3 }],
  ] as readonly SvgNode[],
  bar: [
    ["rect", { x: 2, y: 4, width: 20, height: 16, rx: 2.5 }],
    ["path", { d: "M2 15h20" }],
  ] as readonly SvgNode[],
};

function ItemIcon(props: { icon: DockMenuItem["icon"]; color: string; size?: number }) {
  const { icon } = props;
  const size = props.size ?? 16;
  if (!icon) return <View style={{ width: size, height: size }} />;
  if (typeof icon === "object" && "image" in icon) return <Image src={icon.image} width={size} height={size} fit="contain" />;
  if (typeof icon === "string") return <Icon name={icon} size={size} color={props.color} strokeWidth={2} />;
  return <Icon iconNode={icon as readonly SvgNode[]} size={size} color={props.color} strokeWidth={2} />;
}

function MenuRow(props: { item: DockMenuItem }) {
  const { item } = props;
  const color = item.danger ? "#ff6961" : ui.text;
  return (
    <Pressable
      // The action runs before the menu closes: while the menu is in front, this process may
      // still hand the foreground to the app the action opens.
      onClick={() => {
        item.onSelect();
        closeDockMenu();
      }}
      onContextMenu={
        item.onContextMenu
          ? () => {
              item.onContextMenu!();
              closeDockMenu();
            }
          : undefined
      }
      style={{
        direction: "row",
        align: "center",
        gap: 10,
        height: 34,
        padding: { left: 10, right: 10 },
        radius: 8,
        cursor: "pointer",
        hover: { background: item.danger ? "rgba(255,105,97,0.14)" : "rgba(255,255,255,0.08)" },
        active: { background: "rgba(255,255,255,0.12)" },
      }}
    >
      <ItemIcon icon={item.icon} color={item.danger ? color : "#c7c7cc"} />
      <Text size={13} color={color} style={{ flex: 1, whiteSpace: "nowrap", textOverflow: "ellipsis", overflow: "hidden" }}>
        {item.label}
      </Text>
    </Pressable>
  );
}

let lastGridClick = { item: null as DockMenuItem | null, at: 0 };

function GridCell(props: { item: DockMenuItem }) {
  const { item } = props;
  return (
    <Pressable
      onClick={() => {
        const now = Date.now();
        const double = lastGridClick.item === item && now - lastGridClick.at < 450;
        lastGridClick = { item: double ? null : item, at: now };
        if (double && item.onDoubleSelect) item.onDoubleSelect();
        else item.onSelect();
      }}
      onContextMenu={item.onContextMenu}
      style={{
        width: 40,
        height: 40,
        radius: 8,
        align: "center",
        justify: "center",
        cursor: "pointer",
        hover: { background: "rgba(255,255,255,0.08)" },
        active: { background: "rgba(255,255,255,0.12)", transform: "scale(0.94)" },
      }}
    >
      <ItemIcon icon={item.icon} color="#c7c7cc" size={20} />
    </Pressable>
  );
}

function GridPanel(props: { items: DockMenuItem[] }) {
  const rows: DockMenuItem[][] = [];
  for (let i = 0; i < props.items.length; i += 5) rows.push(props.items.slice(i, i + 5));
  return (
    <Column style={{ padding: 8, gap: 4, radius: 14, background: "#1c1c1f" }}>
      {rows.map((row, i) => (
        <Row key={i} style={{ gap: 4 }}>
          {row.map((item, j) => (
            <GridCell key={j} item={item} />
          ))}
        </Row>
      ))}
    </Column>
  );
}

function MenuView() {
  const spec = menu.spec;
  return (
    <Window
      title={MENU_TITLE}
      width={PANEL_WIDTH}
      height={420}
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
      <View style={{ flex: 1, align: "start", justify: "start" }}>
        <View onSize={({ width, height }) => resize(width, height)} style={{ shrink: 0 }}>
          {spec?.grid ? (
            <GridPanel items={spec.sections.flat()} />
          ) : spec ? (
            <Column
              style={{
                width: PANEL_WIDTH,
                padding: 6,
                gap: 2,
                radius: 14,
                background: "#1c1c1f",
              }}
            >
              <Row style={{ align: "center", gap: 10, padding: { left: 10, right: 10, top: 8, bottom: 8 } }}>
                {spec.image ? <Image src={spec.image} width={28} height={28} fit="contain" /> : null}
                <Column style={{ flex: 1, gap: 1, minWidth: 0 }}>
                  <Text
                    size={13}
                    weight={650}
                    color={ui.text}
                    style={{ whiteSpace: "nowrap", textOverflow: "ellipsis", overflow: "hidden" }}
                  >
                    {spec.title}
                  </Text>
                  {spec.subtitle ? (
                    <Text size={11} color={ui.muted}>
                      {spec.subtitle}
                    </Text>
                  ) : null}
                </Column>
              </Row>
              {spec.sections
                .filter((s) => s.length)
                .map((section, index) => (
                  <Column key={index} style={{ gap: 0 }}>
                    <View style={{ height: 1, margin: { left: 8, right: 8, top: 3, bottom: 3 }, background: "rgba(255,255,255,0.07)" }} />
                    {section.map((item, i) => (
                      <MenuRow key={i} item={item} />
                    ))}
                  </Column>
                ))}
            </Column>
          ) : null}
        </View>
      </View>
    </Window>
  );
}

function place() {
  if (!handle) return;
  const width = Math.ceil(size.width * scale);
  const height = Math.ceil(size.height * scale);
  const top = DockWindow.topEdge() ?? area.y + area.height - Math.round(80 * scale);
  const gap = Math.round(8 * scale);
  const x = Math.max(area.x + gap, Math.min(Math.round(anchorX - width / 2), area.x + area.width - width - gap));
  handle.setBounds({ x, y: top - gap - height, width, height, physical: true });
}

function resize(width: number, height: number) {
  if (width <= 0 || height <= 0) return;
  size = { width, height };
  if (menu.spec) place();
}

function screenAt(screens: ScreenInfo[], p: { x: number; y: number } | null) {
  const hit = p && screens.find((s) => p.x >= s.x && p.x < s.x + s.width && p.y >= s.y && p.y < s.y + s.height);
  return hit || screens.find((s) => s.primary) || screens[0];
}

/** Creates the menu window once, hidden, so right-clicks open it without delay. */
export async function initDockMenu(app: AppHandle) {
  handle = app.openWindow(MenuView, { id: "menu", keyboardEvents: true, closeBehavior: "hide" });
  await handle.ready;
  handle.onEvent((event) => {
    if (event.type === "keyboard" && (event as { key?: string }).key === "Escape") closeDockMenu();
  });
  // Light dismiss: the menu is activated when it opens, so a click anywhere else (another app,
  // the desktop, the dock itself) takes the focus from it. An open still waiting for the
  // screen query ignores the blur of the menu it replaces.
  handle.onFocusChange((focused) => {
    if (!focused && !pending) closeDockMenu();
  });
}

/** Opens the dock's popup menu above the pointer. */
export function showDockMenu(spec: DockMenuSpec) {
  const h = handle;
  if (!h) return;
  const ticket = ++opening;
  pending = true;
  menu.spec = spec;
  void h.screens().then(({ screens, cursor }) => {
    if (ticket !== opening) return;
    pending = false;
    const screen = screenAt(screens, cursor);
    if (screen) {
      scale = screen.scale || 1;
      area = { x: screen.x, y: screen.y, width: screen.width, height: screen.height };
    }
    anchorX = cursor?.x ?? area.x + area.width / 2;
    place();
    h.show();
    h.activate();
  });
}

export function menuOpen() {
  return !!menu.spec;
}

export function closeDockMenu() {
  opening++;
  pending = false;
  if (!menu.spec) return;
  menu.spec = null;
  handle?.hide();
}
