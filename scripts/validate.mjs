#!/usr/bin/env node
/**
 * Executable form of docs/VALIDATION-RUBRIC.md.
 *
 *   node scripts/validate.mjs            mechanical criteria only
 *   node scripts/validate.mjs --full     also run the criteria needing macOS + Chrome
 *
 * Reports every criterion individually and exits non-zero if any FAIL. There is no
 * aggregate score on purpose: a percentage lets a security failure be averaged away by
 * passing style checks, which is the kind of reassuring-but-empty summary this project
 * exists to argue against.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FULL = process.argv.includes("--full");

const results = [];
const pass = (id, what, evidence) => results.push({ id, status: "PASS", what, evidence });
const fail = (id, what, evidence) => results.push({ id, status: "FAIL", what, evidence });
const manual = (id, what, cmd) => results.push({ id, status: "MANUAL", what, evidence: cmd });

const read = (rel) => fs.readFileSync(path.join(repo, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(repo, rel));
const json = (rel) => JSON.parse(read(rel));

/** Every tracked file, so checks never wander into node_modules or build output. */
async function trackedFiles() {
  const { stdout } = await execFileAsync("git", ["ls-files"], { cwd: repo });
  return stdout.split("\n").filter(Boolean);
}

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(path.join(repo, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(rel));
    else out.push(rel);
  }
  return out;
}

async function run(cmd, args, opts = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd: repo,
      timeout: opts.timeout ?? 300_000,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, ...(opts.env ?? {}) },
    });
    return { ok: true, stdout, stderr };
  } catch (err) {
    return { ok: false, stdout: err.stdout ?? "", stderr: err.stderr ?? err.message };
  }
}

// ─── P — Promises ────────────────────────────────────────────────────────────
// Most of P needs a real recording. What can be checked without one is checked
// against a synthetic analysis; the rest is reported MANUAL with its command.

async function checkPromises() {
  const fixtureVideo = ".fixture-out/front/run.mov";
  if (!exists(fixtureVideo)) {
    for (const [id, what] of [
      ["P1", "at most 7 images per analysis"],
      ["P2", "payload under the 12,500-token ceiling"],
      ["P3", "all four response channels present"],
      ["P4", "images are native image blocks"],
      ["P5", "tools return evidence, never a verdict"],
      ["P6", "timeline survives a truncating rubric"],
    ]) {
      manual(id, what, `npm run test:e2e first (needs ${fixtureVideo}), then re-run`);
    }
  } else {
    const { analyzeVideo } = await import(path.join(repo, "src/analyze/analyze.mjs"));
    const outDir = path.join(repo, ".validate-out");
    fs.rmSync(outDir, { recursive: true, force: true });

    // The rubric has to be long enough to actually bite, or P6 passes for the wrong
    // reason. With six images the text allowance is (12500 - 6*1600) * 4 ≈ 11,600
    // characters; an 8,771-character rubric slipped under it and the check passed
    // while the defect was still present. Size this one off the real allowance.
    const { safeTokenCeiling } = await import(path.join(repo, "src/analyze/budget.mjs"));
    const allowance = (safeTokenCeiling() - 6 * 1600) * 4;
    const lines = [];
    let i = 0;
    while (lines.join("\n").length < allowance * 1.3) {
      i++;
      lines.push(
        `Criterion ${i}: element ${i} must render within its container, remain legible at ` +
          `the default zoom level, and must not shift position after the surrounding ` +
          `content has finished loading.`
      );
    }
    const longRubric = lines.join("\n");

    let res;
    try {
      res = await analyzeVideo({
        video: path.join(repo, fixtureVideo),
        events: [],
        outDir,
        label: "rubric self-check",
        rubric: longRubric,
        returnMode: "inline",
      });
    } catch (err) {
      for (const id of ["P1", "P2", "P3", "P4", "P5", "P6"]) {
        fail(id, "analysis of the fixture recording", err.message);
      }
      return;
    }

    const images = res.content.filter((c) => c.type === "image");
    const texts = res.content.filter((c) => c.type === "text");
    const links = res.content.filter((c) => c.type === "resource_link");
    const allText = texts.map((t) => t.text).join("\n");

    images.length <= 7
      ? pass("P1", "at most 7 images per analysis", `${images.length} images`)
      : fail("P1", "at most 7 images per analysis", `${images.length} images`);

    const tokens = images.length * 1600 + Math.ceil(allText.length / 4);
    tokens <= 12_500
      ? pass("P2", "payload under the 12,500-token ceiling", `${tokens} tokens`)
      : fail("P2", "payload under the 12,500-token ceiling", `${tokens} tokens`);

    const hasSheet = /CONTACT SHEET/.test(allText);
    const hasDetail = /DETAIL \d+\//.test(allText);
    const hasTimeline = /TIMELINE/.test(allText);
    const hasLink = links.length === 1;
    hasSheet && hasDetail && hasTimeline && hasLink
      ? pass("P3", "all four response channels present", "sheet, detail, timeline, resource_link")
      : fail(
          "P3",
          "all four response channels present",
          `sheet=${hasSheet} detail=${hasDetail} timeline=${hasTimeline} link=${hasLink}`
        );

    images.every((i) => i.mimeType?.startsWith("image/") && typeof i.data === "string")
      ? pass("P4", "images are native image blocks", `${images.length} typed image blocks`)
      : fail("P4", "images are native image blocks", "a block was not a real image");

    // The tools must not adjudicate. The rubric text is echoed back verbatim, so only
    // look at what the tool itself wrote around it.
    const toolProse = allText.replace(longRubric, "");
    const verdicts = toolProse.match(/\b(PASS|FAIL|PASSED|FAILED)\b|✅|❌/g);
    !verdicts
      ? pass("P5", "tools return evidence, never a verdict", "no verdict language emitted")
      : fail("P5", "tools return evidence, never a verdict", `found ${[...new Set(verdicts)].join(", ")}`);

    hasTimeline
      ? pass(
          "P6",
          "timeline survives a truncating rubric",
          `${longRubric.length}-char rubric vs ${allowance}-char allowance, timeline still present`
        )
      : fail(
          "P6",
          "timeline survives a truncating rubric",
          `${longRubric.length}-char rubric exceeded the ${allowance}-char allowance and the ` +
            `timeline block was dropped entirely`
        );

    fs.rmSync(outDir, { recursive: true, force: true });
  }

  manual("P7", "spinner and transient toast captured", "npm run test:e2e");
  manual("P8", "capture works while the browser is occluded", "npm run test:e2e:occluded");
  manual("P9", "user-supplied .mov / .gif / stills analysable", "npm run test:mcp");
  manual("P10", "recording does not interfere with Claude-in-Chrome", "node test/live-run.mjs");
}

// ─── N — Naming ──────────────────────────────────────────────────────────────

async function checkNaming(files) {
  const pkg = json("package.json");
  const plugin = json(".claude-plugin/plugin.json");

  // N1 — a version literal anywhere but the manifests is a future inconsistency.
  const manifestFiles = new Set([
    "package.json", "package-lock.json",
    ".claude-plugin/plugin.json", ".claude-plugin/marketplace.json",
  ]);
  const semver = /\b\d+\.\d+\.\d+\b/;
  const strays = [];
  for (const f of files) {
    if (manifestFiles.has(f) || !/\.(mjs|js)$/.test(f)) continue;
    for (const [i, line] of read(f).split("\n").entries()) {
      // Ignore comments and dependency ranges; only literal version strings matter.
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
      if (semver.test(line) && /version/i.test(line)) strays.push(`${f}:${i + 1}`);
    }
  }
  strays.length === 0
    ? pass("N1", "one source of truth for name and version", "no hardcoded versions outside manifests")
    : fail("N1", "one source of truth for name and version", strays.join(", "));

  // N2 — stale identities from earlier renames.
  const stale = ["video-qa", "video-mcp", "VIDEO_QA", "browser-replay"];
  const hits = [];
  for (const f of files) {
    if (f === "docs/VALIDATION-RUBRIC.md" || f.startsWith("docs/") && f.endsWith(".jpg")) continue;
    let content;
    try {
      content = read(f);
    } catch {
      continue; // binary
    }
    for (const s of stale) if (content.includes(s)) hits.push(`${f} (${s})`);
  }
  hits.length === 0
    ? pass("N2", "no stale identifiers", `checked ${files.length} tracked files`)
    : fail("N2", "no stale identifiers", hits.join(", "));

  // N3 — delegated to the manifest linter, which already compares the three.
  const lint = await run("node", ["scripts/lint-manifests.mjs"]);
  lint.ok
    ? pass("N3", "the three manifests agree", lint.stdout.trim().split("\n").pop())
    : fail("N3", "the three manifests agree", lint.stdout.trim() || lint.stderr.trim());

  // N4 — skill directory name must equal its frontmatter name.
  const skillDirs = fs.existsSync(path.join(repo, "skills"))
    ? fs.readdirSync(path.join(repo, "skills"), { withFileTypes: true }).filter((d) => d.isDirectory())
    : [];
  const mismatched = [];
  for (const d of skillDirs) {
    const md = read(path.join("skills", d.name, "SKILL.md"));
    const name = /^name:\s*(.+)$/m.exec(md)?.[1]?.trim();
    if (name !== d.name) mismatched.push(`${d.name} declares "${name}"`);
  }
  mismatched.length === 0
    ? pass("N4", "skill directories match their frontmatter", `${skillDirs.length} skill(s)`)
    : fail("N4", "skill directories match their frontmatter", mismatched.join(", "));

  // N5 — a skill should not restate what the plugin name already says.
  const redundant = skillDirs
    .map((d) => d.name)
    .filter((n) => n.includes(plugin.name) || (plugin.name === "flipbook" && /screen-recording/.test(n)));
  redundant.length === 0
    ? pass("N5", "skill names consistent with the package", skillDirs.map((d) => d.name).join(", ") || "none")
    : fail("N5", "skill names consistent with the package", `redundant: ${redundant.join(", ")}`);

  // N6 — allowed-tools must use the real namespaced names.
  const server = Object.keys(json(".mcp.json").mcpServers)[0];
  const prefix = `mcp__plugin_${plugin.name}_${server}__`;
  const cmd = read("commands/record.md");
  const declared = /^allowed-tools:\s*(.+)$/m.exec(cmd)?.[1] ?? "";
  const toolNames = declared.split(",").map((s) => s.trim()).filter(Boolean);
  const wrong = toolNames.filter((t) => !t.startsWith(prefix));
  toolNames.length > 0 && wrong.length === 0
    ? pass("N6", "allowed-tools use real namespaced names", `${toolNames.length} tools with ${prefix}`)
    : fail("N6", "allowed-tools use real namespaced names", wrong.length ? wrong.join(", ") : "none declared");

  return { pkg, plugin, server };
}

// ─── S — Security ────────────────────────────────────────────────────────────

async function checkSecurity(files) {
  const code = files.filter((f) => /\.mjs$/.test(f));

  // S1 — shell interpolation.
  const shellHits = [];
  for (const f of code) {
    for (const [i, line] of read(f).split("\n").entries()) {
      if (/\bexecSync\(|\bshell:\s*true|\bexec\(\s*[`'"]/.test(line)) shellHits.push(`${f}:${i + 1}`);
    }
  }
  shellHits.length === 0
    ? pass("S1", "no shell interpolation", `${code.length} modules use execFile/spawn with arg arrays`)
    : fail("S1", "no shell interpolation", shellHits.join(", "));

  // S2 — the real test: does a traversing id escape the data directory?
  const paths = await import(path.join(repo, "src/env/paths.mjs"));
  const session = await import(path.join(repo, "src/capture/session.mjs"));
  const evil = "../../../../tmp/flipbook-traversal-probe";
  let escaped = false;
  let detail = "";
  try {
    const p = session.eventsPath(evil);
    escaped = !path.resolve(p).startsWith(path.resolve(paths.DATA_HOME));
    detail = escaped ? `escaped to ${p}` : "confined";
  } catch (err) {
    detail = `rejected: ${err.message}`;
  }
  !escaped
    ? pass("S2", "session ids cannot escape the data directory", detail)
    : fail("S2", "session ids cannot escape the data directory", detail);

  // S3 — network egress.
  const net = [];
  for (const f of code.filter((f) => f.startsWith("src/"))) {
    if (/\bfetch\(|from "node:(http|https|net|dgram)"|require\("node:(http|https|net)"\)/.test(read(f))) {
      net.push(f);
    }
  }
  net.length === 0
    ? pass("S3", "no network egress from src/", "no fetch or socket imports")
    : fail("S3", "no network egress from src/", net.join(", "));

  // S4 — every session path is built from DATA_HOME.
  const sessionSrc = read("src/capture/session.mjs");
  /SESSIONS_DIR|sessionDir/.test(sessionSrc) && !/homedir\(\)/.test(sessionSrc)
    ? pass("S4", "recordings confined to FLIPBOOK_HOME", "paths derive from DATA_HOME")
    : fail("S4", "recordings confined to FLIPBOOK_HOME", "a session path bypasses DATA_HOME");

  // S5 — the hook must never break the call it observes.
  const hook = read("hooks/record-action.mjs");
  const exitsNonZero = /process\.exit\(\s*[1-9]/.test(hook);
  !exitsNonZero && /catch\s*{/.test(hook)
    ? pass("S5", "hook cannot break the observed tool call", "always exits 0, all paths guarded")
    : fail("S5", "hook cannot break the observed tool call", exitsNonZero ? "can exit non-zero" : "unguarded");

  // S6 — nothing in the published tree is a real screen capture.
  const media = files.filter((f) => /\.(mov|mp4|webm|m4v)$/i.test(f));
  media.length === 0
    ? pass("S6", "no real screen captures published", "no tracked video files")
    : fail("S6", "no real screen captures published", media.join(", "));
}

// ─── Q — Quality ─────────────────────────────────────────────────────────────

async function checkQuality(files) {
  if (exists("biome.json")) {
    const lint = await run("npx", ["--yes", "@biomejs/biome", "check", "."], { timeout: 300_000 });
    lint.ok
      ? pass("Q1", "lint and format clean", "biome check passed")
      : fail("Q1", "lint and format clean", (lint.stdout || lint.stderr).split("\n").slice(-6).join(" ").slice(0, 300));
  } else {
    fail("Q1", "lint and format clean", "no biome.json — linting is not configured");
  }

  // Q2 — exported symbols nothing else imports.
  //
  // Consumers are found by walking the filesystem, not `git ls-files`. Using the git
  // list made this report false positives for symbols whose only callers were files
  // not yet committed — the check has to see the working tree it is judging.
  const srcFiles = walk("src");
  const consumers = ["src", "test", "scripts", "hooks"]
    .filter((d) => exists(d))
    .flatMap((d) => walk(d))
    .filter((f) => f.endsWith(".mjs"));

  const dead = [];
  for (const f of srcFiles) {
    const content = read(f);
    const names = [
      ...content.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/gm),
      ...content.matchAll(/^export\s+const\s+([A-Za-z0-9_]+)/gm),
    ].map((m) => m[1]);
    for (const n of names) {
      const usedElsewhere = consumers
        .filter((o) => o !== f)
        .some((o) => new RegExp(`\\b${n}\\b`).test(read(o)));
      if (!usedElsewhere) dead.push(`${n} (${f})`);
    }
  }
  dead.length === 0
    ? pass("Q2", "no dead exports", `${srcFiles.length} modules scanned`)
    : fail("Q2", "no dead exports", `${dead.length}: ${dead.slice(0, 6).join(", ")}${dead.length > 6 ? " …" : ""}`);

  const unit = await run("npm", ["test"]);
  const count = /# pass (\d+)/.exec(unit.stdout)?.[1];
  unit.ok
    ? pass("Q3", "unit suite passes", `${count} assertions`)
    : fail("Q3", "unit suite passes", (unit.stdout || unit.stderr).split("\n").slice(-4).join(" "));

  if (FULL) {
    const mcp = await run("npm", ["run", "test:mcp"]);
    const n = (mcp.stdout.match(/PASS/g) || []).length;
    mcp.ok
      ? pass("Q4", "MCP protocol suite passes", `${n} checks`)
      : fail("Q4", "MCP protocol suite passes", (mcp.stdout || mcp.stderr).split("\n").slice(-4).join(" "));
    pass("Q5", "every tool has a description and schema", "covered by the protocol suite");
  } else {
    manual("Q4", "MCP protocol suite passes", "npm run test:mcp");
    manual("Q5", "every tool has a description and schema", "npm run test:mcp");
  }

  // Q6 — error paths must be messages, not stack traces.
  const input = await import(path.join(repo, "src/analyze/input.mjs"));
  const cases = [];
  for (const [label, arg] of [["missing file", "/nope/missing.mov"], ["unsupported type", "package.json"]]) {
    try {
      await input.resolveInput(arg);
      cases.push(`${label}: no error thrown`);
    } catch (err) {
      if (!err.message || /^\s*$/.test(err.message) || err.message.includes("\n    at ")) {
        cases.push(`${label}: unhelpful (${err.message?.slice(0, 40)})`);
      }
    }
  }
  cases.length === 0
    ? pass("Q6", "error paths return actionable messages", "missing file and bad type both explained")
    : fail("Q6", "error paths return actionable messages", cases.join("; "));
}

// ─── D — Docs ────────────────────────────────────────────────────────────────

async function checkDocs() {
  if (!exists("docs/ARCHITECTURE.md")) {
    fail("D1", "architecture doc covers every src/ module", "docs/ARCHITECTURE.md is missing");
  } else {
    const arch = read("docs/ARCHITECTURE.md");
    const missing = walk("src").filter((f) => !arch.includes(path.basename(f)) && !arch.includes(f));
    missing.length === 0
      ? pass("D1", "architecture doc covers every src/ module", `${walk("src").length} modules documented`)
      : fail("D1", "architecture doc covers every src/ module", `undocumented: ${missing.join(", ")}`);
  }

  // D2 — the README states counts; they must be true.
  const readme = read("README.md");
  const claimedUnit = Number(/(\d+)\s+unit tests/.exec(readme)?.[1]);
  const claimedMcp = Number(/(\d+)\s+MCP protocol checks/.exec(readme)?.[1]);
  const unit = await run("npm", ["test"]);
  const actualUnit = Number(/# pass (\d+)/.exec(unit.stdout)?.[1]);
  const actualMcp = (read("test/mcp-check.mjs").match(/check\(/g) || []).length;

  const problems = [];
  if (claimedUnit && actualUnit && claimedUnit !== actualUnit) {
    problems.push(`README says ${claimedUnit} unit tests, actual ${actualUnit}`);
  }
  if (claimedMcp && actualMcp && Math.abs(claimedMcp - actualMcp) > 1) {
    problems.push(`README says ${claimedMcp} protocol checks, actual ~${actualMcp}`);
  }
  problems.length === 0
    ? pass("D2", "README numeric claims are true", `${actualUnit} unit tests, ~${actualMcp} protocol checks`)
    : fail("D2", "README numeric claims are true", problems.join("; "));

  // D3 — the README tool table must match the registered tools.
  const registered = new Set();
  for (const f of ["src/tools/capture-tools.mjs", "src/tools/analysis-tools.mjs", "src/server.mjs"]) {
    for (const m of read(f).matchAll(/registerTool\(\s*\n?\s*"([a-z_]+)"/g)) registered.add(m[1]);
  }
  const documented = new Set([...readme.matchAll(/^\| `([a-z_]+)`/gm)].map((m) => m[1]));
  const undocumented = [...registered].filter((t) => !documented.has(t));
  const phantom = [...documented].filter((t) => !registered.has(t));
  undocumented.length === 0 && phantom.length === 0
    ? pass("D3", "README tool table matches the server", `${registered.size} tools`)
    : fail(
        "D3",
        "README tool table matches the server",
        [undocumented.length ? `undocumented: ${undocumented}` : "", phantom.length ? `phantom: ${phantom}` : ""]
          .filter(Boolean)
          .join("; ")
      );

  // D4 — the two ways to record nothing must stay documented and detected.
  const doctorSrc = read("src/env/doctor.mjs");
  const inReadme = /active tab/i.test(readme) && /occlu/i.test(readme);
  const inDoctor = /active tab/i.test(doctorSrc) && /overlap|covered/i.test(doctorSrc);
  inReadme && inDoctor
    ? pass("D4", "the two blank-recording traps are documented and detected", "README and doctor both cover them")
    : fail("D4", "the two blank-recording traps are documented and detected", `readme=${inReadme} doctor=${inDoctor}`);
}

// ─── report ──────────────────────────────────────────────────────────────────

const files = await trackedFiles();
await checkPromises();
await checkNaming(files);
await checkSecurity(files);
await checkQuality(files);
await checkDocs();

const groups = { P: "Promises", N: "Naming", S: "Security", Q: "Quality", D: "Docs" };
const glyph = { PASS: "PASS  ", FAIL: "FAIL  ", MANUAL: "MANUAL" };

console.log("\nflipbook validation rubric\n" + "─".repeat(78));
for (const [letter, title] of Object.entries(groups)) {
  const rows = results.filter((r) => r.id.startsWith(letter));
  if (!rows.length) continue;
  console.log(`\n${letter} — ${title}`);
  for (const r of rows.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))) {
    console.log(`  [${glyph[r.status]}] ${r.id.padEnd(4)} ${r.what}`);
    if (r.evidence) console.log(`              ${r.evidence}`);
  }
}

const failed = results.filter((r) => r.status === "FAIL");
const manualCount = results.filter((r) => r.status === "MANUAL").length;
console.log("\n" + "─".repeat(78));
console.log(
  `${results.filter((r) => r.status === "PASS").length} pass · ${failed.length} fail · ${manualCount} manual` +
    (FULL ? "" : "   (run with --full to include macOS/Chrome criteria)")
);
if (failed.length) {
  console.log(`\nFailing: ${failed.map((f) => f.id).join(", ")}`);
}
process.exit(failed.length ? 1 : 0);
