import type { AppHandle } from "@tarve/core";
import { saveConfig, type WidgetInstance } from "../config";
import { getWidget } from "./registry";
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

  const timers: ReturnType<typeof setInterval>[] = [];
  const disposers: (() => void)[] = [];
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
      timers.push(setInterval(() => run(fn), ms));
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
      timers.forEach(clearInterval);
      disposers.forEach((fn) => run(fn));
      mounted.delete(instance.id);
    },
  };
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
