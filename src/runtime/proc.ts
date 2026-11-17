import { spawn } from "node:child_process";
import { dlopen, runtime } from "../native/ffi";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const CREATE_NO_WINDOW = 0x08000000;
const STARTF_USESHOWWINDOW = 0x1;
const STARTF_USESTDHANDLES = 0x100;
const WAIT_TIMEOUT = 0x102;
const INVALID_HANDLE = 0xffffffffffffffffn;

let kernel: ReturnType<typeof loadKernel> | undefined;
function loadKernel() {
  return dlopen("kernel32.dll", {
    CreateFileW: { args: ["ptr", "u32", "u32", "ptr", "u32", "u32", "u64"], returns: "u64" },
    CreateProcessW: { args: ["ptr", "ptr", "ptr", "ptr", "i32", "u32", "ptr", "ptr", "ptr", "ptr"], returns: "i32" },
    WaitForSingleObject: { args: ["u64", "u32"], returns: "u32" },
    GetExitCodeProcess: { args: ["u64", "ptr"], returns: "i32" },
    TerminateProcess: { args: ["u64", "u32"], returns: "i32" },
    CloseHandle: { args: ["u64"], returns: "i32" },
  }).symbols;
}

function wide(value: string): Uint8Array {
  const bytes = new Uint8Array((value.length + 1) * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < value.length; i++) view.setUint16(i * 2, value.charCodeAt(i), true);
  return bytes;
}

/** An inheritable handle on `path` (SECURITY_ATTRIBUTES with bInheritHandle). */
function inheritable(path: string, write: boolean): bigint {
  const attributes = new Uint8Array(24);
  const view = new DataView(attributes.buffer);
  view.setUint32(0, 24, true);
  view.setInt32(16, 1, true);
  // GENERIC_WRITE + CREATE_ALWAYS or GENERIC_READ + OPEN_EXISTING, shared for read and write.
  const handle = BigInt(kernel!.CreateFileW(wide(path), write ? 0x40000000 : 0x80000000, 3, attributes, write ? 2 : 3, 0, 0));
  if (handle === INVALID_HANDLE || handle === 0n) throw new Error(`Cannot open ${path}`);
  return handle;
}

/**
 * Runs a console program with no console window and returns its stdout. Tarve's txiki spawn
 * (tjs.spawn) ignores windowsHide, so every reg/netsh call would flash a console; CreateProcessW
 * with CREATE_NO_WINDOW never creates one. stdout goes to a temporary file, read once it exits.
 */
async function hiddenOutput(args: readonly string[], timeout = 15_000): Promise<{ code: number; stdout: string }> {
  kernel ??= loadKernel();
  const k = kernel;
  const file = join(process.env.TEMP ?? process.env.TMP ?? ".", `windows-bar-${Date.now()}-${Math.random().toString(36).slice(2)}.out`);
  const handles: bigint[] = [];
  try {
    const stdin = inheritable("NUL", false);
    handles.push(stdin);
    const stdout = inheritable(file, true);
    handles.push(stdout);
    const stderr = inheritable("NUL", true);
    handles.push(stderr);
    // STARTUPINFOW (104 bytes on x64): dwFlags at 60, wShowWindow (SW_HIDE) at 64, std handles at 80/88/96.
    const startup = new Uint8Array(104);
    const info = new DataView(startup.buffer);
    info.setUint32(0, 104, true);
    info.setUint32(60, STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW, true);
    info.setUint16(64, 0, true);
    info.setBigUint64(80, stdin, true);
    info.setBigUint64(88, stdout, true);
    info.setBigUint64(96, stderr, true);
    const processInfo = new Uint8Array(24);
    const commandLine = args.map((a) => (a && !/[\s"]/.test(a) ? a : quoteArgument(a))).join(" ");
    if (!k.CreateProcessW(null, wide(commandLine), null, null, 1, CREATE_NO_WINDOW, null, null, startup, processInfo)) {
      throw new Error(`CreateProcessW failed: ${args[0]}`);
    }
    const pinfo = new DataView(processInfo.buffer);
    const process_ = pinfo.getBigUint64(0, true);
    handles.push(process_, pinfo.getBigUint64(8, true));
    const deadline = Date.now() + timeout;
    while (k.WaitForSingleObject(process_, 0) === WAIT_TIMEOUT) {
      if (Date.now() > deadline) {
        k.TerminateProcess(process_, 1);
        break;
      }
      await sleep(30);
    }
    const exit = new Uint8Array(4);
    k.GetExitCodeProcess(process_, exit);
    const code = new DataView(exit.buffer).getInt32(0, true);
    for (const handle of handles.splice(0).reverse()) k.CloseHandle(handle);
    let text = "";
    try { text = readFileSync(file, "utf8"); } catch {}
    return { code, stdout: text };
  } finally {
    for (const handle of handles.reverse()) k.CloseHandle(handle);
    try { rmSync(file, { force: true }); } catch {}
  }
}


function quoteArgument(value: string): string {
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
}

let shell: ReturnType<typeof dlopen> | undefined;

/** Starts a hidden process without keeping the dock alive. */
export function run(args: readonly string[]): void {
  if (!args.length) throw new Error("Missing executable");
  if (runtime === "txiki") {
    // Tarve's tjs.spawn shim drops windowsHide; ShellExecuteW honors SW_HIDE.
    shell ??= dlopen("shell32.dll", { ShellExecuteW: { args: ["ptr", "ptr", "ptr", "ptr", "ptr", "i32"], returns: "i64" } });
    const wide = (value: string) => {
      const bytes = new Uint8Array((value.length + 1) * 2);
      const view = new DataView(bytes.buffer);
      for (let i = 0; i < value.length; i++) view.setUint16(i * 2, value.charCodeAt(i), true);
      return bytes;
    };
    const result = shell.symbols.ShellExecuteW!(null, null, wide(args[0]!), wide(args.slice(1).map(quoteArgument).join(" ")), null, 0);
    if (Number(result) <= 32) throw new Error(`ShellExecuteW failed: ${result}`);
    return;
  }
  const child = spawn(args[0]!, args.slice(1), { windowsHide: true, detached: true, stdio: "ignore" });
  child.on("error", (error) => console.error("[process]", error));
  child.unref();
}

export async function output(args: readonly string[]): Promise<{ code: number; stdout: string }> {
    if (!args.length) throw new Error("Missing executable");
    if (runtime === "txiki") return hiddenOutput(args);
    const child = spawn(args[0]!, args.slice(1), { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    const exited = new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve(code ?? -1));
    });
    const read = (async () => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of child.stdout!) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks).toString("utf8");
    })();
    const [code, stdout] = await Promise.all([exited, read]);
    return { code, stdout };
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
