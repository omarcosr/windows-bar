import notes from "./notes";
import pomodoro from "./pomodoro";
import { dayProgress, monthProgress, yearProgress } from "./progress";
import stopwatch from "./stopwatch";
import timer from "./timer";
import todos from "./todos";

/** Productivity widgets: focus timers, tasks, notes and time progress. */
export default [pomodoro, timer, stopwatch, todos, notes, dayProgress, monthProgress, yearProgress];
