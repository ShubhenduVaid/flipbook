/**
 * Build a Claude Desktop extension (.mcpb) into dist/.
 *
 *   npm run pack:mcpb
 *
 * The bundle carries its own node_modules, including ffmpeg-static's binary — which is
 * downloaded for the platform this runs on. So build it on the platform it is for: the
 * release workflow builds on a macOS runner, because recording is macOS-only.
 *
 * mcpb is run through npx at a pinned version rather than added as a devDependency, for
 * the same reason Biome is: Claude Code installs plugin dependencies without
 * --omit=dev, so a devDependency would ship into every user's plugin cache.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MCPB = "@anthropic-ai/mcpb@2.1.2";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const dist = path.join(root, "dist");
const stage = path.join(dist, "mcpb-stage");
const out = path.join(dist, `flipbook-${pkg.version}-${process.platform}-${process.arch}.mcpb`);

// On Windows npm and npx are .cmd shims, which execFile only runs through a shell.
const run = (cmd, args, cwd) =>
  execFileSync(process.platform === "win32" ? `${cmd}.cmd` : cmd, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
  });

fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

// The bundled ffmpeg only runs where it was downloaded, so the bundle claims exactly that
// platform — the source manifest lists every platform the server itself supports.
const manifest = JSON.parse(fs.readFileSync(path.join(root, "mcpb", "manifest.json"), "utf8"));
manifest.compatibility = { ...manifest.compatibility, platforms: [process.platform] };
fs.writeFileSync(path.join(stage, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
for (const f of ["package.json", "package-lock.json", "README.md", "LICENSE"]) {
  fs.copyFileSync(path.join(root, f), path.join(stage, f));
}
for (const d of ["src", "native"]) {
  fs.cpSync(path.join(root, d), path.join(stage, d), { recursive: true });
}

// With install scripts: ffmpeg-static fetches its binary in postinstall, and a bundle
// without it would fall back to asking the user for a system ffmpeg.
run("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], stage);

run("npx", ["--yes", MCPB, "validate", path.join(stage, "manifest.json")], root);
fs.rmSync(out, { force: true });
run("npx", ["--yes", MCPB, "pack", stage, out], root);

console.log(`\n${path.relative(root, out)}  ${(fs.statSync(out).size / 1e6).toFixed(1)} MB`);
