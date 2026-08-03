import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import { createRequire } from "node:module";
import { PLUGIN_ROOT } from "./paths.mjs";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

let cached = null;

/** Forget the resolved binary, so a repair can be picked up without a restart. */
function clearFfmpegCache() {
  cached = null;
}

/** True when the package is installed but its downloaded binary is absent. */
function bundledFfmpegNeedsRepair() {
  try {
    const p = require("ffmpeg-static");
    return typeof p === "string" && !fs.existsSync(p);
  } catch {
    return false;
  }
}

/**
 * Re-run ffmpeg-static's postinstall.
 *
 * Claude Code installs plugin dependencies with --ignore-scripts, which is the right
 * default for running third-party code but means ffmpeg-static never downloads its
 * binary — so a freshly installed plugin has the package and no ffmpeg. npm considers
 * the dependency satisfied at that point, so only an explicit rebuild recovers it.
 * doctor calls this so the fix is one command the user already runs, rather than a
 * manual cd into the plugin cache.
 */
export async function repairBundledFfmpeg() {
  if (!bundledFfmpegNeedsRepair()) return { attempted: false, ok: true };
  try {
    await execFileAsync("npm", ["rebuild", "ffmpeg-static"], {
      cwd: PLUGIN_ROOT,
      timeout: 180_000,
    });
    clearFfmpegCache();
    return { attempted: true, ok: !bundledFfmpegNeedsRepair() };
  } catch (err) {
    return { attempted: true, ok: false, error: err.stderr || err.message };
  }
}

/**
 * Resolution order: explicit override -> system PATH -> bundled ffmpeg-static.
 * A system ffmpeg is preferred because it is usually newer and users who have
 * one generally want it used; ffmpeg-static is the zero-setup fallback.
 */
export function resolveFfmpeg() {
  if (cached) return cached;

  const candidates = [];
  if (process.env.FLIPBOOK_FFMPEG) candidates.push(process.env.FLIPBOOK_FFMPEG);
  for (const p of ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"]) {
    candidates.push(p);
  }
  let staticInstalled = false;
  try {
    candidates.push(require("ffmpeg-static"));
    staticInstalled = true;
  } catch {
    /* not installed */
  }

  for (const c of candidates) {
    if (c && fs.existsSync(c)) {
      cached = c;
      return c;
    }
  }

  // "run npm install" is the wrong advice in the most confusing case. ffmpeg-static
  // fetches its binary in a postinstall script, so installing with --ignore-scripts
  // leaves the package present but the binary absent — and npm then considers the
  // dependency satisfied and will not re-run the script. Only `npm rebuild` recovers it.
  throw new Error(
    "No ffmpeg found. " +
      (staticInstalled
        ? "The bundled ffmpeg-static package is installed but its binary is missing, " +
          "which is what happens when dependencies were installed with --ignore-scripts. " +
          "Run `npm rebuild ffmpeg-static` in the plugin directory"
        : "Run `npm install` in the plugin directory to get the bundled build") +
      ", or install a system ffmpeg with `brew install ffmpeg`. " +
      "You can also point FLIPBOOK_FFMPEG at an existing binary."
  );
}

/** Run ffmpeg. Non-zero exit rejects with stderr attached, which is where ffmpeg talks. */
export async function ffmpeg(args, { timeout = 120_000 } = {}) {
  const bin = resolveFfmpeg();
  try {
    const { stdout, stderr } = await execFileAsync(bin, ["-hide_banner", ...args], {
      timeout,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { stdout, stderr };
  } catch (err) {
    const detail = (err.stderr || "").split("\n").slice(-12).join("\n").trim();
    throw new Error(`ffmpeg failed (${args.join(" ")}):\n${detail || err.message}`);
  }
}

/** Raw-bytes variant: for piping decoded frames straight into memory. */
export async function ffmpegRaw(args, { timeout = 180_000 } = {}) {
  const bin = resolveFfmpeg();
  const { stdout } = await execFileAsync(bin, ["-hide_banner", ...args], {
    timeout,
    maxBuffer: 512 * 1024 * 1024,
    encoding: "buffer",
  });
  return stdout;
}

/** Duration in seconds, read from ffmpeg's own stderr banner (no ffprobe dependency). */
export async function probeDuration(file) {
  const bin = resolveFfmpeg();
  let stderr = "";
  try {
    await execFileAsync(bin, ["-hide_banner", "-i", file], { timeout: 30_000 });
  } catch (err) {
    stderr = err.stderr || "";
  }
  const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/** Video pixel dimensions, likewise parsed from the banner. */
export async function probeSize(file) {
  const bin = resolveFfmpeg();
  let stderr = "";
  try {
    await execFileAsync(bin, ["-hide_banner", "-i", file], { timeout: 30_000 });
  } catch (err) {
    stderr = err.stderr || "";
  }
  const m = stderr.match(/Video:.*?,\s*(\d{2,5})x(\d{2,5})/);
  if (!m) return null;
  return { width: Number(m[1]), height: Number(m[2]) };
}

/** Which optional pieces this ffmpeg build actually has. Used by doctor. */
export async function capabilities() {
  const bin = resolveFfmpeg();
  const out = {};
  const { stdout: devs } = await execFileAsync(bin, ["-hide_banner", "-devices"], {
    timeout: 20_000,
  }).catch((e) => ({ stdout: e.stdout || "" }));
  out.avfoundation = /avfoundation/.test(devs);

  const { stdout: filters } = await execFileAsync(bin, ["-hide_banner", "-filters"], {
    timeout: 20_000,
    maxBuffer: 8 * 1024 * 1024,
  }).catch((e) => ({ stdout: e.stdout || "" }));
  for (const f of ["scale", "crop", "tile", "drawtext", "drawbox", "select", "signalstats"]) {
    out[f] = new RegExp(`\\b${f}\\b`).test(filters);
  }
  return out;
}

/**
 * avfoundation device indices are machine-dependent (cameras come first), so the
 * screen index must always be parsed, never hardcoded.
 */
export async function listAvfDevices() {
  const bin = resolveFfmpeg();
  let stderr = "";
  try {
    await execFileAsync(bin, ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""], {
      timeout: 20_000,
    });
  } catch (err) {
    // Listing devices always exits non-zero with "Input/output error". Expected.
    stderr = err.stderr || "";
  }
  const screens = [];
  for (const line of stderr.split("\n")) {
    const m = line.match(/\[(\d+)\]\s+(Capture screen \d+)/);
    if (m) screens.push({ index: Number(m[1]), name: m[2] });
  }
  return { screens, raw: stderr };
}
