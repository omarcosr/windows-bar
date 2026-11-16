# WindowsBar

A lumabar-style smart dock for Windows 11, built with [Tarve](https://tarve.dev) (TSX on Bun, painted natively — no web view).

```powershell
bun install
bun start                 # run the dock
bun start -- --widgets    # run and open the widget gallery
bun run build             # dist/WindowsBar.exe
```

- **Right-click the dock** (or click the tray icon) to open the gallery: add widgets, reorder, remove, and settings.
- **Right-click an app icon** to pin or unpin it.
- Config lives in `%APPDATA%\windows-bar\config.json`. Put a restricted Stripe key in the `revenue` widget's `stripeKey` to replace the demo data.

## Releases, installer and updates

```powershell
bun run release 0.2.0             # dist/release: WindowsBar-Setup-0.2.0-win32-x64.exe + portable .zip
                                  # dist/updates: the executable + signed latest.json
bun run release 0.2.0 --publish   # same, then GitHub release v0.2.0 (gh), latest.json uploaded last
```

- The installer is Tarve's (`tarve package --format setup`, configured by `tarve.installer` in `package.json`): per-user install into `%LOCALAPPDATA%\Programs\WindowsBar`, Start menu entry, optional desktop shortcut, "start with Windows" (runs `WindowsBar.exe --autostart on|off`), uninstaller. It closes a running dock first (`--quit`).
- Updates follow Tarve's updater: the app reads `https://github.com/omarcosr/windows-bar/releases/latest/download/latest.json`, checks its Ed25519 signature against the public key in `src/services/updater.ts`, downloads and verifies the new executable, and installs it when the user restarts (Configurações > Sistema). It checks a minute after start and every 6 hours.
- Releases are signed with `windows-bar-update.key` (created by `bunx tarve keygen`, git-ignored). Keep a backup: without it, installed copies cannot accept new versions. In CI, pass it as `TARVE_UPDATE_PRIVATE_KEY`.
- The repository must be public (or the releases hosted somewhere public) for installed copies to download updates.

## How it works

| Layer | Files |
| --- | --- |
| Native window: size to content, bottom-centre, AppBar space reservation, hide taskbar, hide in full screen | `src/native/dock-window.ts`, `src/native/win32.ts` (bun:ffi → user32/kernel32/shell32/dwmapi) |
| Shared data services, polled only while a widget uses them | `src/services/` (windows, icons, system, media, weather) |
| Widget system | `src/widgets/types.ts`, `registry.ts`, `host.ts` |
| Built-in widgets | `src/widgets/builtin/*.tsx` |
| Taskbar host: tray icons and app badges, forwarded on to Explorer | `src/native/tray-host.ts`, `src/services/taskbar-host.ts`, `src/services/badges.ts` |
| Network, volume, battery, keyboard layout | `src/native/status.ts`, `src/services/status.ts` |
| Dock and gallery views | `src/dock/`, `src/gallery/` |

Now Playing and icon extraction run small PowerShell helpers (`scripts/`), because WinRT media sessions and shell icons are not reachable through plain FFI.

## Writing a widget

One file plus one line in `src/widgets/builtin/index.ts`:

```tsx
import { Text, store } from "@tarve/core";
import { Tile } from "../ui";
import { defineWidget } from "../types";

export default defineWidget({
  type: "counter",
  name: "Counter",
  description: "Counts clicks.",
  category: "productivity",
  defaultConfig: { step: 1 },
  setup(ctx) {
    const state = store({ count: 0 });      // a store re-renders the tile when it changes
    ctx.every(60_000, () => {});            // polling, cleared when the widget is removed
    ctx.onDispose(() => {});                // any other cleanup
    return state;
  },
  View({ state, ctx }) {
    return (
      <Tile width={90} onClick={() => (state.count += ctx.config.step)}>
        <Text size={16} weight={700} color="#fff">{String(state.count)}</Text>
      </Tile>
    );
  },
});
```

`setup` runs once per placed instance (so two clocks have separate state and config); `ctx.config` is saved per instance and `ctx.save()` persists edits.
