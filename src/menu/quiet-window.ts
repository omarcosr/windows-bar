import type { AppHandle } from "@tarve/core";
import { activateWindow, foregroundWindow, showWindow, SW_HIDE, SW_SHOWNA, type HWND } from "../native/win32";

/**
 * A popup (preview, tip) that shows without taking the foreground, as the taskbar's thumbnails and
 * tips do. Tarve's show() activates the window even with activation="never" (0.13.3): the dock
 * then lost the pointer's hover, and dropped the next click on an icon until the pointer moved
 * ("two clicks to minimize"). So Tarve shows the window once, off screen, at start (the focus goes
 * straight back to the window that had it), and from then on it is shown with SW_SHOWNA and hidden
 * with SW_HIDE: Tarve keeps rendering it as a visible window.
 */
export interface QuietWindow {
  show(): void;
  hide(): void;
}

export async function quietWindow(handle: AppHandle): Promise<QuietWindow> {
  const native = handle.nativeHandle();
  const hwnd = native ? (Number(native) as unknown as HWND) : null;
  if (!hwnd) return { show: () => handle.show(), hide: () => handle.hide() };
  const previous = foregroundWindow();
  handle.setBounds({ x: -32000, y: -32000 });
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, 1000);
    const off = handle.onFocusChange((focused) => focused && done());
    function done() {
      clearTimeout(timer);
      off();
      resolve();
    }
    handle.show();
  });
  showWindow(hwnd, SW_HIDE);
  if (previous && foregroundWindow() !== previous) activateWindow(previous);
  return {
    show: () => showWindow(hwnd, SW_SHOWNA),
    hide: () => showWindow(hwnd, SW_HIDE),
  };
}
