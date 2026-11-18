import { registerWidget } from "../registry";
import apps from "./apps";
import clockWeather from "./clock-weather";
import nowPlaying from "./now-playing";
import revenue from "./revenue";
import start from "./start";
import system from "./system";
import trayWidget from "./tray";
import trayClock from "./tray-clock";
import trayLanguage from "./tray-language";
import trayStatus from "./tray-status";
import actions from "./actions";
import ai from "./ai";
import clocks from "./clocks";
import finance from "./finance";
import hardware from "./hardware";
import launcher from "./launcher";
import online from "./online";
import productivity from "./productivity";
import weatherMedia from "./weather-media";
import providers2 from "./providers2";

/** Built-in widgets. A new widget is one file with defineWidget() plus a line here. */
for (const widget of [
  clockWeather,
  start,
  apps,
  system,
  nowPlaying,
  revenue,
  trayWidget,
  trayLanguage,
  trayStatus,
  trayClock,
  ...clocks,
  ...weatherMedia,
  ...productivity,
  ...hardware,
  ...actions,
  ...launcher,
  ...finance,
  ...online,
  ...ai,
  ...providers2,
])
  registerWidget(widget);
