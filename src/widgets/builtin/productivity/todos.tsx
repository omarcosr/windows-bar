import { Text, toRaw } from "@tarve/core";
import { HoverTip } from "../../../menu/hover-tip";
import { ui } from "../../../theme";
import { RoundButton, Tile } from "../../ui";
import { defineWidget, type WidgetContext } from "../../types";
import { showDockMenu, type DockMenuItem } from "../../../menu/dock-menu";
import { openWidgetSettings } from "../../../dock/widget-menu";
import { Ring, Stack, buttonSize } from "./shared";
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

/** Segoe Fluent Icons' CheckMark, as the Windows To Do and quick settings draw it. */
const check = (size: number, color = "#fff") => (
  <Text size={size} color={color} style={{ fontFamily: "Segoe Fluent Icons, Segoe MDL2 Assets", lineHeight: 1 }}>
    {String.fromCharCode(0xe73e)}
  </Text>
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
    const b = buttonSize();
      const tip = () => {
        const open = tasks.filter((t) => !t.done);
        if (empty) return ["Nenhuma tarefa", "Clique para adicionar"];
        return [
          `${done} de ${tasks.length} concluídas (${Math.round((done / tasks.length) * 100)}%)`,
          ...open.slice(0, 5).map((t) => `• ${t.text}`),
          ...(open.length > 5 ? [`e mais ${open.length - 5}`] : []),
          next ? "✓ marca a próxima como feita" : "Tudo feito",
        ];
      };
      return (
        <HoverTip id={`tip:${ctx.instanceId}`} tip={tip} disabled={preview}>
          <Tile width={176} onClick={preview ? undefined : () => (empty ? openWidgetSettings(ctx.instanceId) : showList(ctx))}>
          <Ring value={tasks.length ? done / tasks.length : 0} size={size} color={next || empty ? ui.blue : ui.green} label={empty ? "" : String(tasks.length - done)} />
            <Stack
              label={empty ? String(ctx.config.title || "Tarefas") : `${String(ctx.config.title || "Tarefas")} · ${done}/${tasks.length}`}
              value={empty ? "Adicionar tarefas" : next ? next.text : "Tudo feito"}
            valueColor={next ? ui.text : ui.muted}
            valueWeight={600}
            valueSize={ui.tile.height < 32 ? 11 : ui.tile.height >= 46 ? 13 : 12}
            numericValue={false}
          />
          {next && !preview ? (
            <RoundButton size={b} background="#2a2a2e" onClick={() => tickNext(ctx)}>
              {check(Math.round(b * 0.55), ui.green)}
            </RoundButton>
          ) : null}
        </Tile>
      </HoverTip>
    );
  },
});

void toRaw;
