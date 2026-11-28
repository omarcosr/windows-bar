import { Column, Image, Pressable, Row, Slider, Switch, Text, View, type Child } from "@tarve/core";
import { config, defaultConfig, followsAppColor, reservesSpace, saveConfig, type DockConfig } from "../config";
import { setAutostart } from "../services/autostart";
import { APP_VERSION, checkNow, download, restartToUpdate, updater } from "../services/updater";
import { launch } from "../services/windows";
import { taskbarPrefs } from "../services/taskbar-prefs";
import { BAR_HEIGHT_MAX, BAR_HEIGHT_MIN, configuredHeight, dockBackground, numeric, ui } from "../theme";
import { glowColors, hoverEffects, iconHover } from "../widgets/ui";
import { magnifyRowProps, magnifyStyles, type MagnifyMetrics } from "../widgets/magnify";
import { iconFor } from "../services/icons";
import { desktop } from "../services/windows";
import { languagePending, restartApp, t } from "../i18n";

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
        shrink: 0,
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
        <Slider label={props.label} value={props.value} min={props.min} max={props.max} step={props.step} onValueChange={props.onChange} style={{ width: "100%" }} />
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

export function Button(props: { label: string; danger?: boolean; onClick: () => void }) {
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
  // The row is right-aligned in its setting, so the macOS effect grows it to the left (anchor 1).
  const metrics: MagnifyMetrics = { slot: 44, icon: 30, height: 44, headroom: 14 };
  const row = magnifyRowProps("preview", () => ({ count: exes.length, slot: 44, inset: 6, anchor: 1 }));
  return (
      <Row {...row} style={{ gap: 0, padding: 6, radius: 14, background: dockBackground(config.opacity), align: "center" }}>
        {exes.map((exe, index) => {
          const icon = iconFor(exe, 30);
          const magnify = magnifyStyles("preview", index, metrics);
          return (
            <Pressable
              key={exe}
              style={{ width: 44, height: 44, radius: 10, align: "center", justify: "center", cursor: "pointer", position: "relative", ...iconHover({ magnified: true }), ...magnify.slot }}
            >
              <View style={magnify.box}>
                {icon ? (
                  <Image src={icon} width={30} height={30} fit="contain" style={{ radius: 0, ...magnify.icon }} />
                ) : (
                  <View style={{ radius: 8, background: "#3a3a40", ...magnify.icon }} />
                )}
              </View>
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
      ? t("settings.automaticUpdatesWorkIn")
      : s === "checking"
        ? t("settings.checking")
        : s === "current"
          ? t("settings.youreOnLatestVersion")
          : s === "available"
            ? t("settings.versionAvailable", { version: updater.version })
            : s === "downloading"
              ? t("settings.downloadingVersion", { version: updater.version, p1: Math.round(updater.progress * 100) })
              : s === "ready"
                ? t("settings.versionReadyToInstall", { version: updater.version })
                : s === "error"
                  ? t("settings.couldntCheck", { error: updater.error })
                  : t("settings.checksGithubForNew");
  return (
    <Setting label={t("settings.updatesVersion", { APP_VERSION })} description={description}>
      {s === "ready" ? (
        <Button label={t("settings.restartAndUpdate")} onClick={restartToUpdate} />
      ) : s === "available" ? (
        <Button label={t("settings.download")} onClick={() => void download()} />
      ) : s === "unsupported" || s === "downloading" || s === "checking" ? (
        <View />
      ) : (
        <Button label={t("settings.checkNow")} onClick={() => void checkNow()} />
      )}
    </Setting>
  );
}

/** The taskbar's own settings page, grouped like Windows Settings. */
export function SettingsPage() {
  const floating = config.mode === "floating";
  const full = config.mode === "full";
  const strip = floating && reservesSpace();
  return (
    <Column style={{ padding: 24, gap: 24, maxWidth: 760 }}>
      <Column style={{ gap: 4 }}>
        <Text size={22} weight={700} color="#fff">
          {t("settings.taskbar")}
        </Text>
        <Text size={12} color={ui.muted}>
          {t("settings.changesApplyRightAway")}
        </Text>
      </Column>

      <Section title={t("settings.appearance")}>
        <Setting
          label={t("settings.style")}
          description={t("settings.floatingCentersDockAbove")}
        >
          <Choice
            value={config.mode}
            options={[
              { value: "floating", label: t("settings.floating") },
              { value: "full", label: t("settings.fullBar") },
            ]}
            onChange={(v) => set("mode", v)}
          />
        </Setting>
        <Setting label={t("settings.height")} description={t("settings.iconsAndWidgetsFollow")}>
          <Toggle
            checked={!config.barHeight}
            label={t("settings.sameAsWindowsTaskbar")}
            onChange={(v) => set("barHeight", v ? 0 : configuredHeight())}
          />
        </Setting>
        <Setting label={t("settings.customHeight")} when={!!config.barHeight}>
          <Range
            label={t("settings.height")}
            value={configuredHeight()}
            min={BAR_HEIGHT_MIN}
            max={BAR_HEIGHT_MAX}
            step={2}
            unit=" px"
            onChange={(v) => set("barHeight", Math.round(v / 2) * 2)}
          />
        </Setting>
        <Setting label={t("settings.roundedCorners")} when={floating}>
          <Range
            label={t("settings.corners")}
            value={ui.dock.radius}
            min={0}
            max={32}
            step={1}
            unit=" px"
            onChange={(v) => floating && set("cornerRadius", Math.round(v))}
          />
        </Setting>
        <Setting label={t("settings.backgroundOpacity")} description={t("settings.iconsAndWidgetsStay")}>
          <Range
            label={t("settings.opacity")}
            value={Math.round(config.opacity * 100)}
            min={0}
            max={100}
            step={5}
            unit="%"
            onChange={(v) => set("opacity", Math.round(v) / 100)}
          />
        </Setting>
        <Setting label={t("settings.joinWidgets")} description={t("settings.widgetsSideBySide")}>
          <Toggle checked={config.joinWidgets === true} label={t("settings.joinWidgets")} onChange={(v) => set("joinWidgets", v)} />
        </Setting>
        <Setting label={t("settings.spaceBetweenWidgets")} when={config.joinWidgets !== true}>
          <Range
            label={t("settings.spacing")}
            value={ui.dock.gap}
            min={0}
            max={16}
            step={1}
            unit=" px"
            onChange={(v) => set("widgetGap", Math.round(v))}
          />
        </Setting>
      </Section>

      <Section title={t("settings.positionAndScreenSpace")}>
        <Setting
          label={t("settings.alignment")}
          description={t("settings.whereStartAndApps", { p0: taskbarPrefs.align === "left" ? t("settings.left") : t("settings.center") })}
        >
          <Choice
            value={config.align}
            options={[
              { value: "system", label: t("settings.followWindows") },
              { value: "center", label: t("settings.center2") },
              { value: "left", label: t("settings.left2") },
            ]}
            onChange={(v) => set("align", v)}
          />
        </Setting>
        <Setting label={t("settings.distanceFromEdge")} description={t("settings.spaceBetweenFloatingDock")} when={floating}>
          <Range
            label={t("settings.distance")}
            value={config.bottomMargin}
            min={0}
            max={24}
            step={1}
            unit=" px"
            onChange={(v) => floating && set("bottomMargin", Math.round(v))}
          />
        </Setting>
        <Setting
          label={t("settings.reserveScreenSpace")}
          description={config.autoHide ? t("settings.autoHideReservesNothing") : t("settings.maximizedWindowsStopAbove")}
        >
          <Toggle
            label={t("settings.reserveSpace")}
            checked={reservesSpace()}
            disabled={config.autoHide}
            onChange={(v) => !config.autoHide && set("reserveSpace", v)}
          />
        </Setting>
        <Setting label={t("settings.spaceBackgroundFollowsScreen")} description={t("settings.paintsStripUnderDock")} when={strip}>
          <Toggle
            label={t("settings.backgroundFollowsScreen")}
            checked={config.stripFollowsApp}
            disabled={!strip}
            onChange={(v) => set("stripFollowsApp", v)}
          />
        </Setting>
        <Setting label={t("settings.barBackgroundFollowsScreen")} description={t("settings.paintsFullBar")} when={full && reservesSpace()}>
          <Toggle label={t("settings.backgroundFollowsScreen")} checked={config.fullFollowsApp} onChange={(v) => set("fullFollowsApp", v)} />
        </Setting>
        <Setting
          label={t("settings.colorChangeAnimation")}
          description={t("settings.newColorSlidesDown")}
          when={followsAppColor()}
        >
          <Toggle
            label={t("settings.animation")}
            checked={config.colorTransition}
            disabled={!followsAppColor()}
            onChange={(v) => set("colorTransition", v)}
          />
        </Setting>
        <Setting label={t("settings.showDesktopInBar")} description={t("settings.clickRightCornerTo")}>
          <Toggle label={t("settings.showDesktopInBar")} checked={config.showDesktop} onChange={(v) => set("showDesktop", v)} />
        </Setting>
        <Setting
          label={t("settings.hideWindowsTaskbar")}
          description={full ? t("settings.fullBarAlwaysHides") : t("settings.windowsTaskbarComesBack")}
        >
          <Toggle
            label={t("settings.hideWindowsTaskbar")}
            checked={config.hideNativeTaskbar || full}
            disabled={full}
            onChange={(v) => !full && set("hideNativeTaskbar", v)}
          />
        </Setting>
      </Section>

      <Section title={t("settings.autoHide")} description={t("settings.autoHideDescription")}>
        <Setting label={t("settings.autoHide")}>
          <Toggle label={t("settings.autoHide")} checked={config.autoHide} onChange={(v) => set("autoHide", v)} />
        </Setting>
        <Setting label={t("settings.autoHideShowDelay")} description={t("settings.autoHideShowDelayDescription")} when={config.autoHide}>
          <Range
            label={t("settings.autoHideShowDelay")}
            value={config.autoHideShowDelay}
            min={0}
            max={1000}
            step={25}
            unit=" ms"
            onChange={(v) => set("autoHideShowDelay", Math.round(v))}
          />
        </Setting>
        <Setting label={t("settings.autoHideHideDelay")} description={t("settings.autoHideHideDelayDescription")} when={config.autoHide}>
          <Range
            label={t("settings.autoHideHideDelay")}
            value={config.autoHideHideDelay}
            min={0}
            max={3000}
            step={50}
            unit=" ms"
            onChange={(v) => set("autoHideHideDelay", Math.round(v))}
          />
        </Setting>
        <Setting label={t("settings.autoHideAnimation")} when={config.autoHide}>
          <Choice
            value={config.autoHideAnimation}
            options={[
              { value: "slide", label: t("settings.autoHideSlide") },
              { value: "spring", label: t("settings.autoHideSpring") },
              { value: "fade", label: t("settings.autoHideFade") },
              { value: "none", label: t("settings.autoHideNone") },
            ]}
            onChange={(v) => set("autoHideAnimation", v)}
          />
        </Setting>
        <Setting label={t("settings.autoHideDuration")} when={config.autoHide && config.autoHideAnimation !== "none"}>
          <Range
            label={t("settings.autoHideDuration")}
            value={config.autoHideDuration}
            min={50}
            max={600}
            step={10}
            unit=" ms"
            onChange={(v) => set("autoHideDuration", Math.round(v))}
          />
        </Setting>
      </Section>

      <Section title={t("settings.hoverEffect")} description={t("settings.appliesToAppsStart")}>
        <Setting label={t("settings.effect")}>
          <Choice value={config.hoverEffect} options={hoverEffects} onChange={(v) => set("hoverEffect", v)} />
        </Setting>
        <Setting label={t("settings.tryIt")} description={t("settings.hoverOverIconsNext")} when={config.hoverEffect !== "none"}>
          <HoverPreview />
        </Setting>
        <Setting
          label={t("settings.intensity")}
          description={
            {
              zoom: t("settings.howMuchIconGrows"),
              macos: t("settings.howMuchIconsGrow"),
              lift: t("settings.howMuchIconRises"),
              glow: t("settings.glowStrength"),
              highlight: t("settings.howBrightBackgroundGets"),
              none: "",
            }[config.hoverEffect]
          }
          when={config.hoverEffect !== "none"}
        >
          <Range
            label={t("settings.intensity")}
            value={config.hoverIntensity}
            min={25}
            max={200}
            step={5}
            unit="%"
            onChange={(v) => config.hoverEffect !== "none" && set("hoverIntensity", Math.round(v))}
          />
        </Setting>
        <Setting label={t("settings.animationSpeed")} description={t("settings.lowerIsFaster0")} when={config.hoverEffect !== "none"}>
          <Range
            label={t("settings.speed")}
            value={config.hoverSpeed}
            min={0}
            max={500}
            step={10}
            unit=" ms"
            onChange={(v) => config.hoverEffect !== "none" && set("hoverSpeed", Math.round(v))}
          />
        </Setting>
        <Setting label={t("settings.glowColor")} when={config.hoverEffect === "glow"}>
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
        <Setting label={t("settings.pressDownOnClick")} description={t("settings.iconShrinksLittleWhile")}>
          <Toggle label={t("settings.pressDownOnClick")} checked={config.pressEffect} onChange={(v) => set("pressEffect", v)} />
        </Setting>
      </Section>

      <Section title={t("settings.iconsAndWindows")}>
        <Setting label={t("settings.iconSize")} description={t("settings.appsStartButtonAnd")}>
          <Range
            label={t("settings.size")}
            value={config.iconScale}
            min={70}
            max={130}
            step={5}
            unit="%"
            onChange={(v) => set("iconScale", Math.round(v))}
          />
        </Setting>
        <Setting label={t("settings.openAppIndicator")} description={t("settings.lineUnderIcon")}>
          <Toggle label={t("settings.indicator")} checked={config.runningIndicator} onChange={(v) => set("runningIndicator", v)} />
        </Setting>
        <Setting label={t("settings.stackedIcons")} description={t("settings.copyBehindIconWhen")}>
          <Toggle label={t("settings.stacked")} checked={config.stackedIcons} onChange={(v) => set("stackedIcons", v)} />
        </Setting>
        <Setting label={t("settings.clickOnAppWith")}>
          <Choice
            value={config.multiWindowClick}
            options={[
              { value: "list", label: t("settings.showWindows") },
              { value: "recent", label: t("settings.openLastOne") },
            ]}
            onChange={(v) => set("multiWindowClick", v)}
          />
        </Setting>
        <Setting label={t("settings.previewOnHover")} description={t("settings.windowThumbnailsAboveIcon")}>
          <Toggle label={t("settings.preview")} checked={config.hoverPreview} onChange={(v) => set("hoverPreview", v)} />
        </Setting>
        <Setting label={t("settings.delayBeforePreviewOpens")} when={config.hoverPreview}>
          <Range
            label={t("settings.delay")}
            value={config.previewDelay}
            min={0}
            max={1500}
            step={50}
            unit=" ms"
            onChange={(v) => config.hoverPreview && set("previewDelay", Math.round(v))}
          />
        </Setting>
      </Section>

      <Section title={t("settings.system")}>
        <Setting label={t("settings.language")} description={t("settings.interfaceLanguageAppliesAfter")}>
          <Row style={{ gap: 8, align: "center" }}>
            {languagePending() ? <Button label={t("settings.restartNow")} onClick={restartApp} /> : null}
            <Choice
              value={config.language}
              options={[
                { value: "pt-BR", label: "Português (Brasil)" },
                { value: "en-US", label: "English" },
                { value: "system", label: t("settings.followWindows") },
              ]}
              onChange={(v) => set("language", v)}
            />
          </Row>
        </Setting>
        <Setting label={t("settings.startWithWindows")}>
          <Toggle
            label={t("settings.startWithWindows")}
            checked={config.autostart}
            onChange={(v) => {
              set("autostart", v);
              void setAutostart(v);
            }}
          />
        </Setting>
        <UpdateSetting />
        <Setting label={t("settings.downloadUpdatesAutomatically")} description={t("settings.newVersionIsInstalled")}>
          <Toggle label={t("settings.downloadAutomatically")} checked={config.autoUpdate} onChange={(v) => set("autoUpdate", v)} />
        </Setting>
        <Setting label={t("settings.windowsTaskbarSettings")} description={t("settings.trayIconsAlignmentAnd")}>
          <Button label={t("settings.open")} onClick={() => launch("ms-settings:taskbar")} />
        </Setting>
        <Setting label={t("settings.restoreDefaults")} description={t("settings.resetsEveryOptionOn")}>
          <Button
            label={t("settings.restore")}
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
