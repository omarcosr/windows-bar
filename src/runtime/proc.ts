import { spawn } from "node:child_process";

/**
 * Starts a hidden process without keeping the dock alive. On txiki, Tarve's detached spawn (0.13.3+)
 * starts it with DETACHED_PROCESS (no console window) outside the dock's job object.
 */
export function run(args: readonly string[]): void {
  if (!args.length) throw new Error("Missing executable");
  const child = spawn(args[0]!, args.slice(1), { windowsHide: true, detached: true, stdio: "ignore" });
  child.on("error", (error) => console.error("[process]", error));
  child.unref();
}

/**
 * Runs a console program with no console window and returns its stdout. On txiki this needs
 * @tarve/core 0.13.5+: older spawns with windowsHide (not detached) crashed with 0xC0000005.
 */
export async function output(args: readonly string[]): Promise<{ code: number; stdout: string }> {
    if (!args.length) throw new Error("Missing executable");
    const child = spawn(args[0]!, args.slice(1), { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Uint8Array[] = [];
    child.stdout!.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    const code = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (exit) => resolve(exit ?? -1));
    });
    return { code, stdout: Buffer.concat(chunks).toString("utf8") };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** FNV-1a 64-bit, independent of runtime-specific hash functions. */
export function hash(bytes: Uint8Array): bigint {
  let value = 0xcbf29ce484222325n;
  for (const byte of bytes) value = ((value ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
  return value;
}
