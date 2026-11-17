import {
  Column,
  Icon,
  Pressable,
  Row,
  Scroll,
  Slider,
  Switch,
  Text,
  TitleBar,
  View,
  Window,
  darkTheme,
  store,
  type IconName,
  type SvgNode,
} from "@tarve/core";
import { glyph } from "../menu/dock-menu";
import { WindowsLogo } from "../widgets/ui";
import { config, saveConfig, type WidgetInstance } from "../config";
import { addWidget, dropSide, moveWidget, removeWidget, widgetDrag, widgetDragProps } from "../dock/state";
import { numeric, ui } from "../theme";
import { SettingsPage } from "./Settings";
import { mountWidget } from "../widgets/host";
import { editWidgetSettings } from "../widgets/settings";
import { WidgetSettingsModal } from "./WidgetSettings";
import { allWidgets, getWidget } from "../widgets/registry";
import { categoryLabels, type WidgetCategory, type WidgetDefinition } from "../widgets/types";

export const GALLERY_TITLE = "WindowsBar Widgets";
export const PREVIEW_PREFIX = "preview:";

export type GalleryPage = "settings" | "widgets";

const gallery = store({ page: "widgets" as GalleryPage, category: "all" as WidgetCategory | "all" });

/** Which page the gallery window shows (main.tsx opens it on one or the other). */
export function setGalleryPage(page: GalleryPage) {
  gallery.page = page;
}

function Chip(props: { label?: string; icon?: IconName | readonly SvgNode[]; active?: boolean; tone?: "danger" | "primary"; onClick: () => void }) {
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
        typeof props.icon === "string" ? (
          <Icon name={props.icon} size={14} color={fg} strokeWidth={2.4} />
        ) : (
          <Icon iconNode={props.icon} size={14} color={fg} strokeWidth={2.2} />
        )
      ) : (
        <Text size={12} weight={600} color={fg}>
          {props.label}
        </Text>
      )}
    </Pressable>
  );
}

function SidebarItem(props: { label: string; count?: number; icon?: IconName; active: boolean; onClick: () => void }) {
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
      {props.icon ? <Icon name={props.icon} size={15} color="#fff" strokeWidth={2} style={{ margin: { right: 8 } }} /> : null}
      <Text size={13} weight={props.active ? 600 : 500} color="#fff" style={{ flex: 1 }}>
        {props.label}
      </Text>
      {props.count !== undefined ? (
        <Text size={11} color={props.active ? "#ffffffcc" : ui.muted} style={numeric}>
          {String(props.count)}
        </Text>
      ) : null}
    </Pressable>
  );
}

/** Each type's preview instance, made once: cloning ~90 default configs on every gallery render was wasted. */
const previewInstances = new Map<string, WidgetInstance>();

function Preview(props: { definition: WidgetDefinition }) {
  const { definition } = props;
  let instance = previewInstances.get(definition.type);
  if (!instance) {
    instance = {
      id: PREVIEW_PREFIX + definition.type,
      type: definition.type,
      config: structuredClone(definition.defaultConfig) as Record<string, unknown>,
    };
    previewInstances.set(definition.type, instance);
  }
  const widget = mountWidget(instance);
  if (!widget) return null;
  const WidgetView = definition.View;
  return <WidgetView state={widget.state} ctx={widget.ctx} preview />;
}

function WidgetCard(props: { definition: WidgetDefinition }) {
  const { definition } = props;
  const instances = config.widgets.filter((w) => w.type === definition.type);
  const placed = instances.length;
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
        {placed && definition.settings?.length ? (
          <Chip icon={glyph.sliders} onClick={() => editWidgetSettings(instances[0]!.id)} />
        ) : null}
        <Chip
          label={placed ? `Adicionar outro (${placed})` : "Adicionar"}
          tone={placed ? undefined : "primary"}
          onClick={() => addWidget(definition.type)}
        />
      </Row>
    </Column>
  );
}

/** Six dots: the drag handle. */
const GRIP = [
  ["circle", { cx: 9, cy: 6, r: 1 }],
  ["circle", { cx: 15, cy: 6, r: 1 }],
  ["circle", { cx: 9, cy: 12, r: 1 }],
  ["circle", { cx: 15, cy: 12, r: 1 }],
  ["circle", { cx: 9, cy: 18, r: 1 }],
  ["circle", { cx: 15, cy: 18, r: 1 }],
] as const;

function DockOrder() {
  return (
    <Column style={{ gap: 8 }}>
      <Text size={15} weight={700} color="#fff">
        Seu dock
      </Text>
      <Text size={11} color={ui.muted}>
        Ordem da esquerda para a direita. Arraste para reordenar, aqui ou no próprio dock; o "−" vermelho no dock remove.
      </Text>
      <Row style={{ gap: 6, wrap: true }}>
        {config.widgets.map((instance) => (
          <Pressable
            key={instance.id}
            {...widgetDragProps(instance.id, "gallery-widget:")}
            style={{
              position: "relative",
              direction: "row",
              align: "center",
              gap: 4,
              padding: 4,
              radius: 10,
              cursor: "grab",
              background: "rgba(255,255,255,0.05)",
              opacity: widgetDrag.source === instance.id ? 0.4 : 1,
              hover: { background: "rgba(255,255,255,0.08)" },
            }}
          >
            {dropSide(instance.id) ? (
              <View
                style={{ position: "absolute", top: 4, bottom: 4, width: 3, radius: 2, background: ui.blue, [dropSide(instance.id)!]: -5 }}
              />
            ) : null}
            <Icon iconNode={GRIP} size={14} color={ui.muted} strokeWidth={2.2} />
            <Chip icon="chevron-left" onClick={() => moveWidget(instance.id, -1)} />
            <Text size={12} weight={600} color="#fff" style={{ padding: { left: 4, right: 4 } }}>
              {getWidget(instance.type)?.name ?? instance.type}
            </Text>
            <Chip icon="chevron-right" onClick={() => moveWidget(instance.id, 1)} />
            <Chip icon="x" tone="danger" onClick={() => removeWidget(instance.id)} />
          </Pressable>
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
          <Text size={11} weight={600} color={ui.muted} style={{ padding: { left: 10, bottom: 4, top: 6 } }}>
            CONFIGURAÇÕES
          </Text>
          <SidebarItem
            label="Barra de tarefas"
            icon="settings"
            active={gallery.page === "settings"}
            onClick={() => (gallery.page = "settings")}
          />
          <Text size={11} weight={600} color={ui.muted} style={{ padding: { left: 10, bottom: 4, top: 16 } }}>
            WIDGETS
          </Text>
          <SidebarItem
            label="Todos"
            count={widgets.length}
            active={gallery.page === "widgets" && gallery.category === "all"}
            onClick={() => Object.assign(gallery, { page: "widgets", category: "all" })}
          />
          {categories.map((c) => {
            const count = widgets.filter((w) => w.category === c).length;
            if (!count) return null;
            return (
              <SidebarItem
                key={c}
                label={categoryLabels[c]}
                count={count}
                active={gallery.page === "widgets" && gallery.category === c}
                onClick={() => Object.assign(gallery, { page: "widgets", category: c })}
              />
            );
          })}
        </Column>
        <Scroll style={{ flex: 1, minHeight: 0, alignSelf: "stretch" }}>
          {gallery.page === "settings" ? (
            <SettingsPage />
          ) : (
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
          )}
        </Scroll>
      </Row>
        <WidgetSettingsModal />
    </Window>
  );
}
