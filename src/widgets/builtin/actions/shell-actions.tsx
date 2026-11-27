import { openNotificationCenter, openUri, toggleDesktop } from "../../../native/desktop";
import { actions, themePoller, toggleKeyboard, toggleTheme } from "../../../services/actions-state";
import { launch } from "../../../services/windows";
import { defineWidget } from "../../types";
import { fluent, G, GlyphTile } from "./shared";

import { t } from "../../../i18n";
const settingsItem = (label: string, uri: string) => ({ label, icon: fluent(G.settings), onSelect: () => launch(uri) });

/** Light/dark mode, written and announced as Settings > Personalization > Colors does. */
export const theme = defineWidget({
  type: "actions-theme",
  name: "Modo claro/escuro",
  description: t("widgets.actions.shellActions.switchesWindowsAndApps"),
  category: "system",
  defaultConfig: {},
  setup(ctx) {
    ctx.onDispose(themePoller.acquire());
    return {};
  },
  menu() {
    return [
      [{ label: actions.lightTheme ? t("widgets.actions.shellActions.useDarkMode") : t("widgets.actions.shellActions.useLightMode"), icon: fluent(actions.lightTheme ? G.moon : G.sun), onSelect: toggleTheme }],
      [settingsItem(t("widgets.actions.shellActions.colors"), "ms-settings:colors"), settingsItem(t("widgets.actions.shellActions.personalization"), "ms-settings:personalization")],
    ];
  },
  View({ ctx, preview }) {
    return (
      <GlyphTile
        code={actions.lightTheme ? G.sun : G.moon}
        onClick={toggleTheme}
        tipId={`tip:${ctx.instanceId}:theme`}
        tip={() => [actions.lightTheme ? t("widgets.actions.shellActions.lightMode") : t("widgets.actions.shellActions.darkMode"), t("widgets.actions.shellActions.clickToSwitch")]}
        preview={preview}
      />
    );
  },
});

/** The notification center, as the taskbar clock's click (ms-actioncenter:). */
export const notifications = defineWidget({
  type: "actions-notifications",
  name: t("widgets.actions.shellActions.notifications"),
  description: t("widgets.actions.shellActions.opensNotificationCenterAnd"),
  category: "system",
  defaultConfig: {},
  setup: () => ({}),
  menu: () => [[settingsItem(t("widgets.actions.shellActions.notificationSettings"), "ms-settings:notifications")]],
  View({ ctx, preview }) {
    return <GlyphTile code={G.bell} onClick={openNotificationCenter} tipId={`tip:${ctx.instanceId}:bell`} tip={() => [t("widgets.actions.shellActions.notifications")]} preview={preview} />;
  },
});

/** "Mostrar área de trabalho": Explorer's own command (toggleDesktop). */
export const showDesktop = defineWidget({
  type: "actions-show-desktop",
  name: t("widgets.actions.shellActions.showDesktop"),
  description: t("widgets.actions.shellActions.minimizesEverythingAndShows"),
  category: "system",
  defaultConfig: {},
  setup: () => ({}),
  View({ ctx, preview }) {
    return <GlyphTile code={G.desktop} onClick={() => toggleDesktop()} tipId={`tip:${ctx.instanceId}:desktop`} tip={() => [t("widgets.actions.shellActions.showDesktop")]} preview={preview} />;
  },
});

/** The taskbar's touch keyboard button (ITipInvocation::Toggle). */
export const keyboard = defineWidget({
  type: "actions-touch-keyboard",
  name: t("widgets.actions.shellActions.touchKeyboard"),
  description: t("widgets.actions.shellActions.showsOrHidesTouch"),
  category: "system",
  defaultConfig: {},
  setup: () => ({}),
  menu: () => [[settingsItem(t("widgets.actions.shellActions.typingSettings"), "ms-settings:typing")]],
  View({ ctx, preview }) {
    return <GlyphTile code={G.keyboard} onClick={toggleKeyboard} tipId={`tip:${ctx.instanceId}:keyboard`} tip={() => [t("widgets.actions.shellActions.touchKeyboard")]} preview={preview} />;
  },
});

/** The snipping overlay (ms-screenclip:, what Win+Shift+S opens). */
export const screenshot = defineWidget({
  type: "actions-screenshot",
  name: t("widgets.actions.shellActions.screenshot"),
  description: t("widgets.actions.shellActions.opensSnippingToolScreenshot"),
  category: "system",
  defaultConfig: {},
  setup: () => ({}),
  menu: () => [[{ label: t("widgets.actions.shellActions.openSnippingTool"), icon: fluent(G.snip), onSelect: () => launch("ms-screensketch:") }]],
  View({ ctx, preview }) {
    return <GlyphTile code={G.snip} onClick={() => openUri("ms-screenclip:")} tipId={`tip:${ctx.instanceId}:snip`} tip={() => [t("widgets.actions.shellActions.takeScreenshot")]} preview={preview} />;
  },
});
