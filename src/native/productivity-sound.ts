import { dlopen } from "./ffi";

/** MessageBeep: plays the sound the user picked in Windows' sound scheme (Asterisk / Exclamation). */
let beep: ((type: number) => number) | null | undefined;

export function systemSound(kind: "asterisk" | "exclamation" = "asterisk") {
  if (beep === null) return;
  try {
    beep ??= dlopen("user32.dll", { MessageBeep: { args: ["u32"], returns: "i32" } }).symbols.MessageBeep as unknown as (type: number) => number;
    beep(kind === "asterisk" ? 0x40 : 0x30);
  } catch (error) {
    console.error("[productivity] MessageBeep", error);
    beep = null;
  }
}
