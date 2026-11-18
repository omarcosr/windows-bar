/**
 * Screenshot harness for the finance chart panel (src/menu/chart-panel.tsx): draws the panel
 * component in a standalone window (no dock, no AppBar), loads each source, then simulates the
 * pointer with app.debug (hover, a drag selection, a click on "Comparar com") and saves PNGs with
 * app.capture (physical pixels at the screen's scale).
 *
 *   bun scripts/chart-panel-shots.tsx                 demo revenue + live USD/BRL, AAPL, BTCUSDT
 *   --only demo,fx,stock,crypto                       a subset
 *   --out <dir>                                       default %EMPRYO_TMP%\chart-panel-shots
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
const out = arg("--out") ?? join(process.env.EMPRYO_TMP ?? tmpdir(), "chart-panel-shots");
mkdirSync(out, { recursive: true });
process.env.APPDATA = join(out, "appdata");
mkdirSync(process.env.APPDATA, { recursive: true });

const { createApp, Window, View } = await import("@tarve/core");
const { ChartPanel, setChartSource, setChartPanelHost } = await import("../src/menu/chart-panel");
const { cryptoSource, currencySource, singleStockSource } = await import("../src/widgets/builtin/finance/markets");
const { revenueSource, demoDaily } = await import("../src/widgets/builtin/finance/shared");
type Source = import("../src/menu/chart-panel").ChartSource;

const only = arg("--only")?.split(",");
const ctx = <C extends object>(id: string, config: C) => ({ instanceId: id, config, save: () => console.log(`[save ${id}]`, JSON.stringify(config)) });

const revenueConfig = { period: "30d", compare: true, compareTo: "previous", format: "compact" };
const cases: { name: string; source: () => Source; compare?: string; range?: string }[] = [
  {
    name: "demo",
    compare: "year",
    source: () =>
      revenueSource({
        key: "demo",
        anchor: "none",
        title: "Stripe",
        brand: { color: "#635bff", letter: "S" },
        source: "API do Stripe",
        url: "https://dashboard.stripe.com",
        config: revenueConfig,
        save: () => console.log("[save demo]", JSON.stringify(revenueConfig)),
        loadDaily: async (days) => ({ daily: demoDaily(90, 1, days), currency: "usd", demo: true }),
      }),
  },
  {
    name: "fx",
    compare: "year",
    range: "3m",
    source: () =>
      currencySource(ctx("fx", { from: "USD", to: "BRL", amount: "1", show: "rate", invert: false, change: "close", chart: "line", window: "1m", decimals: "auto", click: "panel", refresh: "60" })),
  },
  { name: "stock", compare: "sym:MSFT", source: () => singleStockSource(ctx("stock", { ticker: "AAPL", range: "5d", change: "day" })) },
  {
    name: "crypto",
    range: "30d",
    compare: "sym:ETHUSDT",
    source: () => cryptoSource(ctx("crypto", { symbol: "BTC", quote: "USDT", window: "24h", change: "24h", chart: "line", click: "panel", refresh: "5" })),
  },
].filter((c) => !only || only.includes(c.name));

const app = createApp(
  () => (
    <Window title="Chart panel shots" width={420} height={560} style={{ background: "#0e0e10" }}>
      <View style={{ padding: 20 }}>
        <ChartPanel />
      </View>
    </Window>
  ),
  { debug: true, closeBehavior: "exit", onError: ({ error, source }) => console.error(`[${source}]`, error) },
);
setChartPanelHost(app);
await app.ready;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const box = (id: string) => app.layout([id])?.[id];
const move = (x: number, y: number) => app.debug({ type: "input", action: "move", x, y });
const press = async (x: number, y: number) => {
  move(x, y);
  await sleep(60);
  app.debug({ type: "input", action: "down", x, y });
  await sleep(60);
  app.debug({ type: "input", action: "up", x, y });
  await sleep(250);
};
const clickNode = async (id: string) => {
  const b = box(id);
  if (!b) return console.error(`no node ${id}`);
  await press(b.x + b.borderWidth / 2, b.y + b.borderHeight / 2);
};
/** Waits until the plot is laid out (data loaded) or `ms` pass. */
async function plotReady(ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (box("cp-plot")) return true;
    await sleep(150);
  }
  return false;
}

const saved: string[] = [];
const shot = async (file: string) => {
  await sleep(350);
  const path = join(out, file);
  await app.capture(path);
  saved.push(path);
};

const guard = setTimeout(() => {
  console.error("chart-panel-shots: timed out");
  process.exit(2);
}, 180_000);
try {
  const { screens } = await app.screens();
  console.log("scale", screens.map((s) => s.scale).join(","));
  for (const c of cases) {
    move(2, 2);
    setChartSource(c.source());
    if (!(await plotReady())) console.error(`${c.name}: no data`);
    if (c.range) {
      await clickNode(`cp-range-${c.range}`);
      await plotReady();
      await sleep(1500);
    }
    await shot(`${c.name}-1-base.png`);
    const p = box("cp-plot");
    if (!p) continue;
    const y = p.y + p.borderHeight / 2;
    move(p.x + p.borderWidth * 0.62, y);
    await shot(`${c.name}-2-hover.png`);
    // A drag from 20% to 75% of the plot.
    const x0 = p.x + p.borderWidth * 0.2;
    const x1 = p.x + p.borderWidth * 0.75;
    move(x0, y);
    await sleep(80);
    app.debug({ type: "input", action: "down", x: x0, y });
    for (let i = 1; i <= 8; i++) {
      await sleep(30);
      move(x0 + ((x1 - x0) * i) / 8, y);
    }
    await sleep(80);
    app.debug({ type: "input", action: "up", x: x1, y });
    move(p.x + p.borderWidth + 30, y);
    await shot(`${c.name}-3-drag.png`);
    if (c.compare) {
      if (c.compare.startsWith("sym:") && !box(`cp-cmp-${c.compare}`)) {
        // Not among the chips: type it in the field.
        await clickNode("cp-symbol");
        app.debug({ type: "input", action: "text", text: c.compare.slice(4) });
        await sleep(100);
        app.debug({ type: "input", action: "key", text: "Enter" });
      } else await clickNode(`cp-cmp-${c.compare}`);
      await sleep(2500);
      move(p.x + p.borderWidth * 0.4, y);
      await shot(`${c.name}-4-compare.png`);
      move(2, 2);
    }
    if (c.name === "demo") {
      await clickNode("cp-range-90d");
      await plotReady();
      await shot(`${c.name}-5-range.png`);
      await clickNode("cp-apply");
      await shot(`${c.name}-6-applied.png`);
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
