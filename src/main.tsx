import { createApp, requestSingleInstance, type AppHandle } from "@tarve/core";
import appIcon from "../assets/icon.png";
import { config, onConfigSaved, saveConfig } from "./config";
import { DOCK_TITLE, DockView } from "./dock/Dock";
import { dockUi } from "./dock/state";
import { setGalleryOpener } from "./dock/widget-menu";
import { GALLERY_TITLE, GalleryView, PREVIEW_PREFIX, setGalleryPage, type GalleryPage } from "./gallery/Gallery";
import { initChartPanel } from "./menu/chart-panel";
import { glyph, initDockMenu, menuOpen, showDockMenu } from "./menu/dock-menu";
import { initHoverTip } from "./menu/hover-tip";
import { hidePeek, initWidgetPeek } from "./menu/widget-peek";
import { initMediaFlyout, mediaFlyoutOpen } from "./menu/media-flyout";
import { hidePreview, initWindowPreview, previewOpen } from "./menu/window-preview";
import { DockWindow } from "./native/dock-window";
import { HSHELL, startShellEvents } from "./native/shell-events";
import { showOwnWindowOnTaskbar, windowExists } from "./native/win32";
import { probeEvents } from "./runtime/perf-probe";
import { sleep } from "./runtime/proc";
import { watchAppColor } from "./services/app-color";
import { readAutostart, setAutostart } from "./services/autostart";
import { exitApp } from "./services/exit";
import { pauseExplorerButtonsWhile } from "./services/explorer-buttons";
import { dockAlign, dockEdge, dockVertical, onTaskbarPrefsChange, watchTaskbarPrefs } from "./services/taskbar-prefs";
import { checkNow, restartToUpdate, startUpdater, updateNow, updater } from "./services/updater";
import { clearFlashing, launch, markFlashing, noteForeground, scheduleRefresh, windowGone, windowShown } from "./services/windows";
import { ui } from "./theme";
import "./widgets/builtin";
import { disposeWidget, setWidgetApp } from "./widgets/host";
import { dockRoom } from "./widgets/magnify";
import { allWidgets } from "./widgets/registry";
// A stray network error (e.g. ECONNRESET from a widget's fetch) must not take the whole dock down.
process.on("unhandledRejection", (error) => console.error("[unhandledRejection]", error));
process.on("uncaughtException", (error) => console.error("[uncaughtException]", error));

// Command-line jobs the installer runs (package.json tarve.installer), then exit:
//   --autostart on|off  the "start with Windows" entry
//   --quit              close a running dock (before installing over it or uninstalling)
const argv = process.argv.slice(2);
if (argv.includes("--autostart")) {
  const on = argv[argv.indexOf("--autostart") + 1] !== "off";
  await setAutostart(on);
  exitApp(0);
}

// One dock per user: a second launch (exe or bun start) is handed to the running one.
// requestSingleInstance waits up to ~10 s for a previous dock that is still quitting, then rejects
// when it can neither reach nor become the first instance: this process then exits.
const claimInstance = () =>
  requestSingleInstance({ id: "WindowsBar.Dock" }).catch((error: unknown) => {
    console.error("[instance]", error);
    return null;
  });
let instance = await claimInstance();
if (argv.includes("--quit")) {
  if (instance?.primary) {
    instance.release();
    exitApp(0);
  }
  // The running dock got "--quit" and closes; give it time to restore the taskbar and exit.
  for (let i = 0; i < 30 && windowExists(DOCK_TITLE); i++) await sleep(200);
  await sleep(500);
  exitApp(0);
}
// A dock that is quitting can still answer on its pipe (its window already gone): then it is not
// a running dock to hand over to, so ask again until it has let the pipe go.
for (let i = 0; instance && !instance.primary && !windowExists(DOCK_TITLE) && i < 6; i++) {
  await sleep(700);
  instance = await claimInstance();
}
if (!instance?.primary) exitApp(instance ? 0 : 1);
const primary = instance;

let dockWindow: DockWindow | undefined;
let pendingSize: [number, number] | undefined;
let entranceTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * The dock shows itself once its size and place stop changing at start (the widgets, the app list
 * and the AppBar settle within a few frames), with 1.5 s at most; until then it draws nothing.
 */
function settleEntrance() {
  if (dockUi.shown || !dockWindow) return;
  clearTimeout(entranceTimer);
  entranceTimer = setTimeout(() => (dockUi.shown = true), 160);
}
let gallery: AppHandle | undefined;

// The settings/widgets window is listed on the dock while it is open, like any app.
showOwnWindowOnTaskbar(GALLERY_TITLE);

function openGallery(page: GalleryPage = "widgets") {
  setGalleryPage(page);
  if (gallery) {
    gallery.activate();
    return;
  }
  dockUi.editing = true;
  gallery = app.openWindow(GalleryView, { id: "gallery", closeBehavior: "exit" });
  gallery.ready.then(() => gallery?.activate());
  gallery.closed.then(() => {
    gallery = undefined;
    dockUi.editing = false;
    for (const w of allWidgets()) disposeWidget(PREVIEW_PREFIX + w.type);
  });
}

function openSettings() {
  openGallery("settings");
}

/** Right-click on the bar itself, outside any widget. */
function openBarMenu() {
  hidePreview(true);
  hidePeek();
  const full = config.mode === "full";
  showDockMenu({
    title: "WindowsBar",
    subtitle: full ? "Barra inteira" : "Dock flutuante",
    sections: [
      [
        { label: "Configurações da barra…", icon: "settings", onSelect: openSettings },
        { label: "Widgets…", icon: glyph.grid, onSelect: () => openGallery() },
      ],
      [
        {
          label: full ? "Usar dock flutuante" : "Usar barra inteira",
          icon: glyph.bar,
          onSelect: () => {
            config.mode = full ? "floating" : "full";
            saveConfig();
          },
        },
        {
          label: config.hoverPreview ? "Desativar preview das janelas" : "Ativar preview das janelas",
          icon: glyph.eye,
          onSelect: () => {
            config.hoverPreview = !config.hoverPreview;
            saveConfig();
          },
        },
      ],
      [
        { label: "Configurações da barra do Windows", icon: "settings", onSelect: () => launch("ms-settings:taskbar") },
        { label: "Gerenciador de Tarefas", icon: glyph.activity, onSelect: () => launch("taskmgr.exe") },
      ],
      [{ label: "Sair do WindowsBar", icon: "x", danger: true, onSelect: () => app.close() }],
    ],
  });
}

const app = createApp(
  () => (
    <DockView
      onContextMenu={openBarMenu}
      onSize={(width, height) => {
        if (dockWindow) dockWindow.setContentSize(width, height);
        else pendingSize = [width, height];
        settleEntrance();
      }}
    />
  ),
  {
    renderer: "auto",
    appIdentity: { id: "WindowsBar.Dock", name: "WindowsBar", icon: appIcon },
    icon: appIcon,
    closeBehavior: "exit",
    onError: ({ error, source }) => console.error(`[${source}]`, error),
  },
);
setWidgetApp(app);
primary.onSecondInstance(({ args }) => {
  if (args.includes("--quit")) {
    app.close();
  }
  else if (args.includes("--settings")) openSettings();
  else if (args.includes("--update")) void updateNow();
  else openGallery();
});
// The registry is the truth for "start with Windows" (the user may have changed it elsewhere).
void readAutostart().then((on) => {
  if (config.autostart !== on) config.autostart = on;
});
setGalleryOpener(() => openGallery());

await app.ready;
probeEvents("dock", app);

watchTaskbarPrefs();
/**
 * Covers the 1–2 px frame line of the app above the strip. Constant while the strip is on, also
 * while no colour is known yet, so the dock never shifts when the colour comes and goes.
 */
export const stripOverlap = () => (config.mode === "floating" && config.reserveSpace && config.stripFollowsApp && dockEdge() === "bottom" ? 2 : 0);

const nativeOptions = () => ({
  mode: config.mode,
  align: dockAlign(),
  reserveSpace: config.reserveSpace,
  hideNativeTaskbar: config.hideNativeTaskbar,
  bottomMargin: config.bottomMargin,
  barHeight: ui.dock.height,
  stripOverlap: stripOverlap(),
  edge: dockEdge(),
});
dockWindow = DockWindow.attach(app, nativeOptions());
// The logical length of the dock's edge of its monitor (its width, or height on a side edge): the room the dock may take.
const followScreen = () =>
  void app.screen().then((screen) => {
    const width = screen ? (dockVertical() ? screen.height : screen.width) / screen.scale : 0;
    if (width && Math.abs(dockRoom.screen - width) > 0.5) dockRoom.screen = width;
  });
followScreen();
app.onScreensChange(followScreen);
if (pendingSize) dockWindow.setContentSize(...pendingSize);
settleEntrance();
setTimeout(() => (dockUi.shown = true), 1500);
// The foreground window's moves, coalesced: at most one check per 50 ms, and always one after the
// last move, so the final size of an F11 or a game switching to full screen is never missed.
let moveTimer: ReturnType<typeof setTimeout> | undefined;
let movePending = false;
const onForegroundMoved = () => {
  if (moveTimer) {
    movePending = true;
    return;
  }
  dockWindow?.checkFullscreen();
  moveTimer = setTimeout(() => {
    moveTimer = undefined;
    if (!movePending) return;
    movePending = false;
    onForegroundMoved();
  }, 50);
};
// Shell events: full-screen notices, window lifecycle, attention requests. No polling needed.
startShellEvents((event) => {
  if (event.type === "fullscreen") return dockWindow?.setShellFullscreen(event.on);
  if (event.type === "moved") return onForegroundMoved();
  if (event.type === "foreground") {
    dockWindow?.checkFullscreen();
    noteForeground(event.hwnd);
    clearFlashing(event.hwnd);
    return scheduleRefresh();
  }
  if (event.type === "windowState") return scheduleRefresh();
  if (event.type !== "shell") return;
  switch (event.code) {
    case HSHELL.FLASH:
      return markFlashing(event.hwnd);
    case HSHELL.WINDOWACTIVATED:
    case HSHELL.RUDEAPPACTIVATED:
      clearFlashing(event.hwnd);
      dockWindow?.checkFullscreen();
      return scheduleRefresh();
    case HSHELL.WINDOWCREATED:
      return windowShown(event.hwnd);
    case HSHELL.WINDOWDESTROYED:
      return windowGone(event.hwnd);
    case HSHELL.REDRAW:
      return scheduleRefresh();
  }
});

watchAppColor(
  () => DockWindow.handle(),
  () => config.mode === "floating" && config.reserveSpace && config.stripFollowsApp,
  () => previewOpen() || menuOpen() || mediaFlyoutOpen(),
);
// Reading Explorer's buttons blocks the loop for a moment (UIA): not while a flyout is open.
pauseExplorerButtonsWhile(() => previewOpen() || menuOpen() || mediaFlyoutOpen());
await initDockMenu(app);
await initWindowPreview(app);
await initHoverTip(app);
await initWidgetPeek(app);
await initMediaFlyout(app);
await initChartPanel(app);

// Settings changed in the gallery (saved) or in Windows (taskbar alignment, height) apply to the
// native window right away; nothing is polled.
let applied = JSON.stringify(nativeOptions());
const applyNative = () => {
  const next = JSON.stringify(nativeOptions());
  if (next === applied) return;
  applied = next;
  dockWindow?.update(nativeOptions());
};
onConfigSaved(applyNative);
onTaskbarPrefsChange(applyNative);
// A new edge turns the room along it from the screen's width to its height or back.
onTaskbarPrefsChange(followScreen);

app.tray({
  tooltip: "WindowsBar",
  onClick: () => openGallery(),
  menu: [
    { id: "settings", label: "Configurações…", onSelect: openSettings },
    { id: "widgets", label: "Widgets…", onSelect: () => openGallery() },
    { id: "update", label: "Procurar atualizações", onSelect: () => (updater.status === "ready" ? restartToUpdate() : void checkNow()) },
    { type: "separator" },
    { id: "quit", label: "Sair", onSelect: () => app.close() },
  ],
});

if (process.argv.includes("--widgets")) openGallery();
if (process.argv.includes("--settings")) openSettings();

startUpdater();

await app.closed;
dockWindow.dispose();
await dockWindow.settleTaskbar();
exitApp(0);
