/**
 * Screenshot harness for dock widgets: a standalone window (no single instance, no AppBar, no tray
 * host) that draws the gallery preview of each chosen widget type on the dock background at the
 * real tile height and saves one PNG per bar height (app.capture: physical pixels, the screen's scale).
 *
 *   bun scripts/widget-shots.tsx --group hardware            types whose name starts with "hardware-" ("core" = the core widgets)
 *   bun scripts/widget-shots.tsx --types system,tray-clock   exact types
 *   --heights 40,48,64   bar heights (default 40,48,64)
 *   --live               also the live variant ("shot:<type>", ticking, real data)
 *   --hover              one extra PNG per type with the pointer resting on its tile
 *   --out <dir>          default %EMPRYO_TMP%\widget-shots
 *   --name <prefix>      file name prefix (default the group or "types")
 *   --tips               with --hover: also the dock's hover tip (its own window, above the bottom
 *                        of the screen), saved by a screen grab of the bottom 260 px as <name>-<h>-tip-<type>.png
 *
 * The config lives in a sandbox APPDATA under <out>, so the user's dock config is never read or written.
 */
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const arg = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const out = arg("--out") ?? join(process.env.EMPRYO_TMP ?? tmpdir(), "widget-shots");
mkdirSync(out, { recursive: true });
process.env.APPDATA = join(out, "appdata");
mkdirSync(process.env.APPDATA, { recursive: true });

const { createApp, Window, View, Row, Column, Text } = await import("@tarve/core");
const { config } = await import("../src/config");
await import("../src/widgets/builtin");
const { allWidgets } = await import("../src/widgets/registry");
const { mountWidget, setWidgetApp } = await import("../src/widgets/host");
const { ui } = await import("../src/theme");

const CORE = ["system", "clock-weather", "now-playing", "revenue", "tray-clock", "tray-language", "tray-status"];
const group = arg("--group");
const wanted = arg("--types")?.split(",").map((s) => s.trim()).filter(Boolean);
const defs = allWidgets().filter((d) =>
  wanted ? wanted.includes(d.type) : group === "core" ? CORE.includes(d.type) : group ? d.type.startsWith(group + "-") || d.type === group : true,
);
if (!defs.length) {
  console.error("no widget types match", { group, wanted });
  process.exit(1);
}
const heights = (arg("--heights") ?? "40,48,64").split(",").map(Number);
const live = argv.includes("--live");
const hover = argv.includes("--hover");
const tips = argv.includes("--tips");
const prefix = arg("--name") ?? group ?? "types";

const variants = defs.flatMap((d) => [
  { def: d, id: `preview:${d.type}`, preview: true },
  ...(live ? [{ def: d, id: `shot:${d.type}`, preview: false }] : []),
]);
const instances = new Map(
  variants.map((v) => [v.id, { id: v.id, type: v.def.type, config: structuredClone(v.def.defaultConfig) as Record<string, unknown> }]),
);

function Shot(props: { v: (typeof variants)[number] }) {
  const { v } = props;
  const widget = mountWidget(instances.get(v.id)!);
  if (!widget) return null;
  const W = v.def.View;
  return (
    <Row style={{ align: "center", gap: 12 }}>
      <Text size={11} color="#8e8e93" style={{ width: 200, whiteSpace: "nowrap" }}>
        {`${v.def.type}${v.preview ? "" : " (live)"}`}
      </Text>
      <Row id={`shot-${v.id}`} style={{ padding: ui.dock.padding, radius: 18, background: ui.dock.background, align: "center", height: ui.dock.height }}>
        <W state={widget.state} ctx={widget.ctx} preview={v.preview} />
      </Row>
    </Row>
  );
}

const rowH = Math.max(...heights) + 8;
const winH = Math.min(1400, 40 + variants.length * rowH);
const app = createApp(
  () => (
    <Window title="Widget shots" width={900} height={winH} style={{ background: "#202024" }}>
      <Column style={{ padding: 14, gap: 8 }}>
        <Text size={11} color="#c9c9ce">{`barra ${ui.dock.height}px · tile ${ui.tile.height}px`}</Text>
        {variants.map((v) => (
          <Shot key={v.id} v={v} />
        ))}
      </Column>
    </Window>
  ),
  { debug: true, closeBehavior: "exit", onError: ({ error, source }) => console.error(`[${source}]`, error) },
);
setWidgetApp(app);
await app.ready;
if (tips) await (await import("../src/menu/hover-tip")).initHoverTip(app);

/** The bottom 260 physical px of the primary screen, where the tip shows (PowerShell CopyFromScreen). */
function grabBottom(file: string) {
  const ps = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; Add-Type 'using System.Runtime.InteropServices; public class D { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'; [D]::SetProcessDPIAware() | Out-Null; $s=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $h=260; $b=New-Object System.Drawing.Bitmap $s.Width,$h; $g=[System.Drawing.Graphics]::FromImage($b); $g.CopyFromScreen($s.X,$s.Bottom-$h,0,0,$b.Size); $b.Save('${file}'); $g.Dispose(); $b.Dispose()`;
  Bun.spawnSync(["powershell", "-NoProfile", "-Command", ps]);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Box = { id: string; x: number; y: number; width: number; height: number };
function findNode(node: unknown, id: string): Box | undefined {
  if (!node || typeof node !== "object") return undefined;
  const n = node as Record<string, unknown>;
  if (n.id === id && typeof n.x === "number") return n as unknown as Box;
  for (const value of Object.values(n)) {
    const hit = Array.isArray(value) ? value.map((c) => findNode(c, id)).find(Boolean) : typeof value === "object" ? findNode(value, id) : undefined;
    if (hit) return hit;
  }
  return undefined;
}

const saved: string[] = [];
const guard = setTimeout(() => {
  console.error("widget-shots: timed out");
  process.exit(2);
}, 120_000);
try {
await sleep(1500);
for (const h of heights) {
  config.barHeight = h;
  await sleep(live ? 2500 : 700);
  const file = join(out, `${prefix}-${h}.png`);
  await app.capture(file);
  saved.push(file);
  if (hover) {
    for (const v of variants) {
      const box = findNode(await app.inspect(), `shot-${v.id}`);
      if (!box) continue;
      // The first child tile: a few px in from the row's left padding, at its vertical centre.
      app.debug({ type: "input", action: "move", x: box.x + ui.dock.padding + 14, y: box.y + box.height / 2 });
      await sleep(450);
      const hf = join(out, `${prefix}-${h}-hover-${v.def.type}${v.preview ? "" : "-live"}.png`);
      await app.capture(hf);
      saved.push(hf);
      if (tips && v.preview === false) {
        await sleep(900);
        const tf = join(out, `${prefix}-${h}-tip-${v.def.type}.png`);
        grabBottom(tf);
        saved.push(tf);
      }
    }
    app.debug({ type: "input", action: "move", x: 2, y: 2 });
  }
}
} catch (error) {
  console.error(error);
  process.exit(1);
}
clearTimeout(guard);
console.log(saved.join("\n"));
app.close();
process.exit(0);
