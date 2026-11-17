import { createRequire } from "node:module";
import { runtime } from "../native/ffi.ts";
import { measure } from "./perf-probe.ts";

export interface RuntimeWorker { terminate(): void }

/** Source must be plain JavaScript; Node eval workers use CommonJS. */
export function startWorker<T>(source: string, onMessage: (message: T) => void, onError: (error: unknown) => void = console.error, shutdown?: () => void): RuntimeWorker {
  if (runtime === "node") {
    const { Worker } = createRequire(import.meta.url)("node:worker_threads") as typeof import("node:worker_threads");
    const stopped = new Int32Array(new SharedArrayBuffer(4));
    const bootstrap = 'const { parentPort, workerData } = require("node:worker_threads"); const postMessage = value => parentPort.postMessage(value);\n';
    const worker = new Worker(bootstrap + "try {\n" + source + "\n} finally { Atomics.store(workerData, 0, 1); Atomics.notify(workerData, 0); }", { eval: true, workerData: stopped });
    worker.on("message", onMessage);
    worker.on("error", onError);
    return {
      terminate() {
        shutdown?.();
        // Never interrupt a native callback: V8 termination would abort node:ffi.
        if (shutdown) Atomics.wait(stopped, 0, 0, 2000);
        if (!shutdown || Atomics.load(stopped, 0) === 1) void worker.terminate();
      }
    };
  }
  const url = URL.createObjectURL(new Blob([source], { type: "application/javascript" }));
  try {
    const worker = new Worker(url, { type: "module" });
    const key = `worker ${source.slice(0, 400).match(/dlopen\("(\w+)/)?.[1] ?? "?"}:${source.length}`;
    worker.onmessage = (event: MessageEvent<T>) => measure(`${key} ${(event.data as { type?: string })?.type ?? ""}`, () => onMessage(event.data));
    worker.onerror = onError;
    return { terminate() { shutdown?.(); worker.terminate(); URL.revokeObjectURL(url); } };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}
