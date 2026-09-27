#!/usr/bin/env node
/**
 * Manifest lint for CI.
 *
 * `claude plugin validate --strict` is the authoritative check, but it needs the CLI
 * and its auth, which is more than a CI job should carry. This covers the failures
 * that actually break an install — malformed JSON, a missing required field, a
 * version that disagrees between manifests, a declared file that isn't there — and
 * runs anywhere Node does.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];
const checked = [];

const fail = (msg) => problems.push(msg);

function readJson(rel) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) {
    fail(`${rel}: missing`);
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(abs, "utf8"));
    checked.push(rel);
    return parsed;
  } catch (err) {
    fail(`${rel}: invalid JSON — ${err.message}`);
    return null;
  }
}

function requireFields(rel, obj, fields) {
  for (const f of fields) {
    const value = f.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
    if (value === undefined || value === null || value === "") {
      fail(`${rel}: missing required field "${f}"`);
    }
  }
}

function requireFile(rel, from) {
  if (!fs.existsSync(path.join(root, rel))) {
    fail(`${from} references "${rel}", which does not exist`);
  }
}

// ---- plugin manifest -------------------------------------------------------
const plugin = readJson(".claude-plugin/plugin.json");
if (plugin) {
  requireFields(".claude-plugin/plugin.json", plugin, [
    "name", "version", "description", "author.name", "license", "repository",
  ]);
  if (plugin.name && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(plugin.name)) {
    fail(`plugin.json: name "${plugin.name}" must be kebab-case`);
  }
  if (plugin.version && !/^\d+\.\d+\.\d+/.test(plugin.version)) {
    fail(`plugin.json: version "${plugin.version}" is not semver`);
  }
  if (plugin.keywords && !Array.isArray(plugin.keywords)) {
    fail("plugin.json: keywords must be an array");
  }
}

// ---- marketplace manifest --------------------------------------------------
const marketplace = readJson(".claude-plugin/marketplace.json");
if (marketplace) {
  requireFields(".claude-plugin/marketplace.json", marketplace, [
    "name", "owner.name", "plugins",
  ]);
  if (!Array.isArray(marketplace.plugins) || marketplace.plugins.length === 0) {
    fail("marketplace.json: plugins must be a non-empty array");
  } else {
    for (const entry of marketplace.plugins) {
      if (!entry.name) fail("marketplace.json: a plugin entry has no name");
      if (!entry.source) fail(`marketplace.json: "${entry.name}" has no source`);
    }
  }
  // Reserved names are rejected at load time, which presents as a confusing
  // "untrusted source" error rather than a validation failure.
  const reserved = new Set([
    "claude-code-marketplace", "claude-code-plugins", "claude-plugins-official",
    "claude-plugins-community", "claude-community", "anthropic-marketplace",
    "anthropic-plugins", "agent-skills", "anthropic-agent-skills",
    "knowledge-work-plugins", "life-sciences", "claude-for-legal",
    "claude-for-financial-services", "financial-services-plugins",
    "first-party-plugins", "healthcare",
  ]);
  if (reserved.has(marketplace.name)) {
    fail(`marketplace.json: "${marketplace.name}" is reserved for Anthropic`);
  }
}

// ---- the two manifests must agree -----------------------------------------
if (plugin && marketplace?.plugins?.length) {
  const entry = marketplace.plugins.find((p) => p.name === plugin.name);
  if (!entry) {
    fail(`marketplace.json has no entry named "${plugin.name}"`);
  } else if (entry.version && entry.version !== plugin.version) {
    // `claude plugin tag` refuses to tag when these disagree.
    fail(
      `version mismatch: plugin.json says ${plugin.version}, ` +
        `marketplace entry says ${entry.version}`
    );
  }
}

// ---- package.json ----------------------------------------------------------
const pkg = readJson("package.json");
if (pkg && plugin) {
  // npm's unscoped "flipbook" belongs to someone else, so the package is published under
  // a scope. Only the bare name has to match the plugin.
  if (pkg.name.replace(/^@[^/]+\//, "") !== plugin.name) {
    fail(`package.json name "${pkg.name}" does not match plugin name "${plugin.name}"`);
  }
  if (pkg.version !== plugin.version) {
    fail(`package.json version "${pkg.version}" does not match plugin "${plugin.version}"`);
  }
  if (pkg.license !== plugin.license) {
    fail(`package.json license "${pkg.license}" does not match plugin "${plugin.license}"`);
  }
}

// ---- server.json (MCP Registry) -------------------------------------------
// The registry proves ownership by reading mcpName from the *published* npm package, so
// a mismatch here is a failed release discovered after the npm publish already happened.
const registry = readJson("server.json");
if (registry && pkg) {
  if (registry.name !== pkg.mcpName) {
    fail(`server.json name "${registry.name}" does not match package.json mcpName "${pkg.mcpName}"`);
  }
  if ((registry.description ?? "").length > 100) {
    fail(`server.json: description is ${registry.description.length} characters; the registry allows 100`);
  }
  if (registry.version !== pkg.version) {
    fail(`server.json version "${registry.version}" does not match package.json "${pkg.version}"`);
  }
  const npmPkg = (registry.packages ?? []).find((p) => p.registryType === "npm");
  if (!npmPkg) fail("server.json: no npm package entry");
  else {
    if (npmPkg.identifier !== pkg.name) {
      fail(`server.json package "${npmPkg.identifier}" is not the npm package "${pkg.name}"`);
    }
    if (npmPkg.version !== pkg.version) {
      fail(`server.json package version "${npmPkg.version}" does not match "${pkg.version}"`);
    }
  }
}

// ---- mcpb/manifest.json (Claude Desktop extension) --------------------------
const mcpb = readJson("mcpb/manifest.json");
if (mcpb && plugin) {
  if (mcpb.name !== plugin.name) fail(`mcpb manifest name "${mcpb.name}" does not match "${plugin.name}"`);
  if (mcpb.version !== plugin.version) {
    fail(`mcpb manifest version "${mcpb.version}" does not match "${plugin.version}"`);
  }
  requireFile(mcpb.server?.entry_point ?? "(no entry_point)", "mcpb/manifest.json");

  // The listing shows these tools, so they have to be the ones the server registers.
  const registered = new Set();
  for (const f of ["src/server.mjs", "src/tools/capture-tools.mjs", "src/tools/analysis-tools.mjs"]) {
    const src = fs.readFileSync(path.join(root, f), "utf8");
    for (const m of src.matchAll(/registerTool\(\s*"([a-z_]+)"/g)) registered.add(m[1]);
  }
  const listed = new Set((mcpb.tools ?? []).map((t) => t.name));
  const missing = [...registered].filter((t) => !listed.has(t));
  const extra = [...listed].filter((t) => !registered.has(t));
  if (missing.length) fail(`mcpb manifest does not list: ${missing.join(", ")}`);
  if (extra.length) fail(`mcpb manifest lists tools the server lacks: ${extra.join(", ")}`);
}

// ---- component files referenced by the manifests --------------------------
const mcp = readJson(".mcp.json");
if (mcp) {
  const servers = Object.keys(mcp.mcpServers ?? {});
  if (servers.length !== 1) {
    fail(`.mcp.json should declare exactly one server, found ${servers.length}`);
  }
  // CLAUDE_PLUGIN_ROOT is a literal placeholder Claude Code substitutes at load time,
  // so these really are plain strings and not template literals we forgot to tag.
  // Claude Code substitutes this placeholder at plugin load time, so it is a literal
  // string here rather than a template we forgot to tag.
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder, not a template
  const ROOT_PLACEHOLDER = "${CLAUDE_PLUGIN_ROOT}";
  for (const [name, cfg] of Object.entries(mcp.mcpServers ?? {})) {
    const entry = (cfg.args ?? []).find((a) => a.includes(ROOT_PLACEHOLDER));
    if (!entry) {
      fail(`.mcp.json: server "${name}" must locate its script via ${ROOT_PLACEHOLDER}`);
    } else {
      requireFile(entry.replace(`${ROOT_PLACEHOLDER}/`, ""), ".mcp.json");
    }
  }
}

const hooks = readJson("hooks/hooks.json");
if (hooks) {
  const entries = hooks.hooks?.PostToolUse ?? [];
  if (!entries.length) fail("hooks/hooks.json: no PostToolUse hooks declared");
  for (const group of entries) {
    for (const h of group.hooks ?? []) {
      const m = /\$\{CLAUDE_PLUGIN_ROOT\}\/([^"\s]+)/.exec(h.command ?? "");
      if (m) requireFile(m[1], "hooks/hooks.json");
    }
  }
}

for (const required of ["LICENSE", "README.md", "src/server.mjs", "native/sckrec.swift"]) {
  requireFile(required, "repository layout");
}

// ---- report ----------------------------------------------------------------
if (problems.length) {
  console.error(`Manifest lint failed with ${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`Manifest lint passed (${checked.length} manifests checked).`);
