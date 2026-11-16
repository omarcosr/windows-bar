// Builds a release of WindowsBar the Tarve way:
//   tarve build --packs --trim   the executable (Bun trimmed), able to run app packs
//   tarve pack                   the app's code and files without the runtime (incremental update)
//   tarve package --format setup,zip   the installer and the portable zip
//   tarve release                the signed latest.json listing the executable and the pack
//
//   bun run release                  version from package.json, files in dist/
//   bun run release 0.2.0            sets package.json to 0.2.0 first
//   bun run release 0.2.0 --publish  also creates GitHub release v0.2.0 with gh and uploads it
//   --notes "..."                    release notes (manifest and GitHub)
//   --out dir                        output folder instead of dist (e.g. while dist\WindowsBar.exe runs)
//   --base-url url                   where the files will be served (default: the GitHub release)
//
// Installed copies built with --packs download only the pack (a few hundred KB) when the new
// release runs on the same executable (same Tarve runtime and native features); otherwise the
// whole executable. Signing uses ./windows-bar-update.key (tarve keygen; secret, out of git) or
// TARVE_UPDATE_PRIVATE_KEY; the app verifies with the public key in src/services/updater.ts.
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO = "omarcosr/windows-bar";
const PUBLIC_KEY = "vE8Xw8cUxDOZnioS0ka0KelRK+2HT7wy2Aou4RDce6Q=";
const KEY_FILE = "windows-bar-update.key";

const args = process.argv.slice(2);
const VALUED = ["--notes", "--out", "--base-url"];
const flag = (name: string) => args.includes(name);
const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const positional = args.filter((a, i) => !a.startsWith("--") && !VALUED.includes(args[i - 1] ?? ""));

const keyArgs = process.env.TARVE_UPDATE_PRIVATE_KEY ? [] : existsSync(KEY_FILE) ? ["--key", KEY_FILE] : null;
if (!keyArgs) throw new Error(`no signing key: set TARVE_UPDATE_PRIVATE_KEY or put ${KEY_FILE} here`);

const pkgPath = "package.json";
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const version: string = positional[0] ?? pkg.version;
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) throw new Error(`invalid version "${version}"`);
if (version !== pkg.version) {
  pkg.version = version;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  console.log(`package.json -> ${version}`);
}
const notes = option("--notes") ?? `WindowsBar ${version}`;
const tag = `v${version}`;
const out = option("--out") ?? "dist";
const baseUrl = option("--base-url") ?? `https://github.com/${REPO}/releases/download/${tag}/`;
const exe = join(out, "WindowsBar.exe");
const pack = join(out, "WindowsBar.tarve");
const releaseDir = join(out, "release");
const updatesDir = join(out, "updates");

function run(cmd: string[]) {
  console.log(`> ${cmd.join(" ")}`);
  const r = Bun.spawnSync(cmd, { stdout: "inherit", stderr: "inherit" });
  if (r.exitCode !== 0) throw new Error(`failed (${r.exitCode}): ${cmd.join(" ")}`);
}

for (const dir of [releaseDir, updatesDir]) rmSync(dir, { recursive: true, force: true });

run(["bunx", "tarve", "build", "src/main.tsx", "--version", version, "--packs", "--trim", ...keyArgs, "--outfile", exe]);
run(["bunx", "tarve", "pack", "src/main.tsx", "--version", version, ...keyArgs, "--outfile", pack]);
run(["bunx", "tarve", "package", exe, "--entry", "src/main.tsx", "--version", version, "--format", "setup,zip", "--out", releaseDir]);
run([
  "bunx", "tarve", "release", ...keyArgs,
  "--version", version,
  "--artifact", `win32-x64=${exe}`,
  "--pack", pack,
  "--out", updatesDir,
  "--base-url", baseUrl,
  "--public-key", PUBLIC_KEY,
  "--notes", notes,
]);

const installers = readdirSync(releaseDir).map((f) => join(releaseDir, f));
const updates = readdirSync(updatesDir)
  .filter((f) => f !== "latest.json")
  .map((f) => join(updatesDir, f));
console.log("\nRelease files:");
for (const f of [...installers, ...updates, join(updatesDir, "latest.json")]) console.log("  " + f);

if (flag("--publish")) {
  // Everything else first, latest.json last: a client never sees a manifest whose files are not there yet.
  run(["gh", "release", "create", tag, ...updates, ...installers, "--repo", REPO, "--title", `WindowsBar ${version}`, "--notes", notes]);
  run(["gh", "release", "upload", tag, join(updatesDir, "latest.json"), "--repo", REPO]);
  console.log(`\nPublished https://github.com/${REPO}/releases/tag/${tag}`);
} else {
  console.log(`\nNot published. To publish: bun run release ${version} --publish`);
}
