import { createApp, requestSingleInstance, type AppHandle } from "@tarve/core";
import { config, saveConfig } from "./config";
import { ui } from "./theme";
import { DOCK_TITLE, DockView } from "./dock/Dock";
import { dockUi } from "./dock/state";
import { GALLERY_TITLE, GalleryView, PREVIEW_PREFIX, setGalleryPage, type GalleryPage } from "./gallery/Gallery";
import { showOwnWindowOnTaskbar, windowExists } from "./native/win32";
import { glyph, initDockMenu, menuOpen, showDockMenu } from "./menu/dock-menu";
import { hidePreview, initWindowPreview, previewOpen } from "./menu/window-preview";
import { initHoverTip } from "./menu/hover-tip";
import { clearFlashing, launch, markFlashing, noteForeground, scheduleRefresh } from "./services/windows";
import { HSHELL, startShellEvents } from "./native/shell-events";
import { DockWindow } from "./native/dock-window";
import { setGalleryOpener } from "./dock/widget-menu";
import { dockAlign, watchTaskbarPrefs } from "./services/taskbar-prefs";
import { readAutostart, setAutostart } from "./services/autostart";
import { checkNow, restartToUpdate, startUpdater, updateNow, updater } from "./services/updater";
import { watchAppColor, appColor } from "./services/app-color";
import { disposeWidget, setWidgetApp } from "./widgets/host";
import { allWidgets } from "./widgets/registry";
import { exitApp } from "./services/exit";
import "./widgets/builtin";
import appIcon from "../assets/icon.png";

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
let instance = await requestSingleInstance({ id: "WindowsBar.Dock" });
if (argv.includes("--quit")) {
  if (instance.primary) {
    instance.release();
    exitApp(0);
  }
  // The running dock got "--quit" and closes; give it time to restore the taskbar and exit.
  for (let i = 0; i < 30 && windowExists(DOCK_TITLE); i++) await Bun.sleep(200);
  await Bun.sleep(500);
  exitApp(0);
}
// Right after a dock was killed its pipe can still answer for a few seconds, longer than the
// ~2.5 s requestSingleInstance retries (seen with 0.13.0): with no dock on screen, ask again.
for (let i = 0; !instance.primary && !windowExists(DOCK_TITLE) && i < 6; i++) {
  await Bun.sleep(700);
  instance = await requestSingleInstance({ id: "WindowsBar.Dock" });
}
if (!instance.primary) exitApp(0);

let dockWindow: DockWindow | undefined;
let pendingSize: [number, number] | undefined;
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
      }}
    />
  ),
  {
    appIdentity: { id: "WindowsBar.Dock", name: "WindowsBar", icon: appIcon },
      icon: appIcon,
    closeBehavior: "exit",
    onError: ({ error, source }) => console.error(`[${source}]`, error),
  },
);
setWidgetApp(app);
instance.onSecondInstance(({ args }) => {
  if (args.includes("--quit")) app.close();
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

watchTaskbarPrefs();
/**
 * Covers the 1–2 px frame line of the app above the strip. Constant while the strip is on, also
 * while no colour is known yet, so the dock never shifts when the colour comes and goes.
 */
export const stripOverlap = () => (config.mode === "floating" && config.reserveSpace && config.stripFollowsApp ? 2 : 0);

const nativeOptions = () => ({
  mode: config.mode,
  align: dockAlign(),
  reserveSpace: config.reserveSpace,
  hideNativeTaskbar: config.hideNativeTaskbar,
  bottomMargin: config.bottomMargin,
  barHeight: ui.dock.height,
  stripOverlap: stripOverlap(),
});
dockWindow = DockWindow.attach(app, nativeOptions());
if (pendingSize) dockWindow.setContentSize(...pendingSize);
// Shell events: full-screen notices, window lifecycle, attention requests. No polling needed.
startShellEvents((event) => {
  if (event.type === "fullscreen") return dockWindow?.setShellFullscreen(event.on);
  if (event.type === "foreground" || event.type === "moved") {
    dockWindow?.checkFullscreen();
    if (event.type === "foreground") {
      noteForeground(event.hwnd);
      clearFlashing(event.hwnd);
      scheduleRefresh();
    }
    return;
  }
  switch (event.code) {
    case HSHELL.FLASH:
      return markFlashing(event.hwnd);
    case HSHELL.WINDOWACTIVATED:
    case HSHELL.RUDEAPPACTIVATED:
      clearFlashing(event.hwnd);
      dockWindow?.checkFullscreen();
      return scheduleRefresh();
    case HSHELL.WINDOWCREATED:
    case HSHELL.WINDOWDESTROYED:
    case HSHELL.REDRAW:
      return scheduleRefresh();
  }
});

watchAppColor(
  () => DockWindow.handle(),
  () => config.mode === "floating" && config.reserveSpace && config.stripFollowsApp,
  () => previewOpen() || menuOpen(),
);
await initDockMenu(app);
await initWindowPreview(app);
await initHoverTip(app);

// Settings changed in the gallery apply to the native window right away.
let applied = JSON.stringify(nativeOptions());
setInterval(() => {
  const next = JSON.stringify(nativeOptions());
  if (next === applied) return;
  applied = next;
  dockWindow?.update(nativeOptions());
}, 300);

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
exitApp(0);
