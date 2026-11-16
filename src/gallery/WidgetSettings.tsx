import { Column, Input, Modal, Text } from "@tarve/core";
import { config } from "../config";
import { ui } from "../theme";
import { mountWidget } from "../widgets/host";
import { getWidget } from "../widgets/registry";
import { activeSettings, editWidgetSettings, setSetting, widgetSettings } from "../widgets/settings";
import type { WidgetSetting } from "../widgets/types";
import { Choice, Setting, Toggle } from "./Settings";

type AnySetting = WidgetSetting<Record<string, unknown>>;

/** A text option: label above a full-width field, so long keys have room. */
function TextSetting(props: { setting: Extract<AnySetting, { kind: "text" }>; value: string; onChange: (v: string) => void }) {
  const { setting } = props;
  return (
    <Column
      style={{
        gap: 8,
        padding: { left: 16, right: 16, top: 12, bottom: 14 },
        borderWidth: { top: 1 },
        borderColor: "rgba(255,255,255,0.05)",
      }}
    >
      <Column style={{ gap: 2 }}>
        <Text size={13} weight={500} color="#fff">
          {setting.label}
        </Text>
        {setting.description ? (
          <Text size={11} color={ui.muted}>
            {setting.description}
          </Text>
        ) : null}
      </Column>
      <Input
        type={setting.secret ? "password" : "text"}
        aria-label={setting.label}
        value={props.value}
        placeholder={setting.placeholder}
        onChange={props.onChange}
      />
    </Column>
  );
}

/** Popup with the options of one placed widget, drawn from its `settings`. */
export function WidgetSettingsModal() {
  const instance = config.widgets.find((w) => w.id === widgetSettings.editing);
  const definition = instance && getWidget(instance.type);
  const widget = instance && definition?.settings?.length ? mountWidget(instance) : undefined;
  const siblings = instance ? config.widgets.filter((w) => w.type === instance.type) : [];
  const settings = widget && definition ? activeSettings(definition.settings as AnySetting[], widget.ctx.config) : [];
  return (
    <Modal
      open={!!widget}
      onOpenChange={(o) => !o && editWidgetSettings(null)}
      title={definition?.name ?? ""}
      description={definition?.description}
      width={520}
      closeOnOverlay
      closeOnEscape
      showClose
    >
      {widget && instance ? (
        <Column style={{ gap: 0, margin: { top: 4 }, radius: 12, overflow: "hidden", background: "rgba(255,255,255,0.04)" }}>
          {siblings.length > 1 ? (
            <Setting label="Qual deles" description="Há mais de um deste widget no dock; cada um tem suas opções.">
              <Choice
                value={instance.id}
                options={siblings.map((w, i) => ({ value: w.id, label: `${i + 1}º` }))}
                onChange={(id) => editWidgetSettings(id)}
              />
            </Setting>
          ) : null}
          {settings.map((s) =>
            s.kind === "text" ? (
              <TextSetting
                key={s.key}
                setting={s}
                value={String(widget.ctx.config[s.key] ?? "")}
                onChange={(v) => setSetting(widget.ctx, s.key, v)}
              />
            ) : (
              <Setting key={s.key} label={s.label} description={s.description}>
                {s.kind === "toggle" ? (
                  <Toggle label={s.label} checked={widget.ctx.config[s.key] === true} onChange={(v) => setSetting(widget.ctx, s.key, v)} />
                ) : (
                  <Choice value={String(widget.ctx.config[s.key] ?? "")} options={s.options} onChange={(v) => setSetting(widget.ctx, s.key, v)} />
                )}
              </Setting>
            ),
          )}
        </Column>
      ) : null}
    </Modal>
  );
}
