import { createApp, requestSingleInstance, type AppHandle } from "@tarve/core";
import { config, saveConfig } from "./config";
import { DOCK_TITLE, DockView } from "./dock/Dock";
import { dockUi } from "./dock/state";
import { GalleryView, PREVIEW_PREFIX } from "./gallery/Gallery";
import { glyph, initDockMenu, showDockMenu } from "./menu/dock-menu";
import { hidePreview, initWindowPreview } from "./menu/window-preview";
import { launch } from "./services/windows";
import { DockWindow } from "./native/dock-window";
import { findWindow } from "./native/win32";
import { taskbarPrefs, watchTaskbarPrefs } from "./services/taskbar-prefs";
import { appColor, watchAppColor } from "./services/app-color";
import { disposeWidget, setWidgetApp } from "./widgets/host";
import { allWidgets } from "./widgets/registry";
import "./widgets/builtin";

// One dock per user: a second launch (exe or bun start) opens the gallery of the running one.
let instance = await requestSingleInstance({ id: "WindowsBar.Dock" });
// Right after a dock is killed its pipe can still answer for a moment; without a dock window
// there is nobody to hand over to, so wait for the pipe to go and take over.
if (!instance.primary) await Bun.sleep(700);
for (let i = 0; !instance.primary && !findWindow(DOCK_TITLE) && i < 10; i++) {
  await Bun.sleep(500);
  instance = await requestSingleInstance({ id: "WindowsBar.Dock" });
}
if (!instance.primary) process.exit(0);

let dockWindow: DockWindow | undefined;
let pendingSize: [number, number] | undefined;
let gallery: AppHandle | undefined;

function openGallery() {
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

/** Right-click on the bar itself, outside any widget. */
function openBarMenu() {
  hidePreview(true);
  const full = config.mode === "full";
  showDockMenu({
    title: "WindowsBar",
    subtitle: full ? "Barra inteira" : "Dock flutuante",
    sections: [
      [{ label: "Widgets e personalização…", icon: glyph.grid, onSelect: openGallery }],
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
        { label: "Configurações da barra de tarefas", icon: "settings", onSelect: () => launch("ms-settings:taskbar") },
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
    appIdentity: { id: "WindowsBar.Dock", name: "WindowsBar" },
    closeBehavior: "exit",
    onError: ({ error, source }) => console.error(`[${source}]`, error),
  },
);
setWidgetApp(app);
instance.onSecondInstance(() => openGallery());

await app.ready;

watchTaskbarPrefs();
const nativeOptions = () => ({
  mode: config.mode,
  align: taskbarPrefs.align,
  reserveSpace: config.reserveSpace,
  stripFill: config.stripFollowsApp,
  stripOverlap: appColor.color ? 2 : 0,
  hideNativeTaskbar: config.hideNativeTaskbar,
  bottomMargin: config.bottomMargin,
});
dockWindow = await DockWindow.attach({ title: DOCK_TITLE, ...nativeOptions() });
if (pendingSize) dockWindow.setContentSize(...pendingSize);
watchAppColor(
  () => DockWindow.handle(),
  () => config.mode === "floating" && config.reserveSpace && config.stripFollowsApp,
);
await initDockMenu(app);
await initWindowPreview(app);

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
  onClick: openGallery,
  menu: [
    { id: "widgets", label: "Widgets…", onSelect: openGallery },
    { type: "separator" },
    { id: "quit", label: "Sair", onSelect: () => app.close() },
  ],
});

if (process.argv.includes("--widgets")) openGallery();

await app.closed;
dockWindow.dispose();
process.exit(0);
