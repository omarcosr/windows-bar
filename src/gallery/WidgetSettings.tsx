import { Column, Input, Modal, Row, Text, Select } from "@tarve/core";
import { config } from "../config";
import { ui } from "../theme";
import { mountWidget } from "../widgets/host";
import { getWidget } from "../widgets/registry";
import { activeSettings, editWidgetSettings, setSetting, widgetSettings } from "../widgets/settings";
import type { WidgetSetting } from "../widgets/types";
import { Button, Choice, Setting, Toggle } from "./Settings";

import { t } from "../i18n";
type AnySetting = WidgetSetting<Record<string, unknown>>;

/** A text option: label above a full-width field, so long keys have room. */
function TextSetting(props: { setting: Extract<AnySetting, { kind: "text" }>; value: string; onChange: (v: string) => void }) {
  const { setting } = props;
  return (
    <Column
      style={{
        gap: 8,
        shrink: 0,
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

/** A file option: the chosen file's name, and buttons to pick one with the Open dialog or clear it. */
function FileSetting(props: {
  setting: Extract<AnySetting, { kind: "file" }>;
  value: string;
  pick: () => Promise<string | undefined>;
  onChange: (v: string) => void;
}) {
  const name = props.value.split(/[\\/]/).pop() ?? "";
  return (
    <Setting label={props.setting.label} description={props.value ? name : props.setting.description}>
      <Row style={{ gap: 6 }}>
        {props.value ? <Button label={t("widgetSettings.remove")} onClick={() => props.onChange("")} /> : null}
        <Button label={t("widgetSettings.choose")} onClick={() => void props.pick().then((path) => path && props.onChange(path))} />
      </Row>
    </Setting>
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
      // As a Windows ContentDialog: only Esc or the close button dismiss it. Closing on an outside
      // click also closed it when a drop-down option hanging past the dialog was picked.
      closeOnOverlay={false}
      closeOnEscape
      showClose
      style={{ background: "#1f1f22", borderColor: "rgba(255,255,255,0.08)" }}
    >
      {widget && instance ? (
        // shrink: 0 keeps the list at its full height so the dialog's body scrolls; shrunk to fit, the
        // rows were squeezed over each other and nothing was left to scroll. The right margin is the
        // scroll bar's lane, which otherwise lay over the controls' edge.
        <Column style={{ gap: 0, shrink: 0, margin: { top: 4, right: 10 }, radius: 12, overflow: "hidden", background: "rgba(255,255,255,0.04)" }}>
          {siblings.length > 1 ? (
            <Setting label={t("widgetSettings.whichOne")} description={t("widgetSettings.thereIsMoreThan")}>
              <ChoiceSetting
                id={`${instance.id}-sibling`}
                value={instance.id}
                options={siblings.map((w, i) => ({ value: w.id, label: `${i + 1}º` }))}
                onChange={(id) => editWidgetSettings(id)}
              />
            </Setting>
          ) : null}
          {settings.map((s) =>
            s.kind === "file" ? (
            <FileSetting
              key={s.key}
              setting={s}
              value={String(widget.ctx.config[s.key] ?? "")}
              pick={() => widget.ctx.app.openFileDialog({ title: s.label, filters: s.filters?.map((f) => ({ name: f.name, extensions: [...f.extensions] })) })}
              onChange={(v) => setSetting(widget.ctx, s.key, v)}
            />
          ) : s.kind === "text" ? (
              <TextSetting key={s.key} setting={s} value={String(widget.ctx.config[s.key] ?? "")} onChange={(v) => setSetting(widget.ctx, s.key, v)} />
            ) : (
              <Setting key={s.key} label={s.label} description={s.description}>
                {s.kind === "toggle" ? (
                  <Toggle label={s.label} checked={widget.ctx.config[s.key] === true} onChange={(v) => setSetting(widget.ctx, s.key, v)} />
                ) : (
                  <ChoiceSetting
                    id={`${instance.id}-${s.key}`}
                    value={String(widget.ctx.config[s.key] ?? "")}
                    options={s.options}
                    onChange={(v) => setSetting(widget.ctx, s.key, v)}
                  />
                )}
              </Setting>
            ),
          )}
        </Column>
      ) : null}
    </Modal>
  );
}

/**
 * Segmented buttons while they fit beside the label, a drop-down otherwise, as Windows Settings
 * switches to a ComboBox for long lists: a row of nine currencies squeezed the label to one letter
 * per line, spilling over the rows around it.
 */
function ChoiceSetting(props: {
  id: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  // Segment: 12 px semibold text (~6.6 px a character) + 20 px padding, 3 px apart, 3 px frame.
  const width = props.options.reduce((sum, o) => sum + o.label.length * 6.6 + 20, 0) + 3 * (props.options.length + 1);
  if (width <= CHOICE_MAX_WIDTH) return <Choice value={props.value} options={props.options} onChange={props.onChange} />;
  return (
    <Select
      id={props.id}
      value={props.value}
      options={props.options}
      onValueChange={props.onChange}
      style={{ width: SELECT_WIDTH }}
    />
  );
}

/** The modal row (520 − 48 padding − 32 inset − 16 gap) less a 160 px label column. */
const CHOICE_MAX_WIDTH = 264;
/** Wide enough for "Relógio adicional 1 do Windows" on one line at the Select's 14 px. */
const SELECT_WIDTH = 260;
