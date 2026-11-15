import { registerWidget } from "../registry";
import apps from "./apps";
import clockWeather from "./clock-weather";
import nowPlaying from "./now-playing";
import revenue from "./revenue";
import start from "./start";
import system from "./system";

/** Built-in widgets. A new widget is one file with defineWidget() plus a line here. */
for (const widget of [clockWeather, start, apps, system, nowPlaying, revenue]) registerWidget(widget);
