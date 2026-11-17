/** Exit normally; Tarve confirms the active app pack on exit code 0. */
export function exitApp(code = 0): never {
  return process.exit(code);
}

/** Register synchronous cleanup for every runtime. */
export function onExit(fn: () => void): () => void {
  const handler = () => {
    try { fn(); } catch (error) { console.error("[exit]", error); }
  };
  process.once("exit", handler);
  return () => { process.off("exit", handler); };
}
