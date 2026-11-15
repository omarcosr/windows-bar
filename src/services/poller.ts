/** A shared poll loop that only runs while something uses it. */
export function createPoller(ms: number, tick: () => unknown) {
  let users = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  const run = () => {
    try {
      const result = tick();
      if (result instanceof Promise) result.catch((error) => console.error("[poller]", error));
    } catch (error) {
      console.error("[poller]", error);
    }
  };
  return {
    /** Starts polling (if needed); returns the release function. */
    acquire(): () => void {
      if (users++ === 0) {
        run();
        timer = setInterval(run, ms);
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (--users === 0) clearInterval(timer);
      };
    },
  };
}
