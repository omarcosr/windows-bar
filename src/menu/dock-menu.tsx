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
  type SvgNode,
} from "@tarve/core";
import { DockWindow } from "../native/dock-window";
import {
  cursorPos,
  dpiOf,
  findWindow,
  foregroundWindow,
  keyDown,
  monitorOf,
  moveWindow,
  stripWindowChrome,
  windowRect,
  type HWND,
} from "../native/win32";
import { ui } from "../theme";

export interface DockMenuItem {
  label: string;
  /** A built-in icon name, a Lucide-style node list, or an image path. */
  icon?: IconName | readonly SvgNode[] | { image: string };
  danger?: boolean;
  onSelect: () => void;
}

export interface DockMenuSpec {
  title: string;
  subtitle?: string;
  image?: string;
  sections: DockMenuItem[][];
}

const MENU_TITLE = "WindowsBar Menu";
const PANEL_WIDTH = 288;

const menu = store({ spec: null as DockMenuSpec | null });

let handle: AppHandle | undefined;
let hwnd: HWND | null = null;
let size = { width: PANEL_WIDTH, height: 200 };
let anchorX = 0;
let openedAt = 0;
let watch: ReturnType<typeof setInterval> | undefined;

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

function ItemIcon(props: { icon: DockMenuItem["icon"]; color: string }) {
  const { icon } = props;
  if (!icon) return <View style={{ width: 16, height: 16 }} />;
  if (typeof icon === "object" && "image" in icon) return <Image src={icon.image} width={16} height={16} fit="contain" />;
  if (typeof icon === "string") return <Icon name={icon} size={16} color={props.color} strokeWidth={2} />;
  return <Icon iconNode={icon as readonly SvgNode[]} size={16} color={props.color} strokeWidth={2} />;
}

function MenuRow(props: { item: DockMenuItem }) {
  const { item } = props;
  const color = item.danger ? "#ff6961" : ui.text;
  return (
    <Pressable
      onClick={() => {
        closeDockMenu();
        item.onSelect();
      }}
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
      position={{ x: -4000, y: -4000 }}
      theme={darkTheme}
      style={{ background: "rgba(0,0,0,0)" }}
    >
      <View style={{ flex: 1, align: "start", justify: "start" }}>
        <View onSize={({ width, height }) => resize(width, height)} style={{ shrink: 0 }}>
          {spec ? (
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
  if (!hwnd) return;
  const scale = dpiOf(hwnd) / 96;
  const width = Math.ceil(size.width * scale);
  const height = Math.ceil(size.height * scale);
  const { monitor } = monitorOf(hwnd);
  const top = DockWindow.topEdge() ?? monitor.bottom - 80;
  const gap = Math.round(8 * scale);
  const x = Math.max(monitor.left + gap, Math.min(anchorX - width / 2, monitor.right - width - gap));
  moveWindow(hwnd, x, top - gap - height, width, height);
}

function resize(width: number, height: number) {
  if (width <= 0 || height <= 0) return;
  size = { width, height };
  if (menu.spec) place();
}

/** Creates the menu window once, hidden, so right-clicks open it without delay. */
export async function initDockMenu(app: AppHandle) {
  handle = app.openWindow(MenuView, { id: "menu", keyboardEvents: true, closeBehavior: "hide" });
  await handle.ready;
  for (let i = 0; i < 50 && !hwnd; i++) {
    hwnd = findWindow(MENU_TITLE);
    if (!hwnd) await Bun.sleep(40);
  }
  if (hwnd) stripWindowChrome(hwnd);
  handle.hide();
  handle.onEvent((event) => {
    if (event.type === "keyboard" && (event as { key?: string }).key === "Escape") closeDockMenu();
  });
}

/** Opens the dock's popup menu above the pointer. */
export function showDockMenu(spec: DockMenuSpec) {
  if (!handle || !hwnd) return;
  menu.spec = spec;
  anchorX = cursorPos().x;
  place();
  handle.show();
  handle.activate();
  openedAt = Date.now();
  const startForeground = foregroundWindow();
  clearInterval(watch);
  // Light dismiss, without relying on the menu getting focus: a press outside it, Esc, or
  // another app coming to the front closes it.
  watch = setInterval(() => {
    if (!hwnd || Date.now() - openedAt < 150) return;
    const fg = foregroundWindow();
    if (fg !== hwnd && fg !== startForeground && fg !== DockWindow.handle()) return closeDockMenu();
    if (keyDown(0x1b)) return closeDockMenu();
    if (keyDown(0x01) || keyDown(0x02) || keyDown(0x04)) {
      const p = cursorPos();
      const r = windowRect(hwnd);
      if (p.x < r.left || p.x >= r.right || p.y < r.top || p.y >= r.bottom) closeDockMenu();
    }
  }, 50);
}

export function menuOpen() {
  return !!menu.spec;
}

export function closeDockMenu() {
  clearInterval(watch);
  watch = undefined;
  if (!menu.spec) return;
  menu.spec = null;
  handle?.hide();
}
