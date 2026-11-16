import { rmSync } from "node:fs";
import { join } from "node:path";

/**
 * process.exit for a normal, intended exit. Tarve runs an app pack (incremental update) behind a
 * "<version>.boot" marker that it only removes when the app's main module finishes or 3 s pass;
 * a process that exits earlier (installer jobs, a second launch handed to the running dock)
 * leaves it, and the next start rejects the pack as "stopped while starting" and falls back to
 * the version inside the executable (Tarve 0.13.0). The pack did start fine, so drop the marker.
 */
export function exitApp(code = 0): never {
  const host = (globalThis as Record<symbol, unknown>)[Symbol.for("tarve.packHost")] as { directory?: string; active?: string } | undefined;
  if (host?.directory && host.active) {
    try {
      rmSync(join(host.directory, `${host.active}.boot`), { force: true });
    } catch {
      // Not there (already confirmed) or not removable: nothing to do.
    }
  }
  return process.exit(code);
}
