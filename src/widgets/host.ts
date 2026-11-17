import type { AppHandle } from "@tarve/core";
import { saveConfig, type WidgetInstance } from "../config";
import { getWidget } from "./registry";
import { onClock } from "../services/clock";
import type { WidgetContext, WidgetDefinition } from "./types";

export interface MountedWidget {
  instance: WidgetInstance;
  definition: WidgetDefinition;
  ctx: WidgetContext<Record<string, unknown>>;
  state: object;
  dispose(): void;
}

const mounted = new Map<string, MountedWidget>();
let appHandle: AppHandle | undefined;

export function setWidgetApp(app: AppHandle) {
  appHandle = app;
}

export function mountWidget(instance: WidgetInstance): MountedWidget | undefined {
  const existing = mounted.get(instance.id);
  if (existing) return existing;
  const definition = getWidget(instance.type);
  if (!definition) return undefined;

  // Fill in config keys added since the instance was saved.
  for (const [key, value] of Object.entries(definition.defaultConfig)) {
    if (!(key in instance.config)) instance.config[key] = structuredClone(value);
  }

  // A gallery preview is a still picture with sample data: it reads once and never ticks. Ninety
  // live previews (clocks, pollers, network refreshes) each re-rendering the gallery made it crawl.
  const preview = instance.id.startsWith("preview:");
  const disposers: (() => void)[] = [];
  let disposed = false;
  const label = `[widget ${instance.id}]`;
  const run = (fn: () => unknown) => {
    try {
      const result = fn();
      if (result instanceof Promise) result.catch((error) => console.error(label, error));
    } catch (error) {
      console.error(label, error);
    }
  };
  const ctx: WidgetContext<Record<string, unknown>> = {
    instanceId: instance.id,
    config: instance.config,
    get app() {
      if (!appHandle) throw new Error("widget used the app before it started");
      return appHandle;
    },
    save: saveConfig,
    every(ms, fn) {
      run(fn);
      if (preview) return;
      // On the shared clock (services/clock.ts): one timer for every widget. Behind a full-screen
      // app nothing shows, so the tick rests and runs once when the dock is back.
      let due = Date.now() + ms;
      const sub = onClock(
        (_now, covered) => (covered ? null : due),
        (now) => {
          due = Math.max(due + ms, now + 1);
          run(fn);
        },
      );
      disposers.push(sub.cancel);
    },
    ticker(ms, fn) {
      let sub: ReturnType<typeof onClock> | undefined;
      let due = 0;
      const ticker = {
        start() {
          if (sub || disposed || preview) return;
          due = Date.now() + ms;
          sub = onClock(
            () => due,
            (now) => {
              due = Math.max(due + ms, now + 1);
              run(fn);
            },
          );
        },
        stop() {
          sub?.cancel();
          sub = undefined;
        },
        get running() {
          return !!sub;
        },
      };
      disposers.push(() => ticker.stop());
      return ticker;
    },
    onDispose(fn) {
      disposers.push(fn);
    },
  };
  const widget: MountedWidget = {
    instance,
    definition,
    ctx,
    state: definition.setup(ctx),
    dispose() {
      disposed = true;
      disposers.forEach((fn) => run(fn));
      mounted.delete(instance.id);
    },
  };
  // Whatever the preview acquired in setup (shared pollers, hosts) is let go at once: its first
  // reading is already in the state.
  if (preview) disposers.splice(0).forEach((fn) => run(fn));
  mounted.set(instance.id, widget);
  return widget;
}

export function disposeWidget(id: string) {
  mounted.get(id)?.dispose();
}

/** Drops mounted widgets whose instance is no longer in `keep`. */
export function pruneWidgets(keep: Iterable<string>) {
  const ids = new Set(keep);
  for (const [id, widget] of mounted) if (!ids.has(id)) widget.dispose();
}
