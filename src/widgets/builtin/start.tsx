import { Pressable, View } from "@tarve/core";
import { showDockMenu, type DockMenuItem } from "../../menu/dock-menu";
import { openRunDialog, openStartMenu, openUri, signOut, sleep, toggleDesktop } from "../../native/desktop";
import { exePathOf, foregroundWindow, windowPid } from "../../native/win32";
import { launch } from "../../services/windows";
import { ui } from "../../theme";
import { WindowsLogo, iconHover } from "../ui";
import { defineWidget } from "../types";
import { dockIndex, dockMetrics, magnifyStyles } from "../magnify";
import { run as runProcess } from "../../runtime/proc";

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
    // Still open: the same SC_TASKLIST command closes it, as a second press of the Start button.
    if (isStartHost(foregroundWindow())) openStartMenu();
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
