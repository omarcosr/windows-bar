import audioOutput from "./audio-output";
import brightness from "./brightness";
import microphone from "./microphone";
import recycleBin from "./recycle-bin";
import { keyboard, notifications, screenshot, showDesktop, theme } from "./shell-actions";
import wallpaper from "./wallpaper";

/** GROUP=actions: system actions as the taskbar and Settings perform them. */
export default [audioOutput, microphone, brightness, theme, notifications, showDesktop, keyboard, screenshot, recycleBin, wallpaper];
