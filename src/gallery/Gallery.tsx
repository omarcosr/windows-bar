import { Column, Icon, Pressable, Row, Scroll, Slider, Text, TitleBar, View, Window, darkTheme, store, type IconName } from "@tarve/core";
import { WindowsLogo } from "../widgets/ui";
import { config, saveConfig } from "../config";
import { addWidget, moveWidget, removeWidget } from "../dock/state";
import { numeric, ui } from "../theme";
import { mountWidget } from "../widgets/host";
import { allWidgets, getWidget } from "../widgets/registry";
import { categoryLabels, type WidgetCategory, type WidgetDefinition } from "../widgets/types";

export const GALLERY_TITLE = "WindowsBar Widgets";
export const PREVIEW_PREFIX = "preview:";

const gallery = store({ category: "all" as WidgetCategory | "all" });

function Chip(props: { label?: string; icon?: IconName; active?: boolean; tone?: "danger" | "primary"; onClick: () => void }) {
  const bg = props.tone === "primary" ? ui.blue : props.tone === "danger" ? "rgba(255,69,58,0.16)" : "rgba(255,255,255,0.07)";
  const fg = props.tone === "danger" ? ui.danger : "#fff";
  return (
    <Pressable
      onClick={props.onClick}
      style={{
        padding: props.icon ? 5 : { left: 10, right: 10, top: 5, bottom: 5 },
        radius: 8,
        background: props.active ? ui.blue : bg,
        cursor: "pointer",
        hover: { background: props.active ? ui.blue : props.tone === "primary" ? "#2f95ff" : "rgba(255,255,255,0.12)" },
        active: { transform: "scale(0.96)" },
      }}
    >
      {props.icon ? (
        <Icon name={props.icon} size={14} color={fg} strokeWidth={2.4} />
      ) : (
        <Text size={12} weight={600} color={fg}>
          {props.label}
        </Text>
      )}
    </Pressable>
  );
}

function Toggle(props: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <Pressable
      onClick={() => props.onChange(!props.checked)}
      style={{ direction: "row", align: "center", gap: 10, cursor: "pointer", padding: { top: 2, bottom: 2 } }}
    >
      <View
        style={{
          width: 34,
          height: 20,
          radius: 10,
          padding: 2,
          shrink: 0,
          background: props.checked ? ui.green : "#3a3a3e",
          transition: { background: { duration: 160, easing: "easeOut" } },
        }}
      >
        <View
          style={{
            width: 16,
            height: 16,
            radius: 8,
            background: "#fff",
            transform: { x: props.checked ? 14 : 0 },
            boxShadow: { y: 1, blur: 2, color: "#0006" },
            transition: { transform: { duration: 160, easing: "easeOut" } },
          }}
        />
      </View>
      <Text size={12} color="#fff" style={{ flex: 1 }}>
        {props.label}
      </Text>
    </Pressable>
  );
}

function SidebarItem(props: { label: string; count: number; active: boolean; onClick: () => void }) {
  return (
    <Pressable
      onClick={props.onClick}
      style={{
        direction: "row",
        align: "center",
        padding: { left: 10, right: 10, top: 7, bottom: 7 },
        radius: 8,
        background: props.active ? ui.blue : "transparent",
        cursor: "pointer",
        hover: { background: props.active ? ui.blue : "rgba(255,255,255,0.06)" },
      }}
    >
      <Text size={13} weight={props.active ? 600 : 500} color="#fff" style={{ flex: 1 }}>
        {props.label}
      </Text>
      <Text size={11} color={props.active ? "#ffffffcc" : ui.muted} style={numeric}>
        {String(props.count)}
      </Text>
    </Pressable>
  );
}

function Preview(props: { definition: WidgetDefinition }) {
  const { definition } = props;
  const widget = mountWidget({
    id: PREVIEW_PREFIX + definition.type,
    type: definition.type,
    config: structuredClone(definition.defaultConfig) as Record<string, unknown>,
  });
  if (!widget) return null;
  const WidgetView = definition.View;
  return <WidgetView state={widget.state} ctx={widget.ctx} preview />;
}

function WidgetCard(props: { definition: WidgetDefinition }) {
  const { definition } = props;
  const placed = config.widgets.filter((w) => w.type === definition.type).length;
  return (
    <Column
      style={{
        gap: 8,
        padding: 10,
        radius: 16,
        background: "rgba(255,255,255,0.04)",
        borderWidth: 1,
        borderColor: "rgba(255,255,255,0.06)",
      }}
    >
      <Row style={{ padding: 6, radius: 18, background: ui.dock.background, align: "center", alignSelf: "start" }}>
        <Preview definition={definition} />
      </Row>
      <Row style={{ align: "center", gap: 10 }}>
        <Column style={{ flex: 1, gap: 2, minWidth: 150 }}>
          <Text size={13} weight={650} color="#fff">
            {definition.name}
          </Text>
          <Text size={11} color={ui.muted} style={{ maxWidth: 260 }}>
            {definition.description}
          </Text>
        </Column>
        <Chip
          label={placed ? `Adicionar outro (${placed})` : "Adicionar"}
          tone={placed ? undefined : "primary"}
          onClick={() => addWidget(definition.type)}
        />
      </Row>
    </Column>
  );
}

function DockOrder() {
  return (
    <Column style={{ gap: 8 }}>
      <Text size={15} weight={700} color="#fff">
        Seu dock
      </Text>
      <Text size={11} color={ui.muted}>
        Ordem da esquerda para a direita. No próprio dock, o "−" vermelho remove.
      </Text>
      <Row style={{ gap: 6, wrap: true }}>
        {config.widgets.map((instance) => (
          <Row key={instance.id} style={{ align: "center", gap: 4, padding: 4, radius: 10, background: "rgba(255,255,255,0.05)" }}>
            <Chip icon="chevron-left" onClick={() => moveWidget(instance.id, -1)} />
            <Text size={12} weight={600} color="#fff" style={{ padding: { left: 4, right: 4 } }}>
              {getWidget(instance.type)?.name ?? instance.type}
            </Text>
            <Chip icon="chevron-right" onClick={() => moveWidget(instance.id, 1)} />
            <Chip icon="x" tone="danger" onClick={() => removeWidget(instance.id)} />
          </Row>
        ))}
      </Row>
    </Column>
  );
}

export function GalleryView() {
  const widgets = allWidgets();
  const categories = Object.keys(categoryLabels) as WidgetCategory[];
  const shown = gallery.category === "all" ? categories : [gallery.category];
  return (
    <Window title={GALLERY_TITLE} width={980} height={660} minWidth={720} minHeight={480} theme={darkTheme} backdrop="mica">
      {/* Tarve's own title bar: native drag, snap and resize, drawn in the app's style. */}
      <TitleBar
        title="WindowsBar"
        height={40}
        leading={
          <View
            style={{ width: 18, height: 18, radius: 5, background: "#2a2a30", align: "center", justify: "center", margin: { left: 12 } }}
          >
            <WindowsLogo size={9} />
          </View>
        }
        style={{ background: "rgba(20,20,22,0.72)" }}
        buttonStyle={{ hover: { background: "rgba(255,255,255,0.08)" } }}
      />
      <Row style={{ flex: 1, minHeight: 0, align: "stretch", background: "rgba(20,20,22,0.72)" }}>
        <Column
          style={{
            width: 220,
            shrink: 0,
            alignSelf: "stretch",
            padding: 14,
            gap: 4,
            background: "rgba(255,255,255,0.03)",
            borderWidth: { right: 1 },
            borderColor: "rgba(255,255,255,0.06)",
          }}
        >
          <Text size={18} weight={700} color="#fff" style={{ padding: { left: 8, bottom: 10, top: 4 } }}>
            Widgets
          </Text>
          <SidebarItem
            label="Todos"
            count={widgets.length}
            active={gallery.category === "all"}
            onClick={() => (gallery.category = "all")}
          />
          {categories.map((c) => {
            const count = widgets.filter((w) => w.category === c).length;
            if (!count) return null;
            return (
              <SidebarItem
                key={c}
                label={categoryLabels[c]}
                count={count}
                active={gallery.category === c}
                onClick={() => (gallery.category = c)}
              />
            );
          })}
          <View style={{ flex: 1 }} />
          <Column style={{ gap: 10, padding: { left: 8, right: 4, bottom: 6 } }}>
            <Text size={11} weight={600} color={ui.muted}>
              ESTILO
            </Text>
            <Row style={{ gap: 4, padding: 3, radius: 9, background: "rgba(255,255,255,0.06)" }}>
              {(
                [
                  ["floating", "Flutuante"],
                  ["full", "Barra inteira"],
                ] as const
              ).map(([mode, label]) => (
                <Pressable
                  key={mode}
                  onClick={() => {
                    config.mode = mode;
                    saveConfig();
                  }}
                  style={{
                    flex: 1,
                    height: 28,
                    radius: 7,
                    align: "center",
                    justify: "center",
                    cursor: "pointer",
                    background: config.mode === mode ? "rgba(255,255,255,0.14)" : "transparent",
                    hover: { background: config.mode === mode ? "rgba(255,255,255,0.14)" : "rgba(255,255,255,0.07)" },
                  }}
                >
                  <Text size={12} weight={600} color={config.mode === mode ? "#fff" : ui.muted}>
                    {label}
                  </Text>
                </Pressable>
              ))}
            </Row>
            <Column style={{ gap: 6 }}>
              <Row style={{ align: "center" }}>
                <Text size={12} color="#fff" style={{ flex: 1 }}>
                  Opacidade da barra
                </Text>
                <Text size={12} color={ui.muted} style={numeric}>
                  {`${Math.round(config.opacity * 100)}%`}
                </Text>
              </Row>
              <Slider
                label="Opacidade da barra"
                value={config.opacity}
                min={0.2}
                max={1}
                step={0.05}
                onValueChange={(v) => {
                  config.opacity = Math.round(v * 100) / 100;
                  saveConfig();
                }}
              />
            </Column>
            <Toggle
              label="Preview das janelas ao passar o mouse"
              checked={config.hoverPreview}
              onChange={(v) => {
                config.hoverPreview = v;
                saveConfig();
              }}
            />
            <Toggle
              label="Reservar espaço na tela"
              checked={config.reserveSpace}
              onChange={(v) => {
                config.reserveSpace = v;
                saveConfig();
              }}
            />
            {config.mode === "floating" && config.reserveSpace ? (
              <Toggle
                label="Fundo do espaço segue a tela"
                checked={config.stripFollowsApp}
                onChange={(v) => {
                  config.stripFollowsApp = v;
                  saveConfig();
                }}
              />
            ) : null}
            <Toggle
              label={config.mode === "full" ? "Esconder barra do Windows (sempre na barra inteira)" : "Esconder barra do Windows"}
              checked={config.hideNativeTaskbar || config.mode === "full"}
              onChange={(v) => {
                if (config.mode === "full") return;
                config.hideNativeTaskbar = v;
                saveConfig();
              }}
            />
          </Column>
        </Column>
        <Scroll style={{ flex: 1, minHeight: 0, alignSelf: "stretch" }}>
          <Column style={{ padding: 24, gap: 24 }}>
            <DockOrder />
            {shown.map((category) => {
              const list = widgets.filter((w) => w.category === category);
              if (!list.length) return null;
              return (
                <Column key={category} style={{ gap: 10 }}>
                  <Text size={13} weight={700} color={ui.muted} style={{ textTransform: "uppercase", letterSpacing: 0.6 }}>
                    {categoryLabels[category]}
                  </Text>
                  <Row style={{ gap: 12, wrap: true }}>
                    {list.map((definition) => (
                      <WidgetCard key={definition.type} definition={definition} />
                    ))}
                  </Row>
                </Column>
              );
            })}
          </Column>
        </Scroll>
      </Row>
    </Window>
  );
}
