import { Pressable, View, type SvgNode } from "@tarve/core";
import { showDockMenu, type DockMenuItem } from "../../menu/dock-menu";
import { openRunDialog, openStartMenu, openUri, signOut, sleep, toggleDesktop } from "../../native/desktop";
import { exePathOf, foregroundWindow, tapKey, windowPid } from "../../native/win32";
import { launch } from "../../services/windows";
import { ui } from "../../theme";
import { WindowsLogo, iconHover } from "../ui";
import { defineWidget } from "../types";
import { dockIndex, dockMetrics, magnifyStyles } from "../magnify";
import { run as runProcess } from "../../runtime/proc";

const icon = (...nodes: SvgNode[]) => nodes as readonly SvgNode[];
const glyphs = {
  apps: icon(
    ["rect", { x: 3, y: 3, width: 7, height: 7, rx: 1.5 }],
    ["rect", { x: 14, y: 3, width: 7, height: 7, rx: 1.5 }],
    ["rect", { x: 3, y: 14, width: 7, height: 7, rx: 1.5 }],
    ["path", { d: "M14 17.5h7M17.5 14v7" }],
  ),
  power: icon(["path", { d: "M12 2v10" }], ["path", { d: "M18.4 6.6a9 9 0 1 1-12.77.04" }]),
  restart: icon(["path", { d: "M3 12a9 9 0 1 0 3-6.7L3 8" }], ["path", { d: "M3 3v5h5" }]),
  moon: icon(["path", { d: "M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" }]),
  logout: icon(["path", { d: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" }], ["path", { d: "m16 17 5-5-5-5M21 12H9" }]),
  terminal: icon(["path", { d: "m4 17 6-6-6-6M12 19h8" }]),
  shield: icon([
    "path",
    {
      d: "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z",
    },
  ]),
  monitor: icon(["rect", { x: 2, y: 3, width: 20, height: 14, rx: 2 }], ["path", { d: "M8 21h8M12 17v4" }]),
  disk: icon(
    ["ellipse", { cx: 12, cy: 5, rx: 9, ry: 3 }],
    ["path", { d: "M3 5v14a9 3 0 0 0 18 0V5" }],
    ["path", { d: "M3 12a9 3 0 0 0 18 0" }],
  ),
  network: icon(
    ["rect", { x: 16, y: 16, width: 6, height: 6, rx: 1 }],
    ["rect", { x: 2, y: 16, width: 6, height: 6, rx: 1 }],
    ["rect", { x: 9, y: 2, width: 6, height: 6, rx: 1 }],
    ["path", { d: "M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3M12 12V8" }],
  ),
  battery: icon(["rect", { x: 2, y: 7, width: 16, height: 10, rx: 2 }], ["path", { d: "M22 11v2" }]),
  list: icon(["path", { d: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" }]),
  chip: icon(
    ["rect", { x: 5, y: 5, width: 14, height: 14, rx: 2 }],
    ["path", { d: "M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" }],
  ),
  activity: icon(["path", { d: "M22 12h-4l-3 9L9 3l-3 9H2" }]),
  run: icon(["path", { d: "m5 3 14 9-14 9V3z" }]),
  desktop: icon(["rect", { x: 3, y: 3, width: 18, height: 18, rx: 2 }], ["path", { d: "M3 15h18" }]),
};

/** The processes that draw the Start menu (and its search) on Windows 11. */
const START_HOSTS = /\\(SearchHost|StartMenuExperienceHost|SearchApp)\.exe$/i;

const isStartHost = (hwnd: ReturnType<typeof foregroundWindow>) => !!hwnd && START_HOSTS.test(exePathOf(windowPid(hwnd)));

/** When the Start menu was last seen in front (sampled every 100 ms while the widget is up). */
let startSeenAt = 0;

/**
 * The Start button toggles the Start menu, as on the taskbar. Clicking the dock takes the focus,
 * which closes an open Start menu before this runs, so a plain Win tap would open it again:
 * when Start was in front just before the click, the click only closes it.
 */
function toggleStart() {
  // Pressing the dock closed it a moment ago (or it is still closing).
  if (isStartHost(foregroundWindow()) || Date.now() - startSeenAt < 500) {
    if (isStartHost(foregroundWindow())) tapKey(0x1b /* Esc */);
    startSeenAt = 0;
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
    { label: "Aplicativos instalados", icon: glyphs.apps, onSelect: () => launch("ms-settings:appsfeatures") },
    { label: "Opções de energia", icon: glyphs.battery, onSelect: () => launch("ms-settings:powersleep") },
    { label: "Visualizador de Eventos", icon: glyphs.list, onSelect: () => launch("eventvwr.msc") },
    { label: "Sistema", icon: glyphs.monitor, onSelect: () => launch("ms-settings:about") },
    { label: "Gerenciador de Dispositivos", icon: glyphs.chip, onSelect: () => launch("devmgmt.msc") },
    { label: "Conexões de rede", icon: glyphs.network, onSelect: () => launch("ms-settings:network") },
    { label: "Gerenciamento de Disco", icon: glyphs.disk, onSelect: () => launch("diskmgmt.msc") },
    { label: "Gerenciamento do Computador", icon: glyphs.chip, onSelect: () => launch("compmgmt.msc") },
    { label: "Terminal", icon: glyphs.terminal, onSelect: () => launch("wt.exe") },
    {
      label: "Terminal (Admin)",
      icon: glyphs.shield,
      // The shell's "runas" verb: the UAC prompt, as "Executar como administrador".
      onSelect: () => openUri("wt.exe", undefined, "runas"),
    },
  ];
  const shell: DockMenuItem[] = [
    { label: "Gerenciador de Tarefas", icon: glyphs.activity, onSelect: () => launch("taskmgr.exe") },
    { label: "Configurações", icon: "settings", onSelect: () => launch("ms-settings:") },
    { label: "Explorador de Arquivos", icon: "folder", onSelect: () => launch("explorer.exe") },
    { label: "Pesquisar", icon: "search", onSelect: openStartMenu },
    { label: "Executar", icon: glyphs.run, onSelect: openRunDialog },
  ];
  // "Desligar ou sair" is a submenu on Windows; the dock menu lists its entries.
  const power: DockMenuItem[] = [
    { label: "Sair", icon: glyphs.logout, onSelect: signOut },
    { label: "Suspender", icon: glyphs.moon, onSelect: sleep },
    { label: "Reiniciar", icon: glyphs.restart, onSelect: () => run("shutdown.exe", "/r", "/t", "0") },
    // Start's "Desligar" keeps Fast Startup (a hybrid shutdown) when it is on.
    { label: "Desligar", icon: glyphs.power, danger: true, onSelect: () => run("shutdown.exe", "/s", "/hybrid", "/t", "0") },
  ];
  const desktop: DockMenuItem[] = [{ label: "Área de Trabalho", icon: glyphs.desktop, onSelect: () => toggleDesktop() }];
  showDockMenu({ title: "Iniciar", subtitle: "Menu de link rápido", sections: [tools, shell, power, desktop] });
}

export default defineWidget({
  type: "start",
  name: "Iniciar",
  description: "Abre o menu Iniciar do Windows.",
  category: "apps",
  defaultConfig: {},
  setup(ctx) {
    ctx.every(100, () => {
      if (isStartHost(foregroundWindow())) startSeenAt = Date.now();
    });
    return {};
  },
  View({ ctx }) {
    // Same slot and icon size as the app icons, so it lines up with them.
    const magnify = magnifyStyles("dock", dockIndex(ctx.instanceId, 0), dockMetrics());
    return (
      <Pressable
        onClick={toggleStart}
        onContextMenu={showStartMenu}
        style={{
          position: "relative",
          width: ui.app.slot,
          height: ui.tile.height,
          radius: 10,
          align: "center",
          justify: "center",
          cursor: "pointer",
          shrink: 0,
          ...iconHover({ magnified: true }),
          ...magnify.slot,
        }}
      >
        {/* Grows up from its bottom edge with the macOS effect. */}
        <View style={magnify.box}>
          <View
            style={{
              radius: 8,
              align: "center",
              justify: "center",
              background: "linear-gradient(160deg, #3a3a40, #1b1b1f)",
              ...magnify.icon,
            }}
          >
            <WindowsLogo size={Math.round((magnify.size * 15) / 32)} />
          </View>
        </View>
      </Pressable>
    );
  },
});
