import { openNotificationCenter, openUri, toggleDesktop } from "../../../native/desktop";
import { actions, themePoller, toggleKeyboard, toggleTheme } from "../../../services/actions-state";
import { launch } from "../../../services/windows";
import { defineWidget } from "../../types";
import { fluent, G, GlyphTile } from "./shared";

const settingsItem = (label: string, uri: string) => ({ label, icon: fluent(G.settings), onSelect: () => launch(uri) });

/** Light/dark mode, written and announced as Settings > Personalization > Colors does. */
export const theme = defineWidget({
  type: "actions-theme",
  name: "Modo claro/escuro",
  description: "Alterna o Windows e os apps entre o modo claro e o escuro.",
  category: "system",
  defaultConfig: {},
  setup(ctx) {
    ctx.onDispose(themePoller.acquire());
    return {};
  },
  menu() {
    return [
      [{ label: actions.lightTheme ? "Usar modo escuro" : "Usar modo claro", icon: fluent(actions.lightTheme ? G.moon : G.sun), onSelect: toggleTheme }],
      [settingsItem("Cores", "ms-settings:colors"), settingsItem("Personalização", "ms-settings:personalization")],
    ];
  },
  View({ ctx, preview }) {
    return (
      <GlyphTile
        code={actions.lightTheme ? G.sun : G.moon}
        onClick={toggleTheme}
        tipId={`tip:${ctx.instanceId}:theme`}
        tip={() => [actions.lightTheme ? "Modo claro" : "Modo escuro", "Clique para alternar"]}
        preview={preview}
      />
    );
  },
});

/** The notification center, as the taskbar clock's click (ms-actioncenter:). */
export const notifications = defineWidget({
  type: "actions-notifications",
  name: "Notificações",
  description: "Abre a central de notificações e o calendário.",
  category: "system",
  defaultConfig: {},
  setup: () => ({}),
  menu: () => [[settingsItem("Configurações de notificações", "ms-settings:notifications")]],
  View({ ctx, preview }) {
    return <GlyphTile code={G.bell} onClick={openNotificationCenter} tipId={`tip:${ctx.instanceId}:bell`} tip={() => ["Notificações"]} preview={preview} />;
  },
});

/** "Mostrar área de trabalho": Explorer's own command (toggleDesktop). */
export const showDesktop = defineWidget({
  type: "actions-show-desktop",
  name: "Mostrar área de trabalho",
  description: "Minimiza tudo e mostra a área de trabalho; outro clique restaura as janelas.",
  category: "system",
  defaultConfig: {},
  setup: () => ({}),
  View({ ctx, preview }) {
    return <GlyphTile code={G.desktop} onClick={() => toggleDesktop()} tipId={`tip:${ctx.instanceId}:desktop`} tip={() => ["Mostrar área de trabalho"]} preview={preview} />;
  },
});

/** The taskbar's touch keyboard button (ITipInvocation::Toggle). */
export const keyboard = defineWidget({
  type: "actions-touch-keyboard",
  name: "Teclado virtual",
  description: "Mostra ou esconde o teclado virtual, como o botão da barra de tarefas.",
  category: "system",
  defaultConfig: {},
  setup: () => ({}),
  menu: () => [[settingsItem("Configurações de digitação", "ms-settings:typing")]],
  View({ ctx, preview }) {
    return <GlyphTile code={G.keyboard} onClick={toggleKeyboard} tipId={`tip:${ctx.instanceId}:keyboard`} tip={() => ["Teclado virtual"]} preview={preview} />;
  },
});

/** The snipping overlay (ms-screenclip:, what Win+Shift+S opens). */
export const screenshot = defineWidget({
  type: "actions-screenshot",
  name: "Captura de tela",
  description: "Abre a captura de tela da Ferramenta de Captura.",
  category: "system",
  defaultConfig: {},
  setup: () => ({}),
  menu: () => [[{ label: "Abrir Ferramenta de Captura", icon: fluent(G.snip), onSelect: () => launch("ms-screensketch:") }]],
  View({ ctx, preview }) {
    return <GlyphTile code={G.snip} onClick={() => openUri("ms-screenclip:")} tipId={`tip:${ctx.instanceId}:snip`} tip={() => ["Capturar tela"]} preview={preview} />;
  },
});
