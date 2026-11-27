import { Image, Pressable, View, store, type Style } from "@tarve/core";
import { showDockMenu, type DockMenuItem } from "../../menu/dock-menu";
import { openRunDialog, openStartMenu, openUri, signOut, sleep, toggleDesktop } from "../../native/desktop";
import { exePathOf, foregroundWindow, windowPid } from "../../native/win32";
import { launch } from "../../services/windows";
import { darken, devicePx, ui } from "../../theme";
import { dockVertical, taskbarPrefs } from "../../services/taskbar-prefs";
import { WindowsLogo, axisBox, iconHover, windowsHighlight } from "../ui";
import { defineWidget } from "../types";
import { dockIndex, dockMetrics, magnifying, magnifyStyles } from "../magnify";
import { run as runProcess } from "../../runtime/proc";
import { followForeground } from "../../native/shell-events";

import { t } from "../../i18n";
/** Segoe Fluent Icons characters, as Windows draws these entries' icons. */
const glyphs = {
  apps: { fluent: 0xe74c },
  power: { fluent: 0xe7e8 },
  restart: { fluent: 0xe777 },
  moon: { fluent: 0xe708 },
  logout: { fluent: 0xf3b1 },
  terminal: { fluent: 0xe756 },
  shield: { fluent: 0xea18 },
  monitor: { fluent: 0xe7f8 },
  disk: { fluent: 0xeda2 },
  network: { fluent: 0xe968 },
  battery: { fluent: 0xe83f },
  list: { fluent: 0xe71d },
  chip: { fluent: 0xe950 },
  activity: { fluent: 0xe9d9 },
  run: { fluent: 0xe768 },
  desktop: { fluent: 0xe7f4 },
};

/** The processes that draw the Start menu (and its search) on Windows 11. */
const START_HOSTS = /\\(SearchHost|StartMenuExperienceHost|SearchApp)\.exe$/i;

const isStartHost = (hwnd: ReturnType<typeof foregroundWindow>) => !!hwnd && START_HOSTS.test(exePathOf(windowPid(hwnd)));

/** Whether Start is open now: it re-renders the button's highlight. */
const startUi = store({ open: isStartHost(foregroundWindow()) });

/** Whether the Start menu is, or just was, in front (from foreground events). */
const start = followForeground(
  (hwnd) => isStartHost(hwnd as unknown as ReturnType<typeof foregroundWindow>),
  foregroundWindow() as number | null,
  (open) => (startUi.open = open),
);

/** "#rrggbb" from what the user typed (with or without the #), or `fallback` when it is not one. */
function hexColor(value: unknown, fallback: string) {
  const v = String(value ?? "").trim().replace(/^#/, "");
  return /^[0-9a-f]{6}$/i.test(v) ? `#${v}` : fallback;
}

/** The Windows 11 Start logo's blue, light at the top-left to deep at the bottom-right. */
const WIN11_GRADIENT = ["#5ccdf9", "#0a6cd4"] as const;

/**
 * The Start button toggles the Start menu, as on the taskbar. Clicking the dock takes the focus,
 * which closes an open Start menu before this runs, so a plain Win tap would open it again:
 * when Start was in front just before the click, the click only closes it.
 */
function toggleStart() {
  // Pressing the dock closed it a moment ago (or it is still closing).
  if (isStartHost(foregroundWindow()) || start.recently(500)) {
    // Still open: the same SC_TASKLIST command closes it, as a second press of the Start button.
    if (isStartHost(foregroundWindow())) openStartMenu();
    start.reset();
    return;
  }
  openStartMenu();
}

/** Runs shutdown.exe hidden (restart and shut down need its shutdown privilege handling). */
function run(...args: string[]) {
    runProcess(args);
}

/** The Windows "power user" menu (Win+X), as right-clicking the Start button shows it. */
export function showStartMenu() {
  const tools: DockMenuItem[] = [
    { label: t("widgets.start.installedApps"), icon: glyphs.apps, onSelect: () => launch("ms-settings:appsfeatures") },
    { label: t("widgets.start.powerOptions"), icon: glyphs.battery, onSelect: () => launch("ms-settings:powersleep") },
    { label: t("widgets.start.eventViewer"), icon: glyphs.list, onSelect: () => launch("eventvwr.msc") },
    { label: t("widgets.start.system"), icon: glyphs.monitor, onSelect: () => launch("ms-settings:about") },
    { label: t("widgets.start.deviceManager"), icon: glyphs.chip, onSelect: () => launch("devmgmt.msc") },
    { label: t("widgets.start.networkConnections"), icon: glyphs.network, onSelect: () => launch("ms-settings:network") },
    { label: t("widgets.start.diskManagement"), icon: glyphs.disk, onSelect: () => launch("diskmgmt.msc") },
    { label: t("widgets.start.computerManagement"), icon: glyphs.chip, onSelect: () => launch("compmgmt.msc") },
    { label: "Terminal", icon: glyphs.terminal, onSelect: () => launch("wt.exe") },
    {
      label: "Terminal (Admin)",
      icon: glyphs.shield,
      // The shell's "runas" verb: the UAC prompt, as "Executar como administrador".
      onSelect: () => openUri("wt.exe", undefined, "runas"),
    },
  ];
  const shell: DockMenuItem[] = [
    { label: t("widgets.start.taskManager"), icon: glyphs.activity, onSelect: () => launch("taskmgr.exe") },
    { label: t("widgets.start.settings"), icon: "settings", onSelect: () => launch("ms-settings:") },
    { label: t("widgets.start.fileExplorer"), icon: "folder", onSelect: () => launch("explorer.exe") },
    { label: t("widgets.start.search"), icon: "search", onSelect: openStartMenu },
    { label: t("widgets.start.run"), icon: glyphs.run, onSelect: openRunDialog },
  ];
  // "Desligar ou sair" is a submenu on Windows; the dock menu lists its entries.
  const power: DockMenuItem[] = [
    { label: t("widgets.start.signOut"), icon: glyphs.logout, onSelect: signOut },
    { label: t("widgets.start.sleep"), icon: glyphs.moon, onSelect: sleep },
    { label: t("widgets.start.restart"), icon: glyphs.restart, onSelect: () => run("shutdown.exe", "/r", "/t", "0") },
    // Start's "Desligar" keeps Fast Startup (a hybrid shutdown) when it is on.
    { label: t("widgets.start.shutDown"), icon: glyphs.power, danger: true, onSelect: () => run("shutdown.exe", "/s", "/hybrid", "/t", "0") },
  ];
  const desktop: DockMenuItem[] = [{ label: t("widgets.start.desktop"), icon: glyphs.desktop, onSelect: () => toggleDesktop() }];
  showDockMenu({ title: t("widgets.start.start"), subtitle: t("widgets.start.quickLinkMenu"), sections: [tools, shell, power, desktop] });
}

export default defineWidget({
  type: "start",
  name: t("widgets.start.start"),
  description: t("widgets.start.opensWindowsStartMenu"),
  category: "system",
  defaultConfig: {
    look: "tile",
    logo: "windows",
    image: "",
    logoSize: "medium",
    logoColor: "white",
    logoHex: "",
    cardColor: "graphite",
    cardHex: "",
    cardShape: "rounded",
    animation: "windows",
    openHighlight: true,
  },
  settings: [
    {
      kind: "choice",
      key: "look",
      label: t("widgets.start.style"),
      description: t("widgets.start.windowsJustLogoLike"),
      options: [
        { value: "tile", label: t("widgets.start.tile") },
        { value: "windows", label: "Windows" },
      ],
    },
    {
      kind: "choice",
      key: "logo",
      label: t("widgets.start.icon"),
      options: [
        { value: "windows", label: t("widgets.start.windowsLogo") },
        { value: "image", label: t("widgets.start.customImage") },
      ],
    },
    {
      kind: "file",
      key: "image",
      label: t("widgets.start.image"),
      description: t("widgets.start.pngIcoSvgJpeg"),
      filters: [{ name: t("widgets.start.images"), extensions: ["png", "ico", "svg", "jpg", "jpeg", "webp"] }],
      when: (c) => c.logo === "image",
    },
    {
      kind: "choice",
      key: "logoSize",
      label: t("widgets.start.size"),
      options: [
        { value: "small", label: t("widgets.start.small") },
        { value: "medium", label: t("widgets.start.medium") },
        { value: "large", label: t("widgets.start.large") },
        { value: "max", label: t("widgets.start.maximum") },
      ],
    },
    {
      kind: "choice",
      key: "logoColor",
      label: t("widgets.start.logoColor"),
      options: [
        { value: "white", label: t("widgets.start.white") },
        { value: "gradient", label: t("widgets.start.windows11Gradient") },
        { value: "blue", label: t("widgets.start.windowsBlue") },
        { value: "accent", label: t("widgets.start.accentColor") },
        { value: "custom", label: t("widgets.start.custom") },
      ],
      when: (c) => c.logo !== "image",
    },
    {
      kind: "text",
      key: "logoHex",
      label: t("widgets.start.customLogoColor"),
      description: "Hexadecimal, como #ff8800.",
      placeholder: "#ff8800",
      when: (c) => c.logo !== "image" && c.logoColor === "custom",
    },
    {
      kind: "choice",
      key: "cardColor",
      label: t("widgets.start.tileBackground"),
      options: [
        { value: "graphite", label: t("widgets.start.graphite") },
        { value: "accent", label: t("widgets.start.accentColor") },
        { value: "blue", label: t("widgets.start.blue") },
        { value: "glass", label: t("widgets.start.glass") },
        { value: "custom", label: t("widgets.start.custom2") },
      ],
      when: (c) => c.look !== "windows",
    },
    {
      kind: "text",
      key: "cardHex",
      label: t("widgets.start.customTileColor"),
      description: "Hexadecimal, como #202020.",
      placeholder: "#202020",
      when: (c) => c.look !== "windows" && c.cardColor === "custom",
    },
    {
      kind: "choice",
      key: "cardShape",
      label: t("widgets.start.tileShape"),
      options: [
        { value: "rounded", label: t("widgets.start.rounded") },
        { value: "square", label: t("widgets.start.square") },
        { value: "circle", label: t("widgets.start.circle") },
      ],
      when: (c) => c.look !== "windows",
    },
    {
      kind: "choice",
      key: "animation",
      label: t("widgets.start.animation"),
      description: t("widgets.start.windows11LightBackground"),
      options: [
        { value: "windows", label: "Windows 11" },
        { value: "dock", label: t("widgets.start.apps") },
        { value: "none", label: t("widgets.start.none") },
      ],
    },
    { kind: "toggle", key: "openHighlight", label: t("widgets.start.highlightWhileStartIs"), description: t("widgets.start.lightBackgroundBehindButton") },
  ],
  setup() {
    return {};
  },
  View({ ctx }) {
    // Same slot and icon size as the app icons, so it lines up with them.
    const magnify = magnifyStyles("dock", dockIndex(ctx.instanceId, 0), dockMetrics());
    const c = ctx.config;
    const tile = c.look !== "windows";
    // Share of the icon box the logo fills; on the card it keeps a margin to the card's edge.
    const sizes = tile ? { small: 0.47, medium: 0.6, large: 0.72, max: 0.82 } : { small: 0.6, medium: 0.75, large: 0.88, max: 1 };
    const share = sizes[c.logoSize as keyof typeof sizes] ?? sizes.medium;
    const px = devicePx(magnify.size * share, true);
    const accent = taskbarPrefs.accent;
    const color =
      c.logoColor === "blue" ? "#4cc2ff" : c.logoColor === "accent" ? accent : c.logoColor === "custom" ? hexColor(c.logoHex, "#e9e9ee") : "#e9e9ee";
    const card = !tile
      ? undefined
      : c.cardColor === "accent"
        ? `linear-gradient(160deg, ${accent}, ${darken(accent, 0.3)})`
        : c.cardColor === "blue"
          ? "linear-gradient(160deg, #2b88e0, #0d4a99)"
          : c.cardColor === "glass"
            ? "rgba(255,255,255,0.1)"
            : c.cardColor === "custom"
              ? hexColor(c.cardHex, "#2a2a2f")
              : "linear-gradient(160deg, #3a3a40, #1b1b1f)";
    const radius = !tile ? 8 : c.cardShape === "circle" ? magnify.size / 2 : c.cardShape === "square" ? devicePx(3) : 8;
    const image = c.logo === "image" && typeof c.image === "string" && c.image ? c.image : "";
    // Windows 11's Start button neither grows nor lifts: hovered it shows the plate, pressed the logo
    // shrinks and springs back. "dock" takes the app icons' hover and press effect instead.
    const effect = c.animation === "dock" || c.animation === "none" ? c.animation : "windows";
    const hover = effect === "dock" ? iconHover({ magnified: true, plate: true }) : {};
    // The plate answers the hover with Windows 11's own animation, or with the apps' "Realce do Windows".
    const plateHover = effect === "windows" || (effect === "dock" && windowsHighlight());
    // The plate behind the logo, where the taskbar draws an app's plate: on hover and while Start is open.
    // The macOS effect draws none, as for the apps: the plate keeps the slot's resting size and place
    // while the logo grows and its slot widens, so the logo would spill off it to one side.
    const inset = (ui.app.slot - ui.app.plate) / 2;
    const plate = dockVertical()
      ? { left: 0, top: inset, width: ui.tile.height, height: ui.app.plate }
      : { top: 0, left: inset, width: ui.app.plate, height: ui.tile.height };
    const open = c.openHighlight !== false && startUi.open;
    const reach = Math.max(0, (ui.dock.height - ui.tile.height) / 2);
    const glyph = image ? (
      <Image src={image} width={px} height={px} fit="contain" style={{ radius: 0 }} />
    ) : (
      <WindowsLogo size={px} color={color} gradient={c.logoColor === "gradient" ? WIN11_GRADIENT : undefined} />
    );
    // The plate sits outside the pressed box, so a press shrinks the logo and leaves the plate in place.
    const press: Style =
      effect === "windows" ? { transition: { transform: { duration: 280, easing: "spring" } }, active: { transform: "scale(0.85)" } } : hover;
    return (
      <View style={{ position: "relative", ...axisBox(ui.app.slot, ui.tile.height), shrink: 0, group: true, ...magnify.slot }}>
        {magnifying() ? null : (
          <View
            style={{
              position: "absolute",
              ...plate,
              radius: devicePx(8),
              background: open ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0)",
              borderWidth: 1,
              borderColor: open ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0)",
              transition: { background: { duration: 120, easing: "easeOut" }, borderColor: { duration: 120, easing: "easeOut" } },
              ...(plateHover && !open ? { groupHover: { background: "rgba(255,255,255,0.06)", borderColor: "rgba(255,255,255,0.04)" } } : {}),
            }}
          />
        )}
        <Pressable
          focusable={false}
          onClick={toggleStart}
          onContextMenu={showStartMenu}
          // Over the bar's whole height (Fitts's law, as HitReach does for the apps), so every press lands on
          // this box itself and its `active` style runs; centred on the slot, it shrinks the logo in place.
          style={{
            position: "absolute",
            ...(dockVertical() ? { left: -reach, right: -reach, top: 0, bottom: 0 } : { top: -reach, bottom: -reach, left: 0, right: 0 }),
            radius: 10,
            align: "center",
            justify: "center",
            cursor: "pointer",
            ...press,
          }}
        >
          {/* The slot's own box inside the taller press box; the logo grows up from its bottom edge with the macOS effect. */}
          <View style={{ position: "absolute", ...(dockVertical() ? { top: 0, bottom: 0, left: reach, width: ui.tile.height } : { left: 0, right: 0, top: reach, height: ui.tile.height }) }}>
            <View style={magnify.box}>
              <View style={{ radius, align: "center", justify: "center", background: card, ...magnify.icon }}>
                {glyph}
              </View>
            </View>
          </View>
        </Pressable>
      </View>
    );
  },
});
