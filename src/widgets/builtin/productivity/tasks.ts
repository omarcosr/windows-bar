/** Tasks and notes live in one text option, separated by ";" — the gallery's text field is one line. */
export interface Task {
  text: string;
  done: boolean;
}

const DONE = /^\s*(?:\[x\]|x|✓)\s+/i;

export function parseTasks(raw: string): Task[] {
  return raw
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (DONE.test(s) ? { text: s.replace(DONE, "").trim(), done: true } : { text: s.replace(/^\[ \]\s*/, ""), done: false }));
}

export function formatTasks(tasks: readonly Task[]) {
  return tasks.map((t) => (t.done ? `x ${t.text}` : t.text)).join("; ");
}

export function parseNotes(raw: string) {
  return raw
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}
