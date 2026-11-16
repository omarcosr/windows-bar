// Builds a release of WindowsBar: the executable, the Windows installer and the signed update
// manifest, the Tarve way (tarve build, tarve package --format setup, tarve release).
//
//   bun run release                 version from package.json, files in dist/
//   bun run release 0.2.0           sets package.json to 0.2.0 first
//   bun run release 0.2.0 --publish  also creates GitHub release v0.2.0 with gh and uploads it
//   --notes "..."                    release notes (manifest and GitHub)
//
// Signing uses ./windows-bar-update.key (tarve keygen; keep it secret, out of git) or
// TARVE_UPDATE_PRIVATE_KEY. The app checks updates with the matching public key in
// src/services/updater.ts.
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO = "omarcosr/windows-bar";
const PUBLIC_KEY = "vE8Xw8cUxDOZnioS0ka0KelRK+2HT7wy2Aou4RDce6Q=";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const positional = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--notes"));

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

function run(cmd: string[]) {
  console.log(`> ${cmd.join(" ")}`);
  const r = Bun.spawnSync(cmd, { stdout: "inherit", stderr: "inherit" });
  if (r.exitCode !== 0) throw new Error(`failed (${r.exitCode}): ${cmd.join(" ")}`);
}

for (const dir of ["dist/release", "dist/updates"]) rmSync(dir, { recursive: true, force: true });

run(["bunx", "tarve", "build", "src/main.tsx", "--version", version, "--outfile", "dist/WindowsBar.exe"]);
run([
  "bunx",
  "tarve",
  "package",
  "dist/WindowsBar.exe",
  "--entry",
  "src/main.tsx",
  "--version",
  version,
  "--format",
  "setup,zip",
  "--out",
  "dist/release",
]);
run([
  "bunx",
  "tarve",
  "release",
  "--version",
  version,
  "--artifact",
  "win32-x64=dist/WindowsBar.exe",
  "--out",
  "dist/updates",
  "--base-url",
  `https://github.com/${REPO}/releases/download/${tag}/`,
  "--public-key",
  PUBLIC_KEY,
  "--notes",
  notes,
]);

const installers = readdirSync("dist/release").map((f) => join("dist/release", f));
const executables = readdirSync("dist/updates")
  .filter((f) => f !== "latest.json")
  .map((f) => join("dist/updates", f));
console.log("\nRelease files:");
for (const f of [...installers, ...executables, "dist/updates/latest.json"]) console.log("  " + f);

if (flag("--publish")) {
  // The executable and installers first, latest.json last: a client never sees a manifest whose
  // files are not there yet.
  run([
    "gh",
    "release",
    "create",
    tag,
    ...executables,
    ...installers,
    "--repo",
    REPO,
    "--title",
    `WindowsBar ${version}`,
    "--notes",
    notes,
  ]);
  run(["gh", "release", "upload", tag, "dist/updates/latest.json", "--repo", REPO]);
  console.log(`\nPublished https://github.com/${REPO}/releases/tag/${tag}`);
} else if (existsSync("dist/updates/latest.json")) {
  console.log(`\nNot published. To publish: bun run release ${version} --publish`);
}
