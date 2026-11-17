import { Column, Image, Pressable, Row, Slider, Switch, Text, View, type Child } from "@tarve/core";
import { config, defaultConfig, saveConfig, type DockConfig } from "../config";
import { setAutostart } from "../services/autostart";
import { APP_VERSION, checkNow, download, restartToUpdate, updater } from "../services/updater";
import { launch } from "../services/windows";
import { taskbarPrefs } from "../services/taskbar-prefs";
import { BAR_HEIGHT_MAX, BAR_HEIGHT_MIN, dockBackground, numeric, ui } from "../theme";
import { glowColors, hoverEffects, iconHover } from "../widgets/ui";
import { iconFor } from "../services/icons";
import { desktop } from "../services/windows";

/** Sets one setting and saves. */
function set<K extends keyof DockConfig>(key: K, value: DockConfig[K]) {
  config[key] = value;
  saveConfig();
}

function Section(props: { title: string; description?: string; children: Child }) {
  return (
    <Column style={{ gap: 8 }}>
      <Column style={{ gap: 2, padding: { left: 4 } }}>
        <Text size={14} weight={700} color="#fff">
          {props.title}
        </Text>
        {props.description ? (
          <Text size={11} color={ui.muted}>
            {props.description}
          </Text>
        ) : null}
      </Column>
      <Column
        style={{
          radius: 12,
          background: "rgba(255,255,255,0.04)",
          borderWidth: 1,
          borderColor: "rgba(255,255,255,0.06)",
          overflow: "hidden",
        }}
      >
        {props.children}
      </Column>
    </Column>
  );
}

/** One setting, name and explanation on the left and its control on the right; `when={false}` leaves it out (it does not apply to the current choices). */
export function Setting(props: { label: string; description?: string; when?: boolean; children: Child }) {
  if (props.when === false) return null;
  return (
    <Row
      style={{
        align: "center",
        gap: 16,
        minHeight: 56,
        padding: { left: 16, right: 16, top: 10, bottom: 10 },
        borderWidth: { top: 1 },
        borderColor: "rgba(255,255,255,0.05)",
      }}
    >
      <Column style={{ flex: 1, gap: 2, minWidth: 0 }}>
        <Text size={13} weight={500} color="#fff">
          {props.label}
        </Text>
        {props.description ? (
          <Text size={11} color={ui.muted}>
            {props.description}
          </Text>
        ) : null}
      </Column>
      <View style={{ shrink: 0, align: "end" }}>{props.children}</View>
    </Row>
  );
}

export function Choice<T extends string>(props: { value: T; options: readonly { value: T; label: string }[]; onChange: (value: T) => void }) {
  return (
    <Row style={{ gap: 3, padding: 3, radius: 9, background: "rgba(255,255,255,0.06)" }}>
      {props.options.map((o) => {
        const on = o.value === props.value;
        return (
          <Pressable
            key={o.value}
            onClick={() => props.onChange(o.value)}
            style={{
              height: 28,
              padding: { left: 10, right: 10 },
              radius: 7,
              align: "center",
              justify: "center",
              cursor: "pointer",
              background: on ? "rgba(255,255,255,0.14)" : "transparent",
              hover: { background: on ? "rgba(255,255,255,0.14)" : "rgba(255,255,255,0.07)" },
            }}
          >
            <Text size={12} weight={600} color={on ? "#fff" : ui.muted}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </Row>
  );
}

function Range(props: {
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  label: string;
  onChange: (v: number) => void;
}) {
  return (
    <Row style={{ align: "center", gap: 10, width: 260 }}>
      <View style={{ flex: 1 }}>
        <Slider label={props.label} value={props.value} min={props.min} max={props.max} step={props.step} onValueChange={props.onChange} />
      </View>
      <Text size={12} color={ui.muted} style={{ ...numeric, width: 52, textAlign: "right" }}>
        {`${props.value}${props.unit}`}
      </Text>
    </Row>
  );
}

export function Toggle(props: { checked: boolean; label: string; onChange: (v: boolean) => void; disabled?: boolean }) {
  return <Switch label="" aria-label={props.label} checked={props.checked} disabled={props.disabled} onCheckedChange={props.onChange} />;
}

function Button(props: { label: string; danger?: boolean; onClick: () => void }) {
  return (
    <Pressable
      onClick={props.onClick}
      style={{
        height: 30,
        padding: { left: 12, right: 12 },
        radius: 8,
        align: "center",
        justify: "center",
        cursor: "pointer",
        background: props.danger ? "rgba(255,69,58,0.14)" : "rgba(255,255,255,0.08)",
        hover: { background: props.danger ? "rgba(255,69,58,0.22)" : "rgba(255,255,255,0.13)" },
        active: { transform: "scale(0.97)" },
      }}
    >
      <Text size={12} weight={600} color={props.danger ? ui.danger : "#fff"}>
        {props.label}
      </Text>
    </Pressable>
  );
}

/** A small dock with the apps' own icons, wearing the current hover effect. */
function HoverPreview() {
  const exes = desktop.apps
    .map((a) => a.exe)
    .filter(Boolean)
    .slice(0, 4);
  return (
    <Row style={{ gap: 0, padding: 6, radius: 14, background: dockBackground(config.opacity), align: "center" }}>
      {exes.map((exe) => {
        const icon = iconFor(exe, 30);
        return (
          <Pressable
            key={exe}
            style={{ width: 44, height: 44, radius: 10, align: "center", justify: "center", cursor: "pointer", ...iconHover() }}
          >
            {icon ? (
              <Image src={icon} width={30} height={30} fit="contain" />
            ) : (
              <View style={{ width: 30, height: 30, radius: 8, background: "#3a3a40" }} />
            )}
          </Pressable>
        );
      })}
    </Row>
  );
}

/** Version, update state and the one action that fits it. */
function UpdateSetting() {
  const s = updater.status;
  const description =
    s === "unsupported"
      ? "Atualizações automáticas funcionam na versão instalada pelo instalador."
      : s === "checking"
        ? "Procurando…"
        : s === "current"
          ? "Você está na versão mais recente."
          : s === "available"
            ? `Versão ${updater.version} disponível.`
            : s === "downloading"
              ? `Baixando a versão ${updater.version}… ${Math.round(updater.progress * 100)}%`
              : s === "ready"
                ? `Versão ${updater.version} pronta para instalar.`
                : s === "error"
                  ? `Não foi possível verificar: ${updater.error}`
                  : "Procura novas versões no GitHub.";
  return (
    <Setting label={`Atualizações · versão ${APP_VERSION}`} description={description}>
      {s === "ready" ? (
        <Button label="Reiniciar e atualizar" onClick={restartToUpdate} />
      ) : s === "available" ? (
        <Button label="Baixar" onClick={() => void download()} />
      ) : s === "unsupported" || s === "downloading" || s === "checking" ? (
        <View />
      ) : (
        <Button label="Procurar agora" onClick={() => void checkNow()} />
      )}
    </Setting>
  );
}

/** The taskbar's own settings page, grouped like Windows Settings. */
export function SettingsPage() {
  const floating = config.mode === "floating";
  const full = config.mode === "full";
  const strip = floating && config.reserveSpace;
  return (
    <Column style={{ padding: 24, gap: 24, maxWidth: 760 }}>
      <Column style={{ gap: 4 }}>
        <Text size={22} weight={700} color="#fff">
          Barra de tarefas
        </Text>
        <Text size={12} color={ui.muted}>
          As mudanças valem na hora.
        </Text>
      </Column>

      <Section title="Aparência">
        <Setting
          label="Estilo"
          description="Flutuante centraliza o dock acima da borda; barra inteira ocupa a largura toda, como a do Windows."
        >
          <Choice
            value={config.mode}
            options={[
              { value: "floating", label: "Flutuante" },
              { value: "full", label: "Barra inteira" },
            ]}
            onChange={(v) => set("mode", v)}
          />
        </Setting>
        <Setting label="Altura" description="Ícones e widgets acompanham a altura.">
          <Range
            label="Altura"
            value={ui.dock.height}
            min={BAR_HEIGHT_MIN}
            max={BAR_HEIGHT_MAX}
            step={2}
            unit=" px"
            onChange={(v) => set("barHeight", Math.round(v / 2) * 2)}
          />
        </Setting>
        <Setting label="Cantos arredondados" when={floating}>
          <Range
            label="Cantos"
            value={ui.dock.radius}
            min={0}
            max={32}
            step={1}
            unit=" px"
            onChange={(v) => floating && set("cornerRadius", Math.round(v))}
          />
        </Setting>
        <Setting label="Opacidade do fundo" description="Ícones e widgets continuam sólidos.">
          <Range
            label="Opacidade"
            value={Math.round(config.opacity * 100)}
            min={20}
            max={100}
            step={5}
            unit="%"
            onChange={(v) => set("opacity", Math.round(v) / 100)}
          />
        </Setting>
        <Setting label="Espaço entre widgets">
          <Range
            label="Espaço"
            value={ui.dock.gap}
            min={0}
            max={16}
            step={1}
            unit=" px"
            onChange={(v) => set("widgetGap", Math.round(v))}
          />
        </Setting>
      </Section>

      <Section title="Posição e espaço na tela">
        <Setting
          label="Alinhamento"
          description={`Onde ficam o Iniciar e os apps. "Seguir o Windows" usa o alinhamento da barra do Windows (agora: ${taskbarPrefs.align === "left" ? "esquerda" : "centro"}).`}
        >
          <Choice
            value={config.align}
            options={[
              { value: "system", label: "Seguir o Windows" },
              { value: "center", label: "Centro" },
              { value: "left", label: "Esquerda" },
            ]}
            onChange={(v) => set("align", v)}
          />
        </Setting>
        <Setting label="Distância da borda" description="Espaço entre o dock flutuante e a borda da tela." when={floating}>
          <Range
            label="Distância"
            value={config.bottomMargin}
            min={0}
            max={24}
            step={1}
            unit=" px"
            onChange={(v) => floating && set("bottomMargin", Math.round(v))}
          />
        </Setting>
        <Setting label="Reservar espaço na tela" description="Janelas maximizadas param acima da barra.">
          <Toggle label="Reservar espaço" checked={config.reserveSpace} onChange={(v) => set("reserveSpace", v)} />
        </Setting>
        <Setting label="Fundo do espaço segue a tela" description="Pinta a faixa embaixo do dock com a cor do app aberto." when={strip}>
          <Toggle
            label="Fundo segue a tela"
            checked={config.stripFollowsApp}
            disabled={!strip}
            onChange={(v) => set("stripFollowsApp", v)}
          />
        </Setting>
        <Setting
          label="Animação da troca de cor"
          description="A cor nova desce em degradê; desligado, troca na hora."
          when={strip && config.stripFollowsApp}
        >
          <Toggle
            label="Animação"
            checked={config.colorTransition}
            disabled={!strip || !config.stripFollowsApp}
            onChange={(v) => set("colorTransition", v)}
          />
        </Setting>
        <Setting label="Mostrar área de trabalho no canto da barra" description="Clique no canto direito para mostrar a área de trabalho ou restaurar as janelas.">
          <Toggle label="Mostrar área de trabalho no canto da barra" checked={config.showDesktop} onChange={(v) => set("showDesktop", v)} />
        </Setting>
        <Setting
          label="Esconder a barra do Windows"
          description={full ? "A barra inteira sempre esconde a do Windows." : "A barra do Windows volta quando o WindowsBar fecha."}
        >
          <Toggle
            label="Esconder a barra do Windows"
            checked={config.hideNativeTaskbar || full}
            disabled={full}
            onChange={(v) => !full && set("hideNativeTaskbar", v)}
          />
        </Setting>
      </Section>

      <Section title="Efeito ao passar o mouse" description="Vale para os apps, o botão Iniciar e os ícones da bandeja.">
        <Setting label="Efeito">
          <Choice value={config.hoverEffect} options={hoverEffects} onChange={(v) => set("hoverEffect", v)} />
        </Setting>
        <Setting label="Experimente" description="Passe o mouse nos ícones ao lado." when={config.hoverEffect !== "none"}>
          <HoverPreview />
        </Setting>
        <Setting
          label="Intensidade"
          description={
            {
              zoom: "Quanto o ícone cresce.",
              lift: "Quanto o ícone sobe.",
              glow: "Força do brilho.",
              highlight: "Quão claro fica o fundo.",
              none: "",
            }[config.hoverEffect]
          }
          when={config.hoverEffect !== "none"}
        >
          <Range
            label="Intensidade"
            value={config.hoverIntensity}
            min={25}
            max={200}
            step={5}
            unit="%"
            onChange={(v) => config.hoverEffect !== "none" && set("hoverIntensity", Math.round(v))}
          />
        </Setting>
        <Setting label="Velocidade da animação" description="Menor é mais rápido; 0 troca na hora." when={config.hoverEffect !== "none"}>
          <Range
            label="Velocidade"
            value={config.hoverSpeed}
            min={0}
            max={500}
            step={10}
            unit=" ms"
            onChange={(v) => config.hoverEffect !== "none" && set("hoverSpeed", Math.round(v))}
          />
        </Setting>
        <Setting label="Cor do brilho" when={config.hoverEffect === "glow"}>
          <Row style={{ gap: 6 }}>
            {glowColors.map((g) => {
              const on = config.glowColor === g.value;
              return (
                <Pressable
                  key={g.value}
                  aria-label={g.label}
                  onClick={() => config.hoverEffect === "glow" && set("glowColor", g.value)}
                  style={{
                    width: 26,
                    height: 26,
                    radius: 13,
                    cursor: "pointer",
                    background: g.color ?? taskbarPrefs.accent,
                    borderWidth: 2,
                    borderColor: on ? "#fff" : "rgba(255,255,255,0.12)",
                    align: "center",
                    justify: "center",
                    hover: { transform: "scale(1.1)" },
                  }}
                >
                  {g.value === "accent" ? (
                    <Text size={9} weight={800} color="#fff">
                      W
                    </Text>
                  ) : null}
                </Pressable>
              );
            })}
          </Row>
        </Setting>
        <Setting label="Afundar ao clicar" description="O ícone encolhe um pouco enquanto é pressionado.">
          <Toggle label="Afundar ao clicar" checked={config.pressEffect} onChange={(v) => set("pressEffect", v)} />
        </Setting>
      </Section>

      <Section title="Ícones e janelas">
        <Setting label="Tamanho dos ícones" description="Apps, botão Iniciar e bandeja; relativo à altura da barra.">
          <Range
            label="Tamanho"
            value={config.iconScale}
            min={70}
            max={130}
            step={5}
            unit="%"
            onChange={(v) => set("iconScale", Math.round(v))}
          />
        </Setting>
        <Setting label="Indicador de apps abertos" description="O traço embaixo do ícone.">
          <Toggle label="Indicador" checked={config.runningIndicator} onChange={(v) => set("runningIndicator", v)} />
        </Setting>
        <Setting label="Ícones empilhados" description="Uma cópia atrás do ícone quando o app tem várias janelas.">
          <Toggle label="Empilhados" checked={config.stackedIcons} onChange={(v) => set("stackedIcons", v)} />
        </Setting>
        <Setting label="Clique em app com várias janelas">
          <Choice
            value={config.multiWindowClick}
            options={[
              { value: "list", label: "Mostrar janelas" },
              { value: "recent", label: "Abrir a última" },
            ]}
            onChange={(v) => set("multiWindowClick", v)}
          />
        </Setting>
        <Setting label="Preview ao passar o mouse" description="Miniaturas das janelas acima do ícone.">
          <Toggle label="Preview" checked={config.hoverPreview} onChange={(v) => set("hoverPreview", v)} />
        </Setting>
        <Setting label="Tempo até o preview abrir" when={config.hoverPreview}>
          <Range
            label="Tempo"
            value={config.previewDelay}
            min={0}
            max={1500}
            step={50}
            unit=" ms"
            onChange={(v) => config.hoverPreview && set("previewDelay", Math.round(v))}
          />
        </Setting>
      </Section>

      <Section title="Sistema">
        <Setting label="Iniciar com o Windows">
          <Toggle
            label="Iniciar com o Windows"
            checked={config.autostart}
            onChange={(v) => {
              set("autostart", v);
              void setAutostart(v);
            }}
          />
        </Setting>
        <UpdateSetting />
        <Setting label="Baixar atualizações automaticamente" description="A nova versão é instalada quando você reinicia o WindowsBar.">
          <Toggle label="Baixar automaticamente" checked={config.autoUpdate} onChange={(v) => set("autoUpdate", v)} />
        </Setting>
        <Setting label="Configurações da barra do Windows" description="Ícones da bandeja, alinhamento e comportamentos do Windows.">
          <Button label="Abrir" onClick={() => launch("ms-settings:taskbar")} />
        </Setting>
        <Setting label="Restaurar padrões" description="Volta todas as opções desta página ao original. Widgets e apps fixados não mudam.">
          <Button
            label="Restaurar"
            danger
            onClick={() => {
              const { widgets: _widgets, autostart: _autostart, version: _version, ...defaults } = defaultConfig();
              Object.assign(config, defaults);
              saveConfig();
            }}
          />
        </Setting>
      </Section>
    </Column>
  );
}
