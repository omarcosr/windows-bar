import { Column, Svg, Path, Text, toRaw } from "@tarve/core";
import { ui } from "../../../theme";
import { RoundButton, Tile } from "../../ui";
import { defineWidget, type WidgetContext } from "../../types";
import { showDockMenu, type DockMenuItem } from "../../../menu/dock-menu";
import { openWidgetSettings } from "../../../dock/widget-menu";
import { Ring } from "./shared";
import { formatTasks, parseTasks, type Task } from "./tasks";

interface Config {
  title: string;
  tasks: string;
  hideWhenDone: boolean;
}

const DEMO: Task[] = [
  { text: "Revisar o pull request", done: true },
  { text: "Responder e-mails", done: true },
  { text: "Planejar a sprint", done: false },
  { text: "Ligar para o cliente", done: false },
];

const check = (size: number, color = "#fff") => (
  <Svg width={size} height={size} viewBox="0 0 24 24">
    <Path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke={color} stroke-width={2.6} stroke-linecap="round" stroke-linejoin="round" />
  </Svg>
);

function setDone(ctx: WidgetContext<Config>, index: number, done: boolean) {
  const tasks = parseTasks(String(ctx.config.tasks ?? ""));
  if (!tasks[index]) return;
  tasks[index]!.done = done;
  ctx.config.tasks = formatTasks(tasks);
  ctx.save();
}

function tickNext(ctx: WidgetContext<Config>) {
  const i = parseTasks(String(ctx.config.tasks ?? "")).findIndex((t) => !t.done);
  if (i >= 0) setDone(ctx, i, true);
}

function clearDone(ctx: WidgetContext<Config>) {
  ctx.config.tasks = formatTasks(parseTasks(String(ctx.config.tasks ?? "")).filter((t) => !t.done));
  ctx.save();
}

function taskItems(ctx: WidgetContext<Config>, reopen: () => void): DockMenuItem[][] {
  const tasks = parseTasks(String(ctx.config.tasks ?? ""));
  const open: DockMenuItem[] = [];
  const done: DockMenuItem[] = [];
  tasks.forEach((t, i) => {
    if (t.done) done.push({ label: t.text, icon: "check", onSelect: () => (setDone(ctx, i, false), reopen()) });
    else open.push({ label: t.text, icon: { fluent: 0xe739 }, onSelect: () => (setDone(ctx, i, true), reopen()) });
  });
  return [open, done].filter((s) => s.length);
}

function showList(ctx: WidgetContext<Config>) {
  const tasks = parseTasks(String(ctx.config.tasks ?? ""));
  const left = tasks.filter((t) => !t.done).length;
  showDockMenu({
    title: String(ctx.config.title || "Tarefas"),
    subtitle: tasks.length ? `${tasks.length - left} de ${tasks.length} concluídas · clique para marcar` : "Nenhuma tarefa",
    sections: [
      ...taskItems(ctx, () => setTimeout(() => showList(ctx), 0)),
      [
        { label: "Adicionar ou editar tarefas…", icon: "plus", onSelect: () => openWidgetSettings(ctx.instanceId) },
        ...(tasks.length - left ? [{ label: "Limpar concluídas", icon: "x" as const, onSelect: () => clearDone(ctx) }] : []),
      ],
    ],
  });
}

export default defineWidget<Config, object>({
  type: "productivity-todos",
  name: "Tarefas",
  description: "A próxima tarefa aberta com o progresso do dia. Marque como feita direto no dock.",
  category: "productivity",
  defaultConfig: { title: "Tarefas", tasks: "", hideWhenDone: false },
  settings: [
    { kind: "text", key: "title", label: "Título", placeholder: "Tarefas" },
    {
      kind: "text",
      key: "tasks",
      label: "Tarefas",
      description: 'Separe com ";". Comece com "x " para marcar como concluída (o dock faz isso ao marcar).',
      placeholder: "Revisar PR; Responder e-mails; x Planejar sprint",
    },
    { kind: "toggle", key: "hideWhenDone", label: "Ocultar quando tudo estiver feito" },
  ],
  setup() {
    return {};
  },
  hidden({ ctx }) {
    const tasks = parseTasks(String(ctx.config.tasks ?? ""));
    return ctx.config.hideWhenDone && tasks.length > 0 && tasks.every((t) => t.done);
  },
  menu({ ctx }) {
    return [
      ...taskItems(ctx, () => {}),
      [{ label: "Adicionar ou editar tarefas…", icon: "plus", onSelect: () => openWidgetSettings(ctx.instanceId) }],
    ];
  },
  View({ ctx, preview }) {
    const saved = parseTasks(String(ctx.config.tasks ?? ""));
    const tasks = preview && !saved.length ? DEMO : saved;
    const done = tasks.filter((t) => t.done).length;
    const next = tasks.find((t) => !t.done);
    const empty = !tasks.length;
    const size = Math.min(26, ui.tile.control);
    return (
      <Tile width={176} onClick={preview ? undefined : () => (empty ? openWidgetSettings(ctx.instanceId) : showList(ctx))}>
        <Ring value={tasks.length ? done / tasks.length : 0} size={size} color={next || empty ? ui.blue : ui.green} label={empty ? "" : String(tasks.length - done)} />
        <Column style={{ flex: 1, gap: 0, overflow: "hidden" }}>
          <Text size={10} weight={600} color={ui.muted} style={{ whiteSpace: "nowrap", textOverflow: "ellipsis", overflow: "hidden" }}>
            {empty ? String(ctx.config.title || "Tarefas") : `${String(ctx.config.title || "Tarefas")} · ${done}/${tasks.length}`}
          </Text>
          <Text size={12} weight={600} color={next ? ui.text : ui.muted} style={{ whiteSpace: "nowrap", textOverflow: "ellipsis", overflow: "hidden" }}>
            {empty ? "Adicionar tarefas" : next ? next.text : "Tudo feito"}
          </Text>
        </Column>
        {next && !preview ? (
          <RoundButton size={22} background="#2a2a2e" onClick={() => tickNext(ctx)}>
            {check(12, ui.green)}
          </RoundButton>
        ) : null}
      </Tile>
    );
  },
});

void toRaw;
