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
  if (pkg.name !== plugin.name) {
    fail(`package.json name "${pkg.name}" does not match plugin name "${plugin.name}"`);
  }
  if (pkg.version !== plugin.version) {
    fail(`package.json version "${pkg.version}" does not match plugin "${plugin.version}"`);
  }
  if (pkg.license !== plugin.license) {
    fail(`package.json license "${pkg.license}" does not match plugin "${plugin.license}"`);
  }
}

// ---- component files referenced by the manifests --------------------------
const mcp = readJson(".mcp.json");
if (mcp) {
  const servers = Object.keys(mcp.mcpServers ?? {});
  if (servers.length !== 1) {
    fail(`.mcp.json should declare exactly one server, found ${servers.length}`);
  }
  for (const [name, cfg] of Object.entries(mcp.mcpServers ?? {})) {
    const entry = (cfg.args ?? []).find((a) => a.includes("${CLAUDE_PLUGIN_ROOT}"));
    if (!entry) {
      fail(`.mcp.json: server "${name}" must locate its script via \${CLAUDE_PLUGIN_ROOT}`);
    } else {
      requireFile(entry.replace("${CLAUDE_PLUGIN_ROOT}/", ""), ".mcp.json");
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
