import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import { resolveFfmpeg, capabilities, listAvfDevices, repairBundledFfmpeg } from "./ffmpeg.mjs";
import { hasSwift, buildNative, listWindows, BINARY } from "./native.mjs";
import { DATA_HOME } from "./paths.mjs";
import { totalFootprint } from "../capture/session.mjs";

const execFileAsync = promisify(execFile);

const ok = (name, detail) => ({ name, status: "ok", detail });
const warn = (name, detail, fix) => ({ name, status: "warn", detail, fix });
const bad = (name, detail, fix) => ({ name, status: "fail", detail, fix });

async function checkMacOS() {
  try {
    const { stdout } = await execFileAsync("sw_vers", ["-productVersion"], { timeout: 10_000 });
    const v = stdout.trim();
    const major = Number(v.split(".")[0]);
    if (Number.isNaN(major)) return warn("macOS", `unrecognised version ${v}`);
    if (major < 15) {
      return bad(
        "macOS",
        `${v} — window recording needs macOS 15+`,
        "Upgrade macOS, or set target:\"display\" to use the ffmpeg display-capture fallback."
      );
    }
    return ok("macOS", v);
  } catch {
    return bad("macOS", "not macOS — this plugin is macOS-only");
  }
}

async function checkFfmpeg() {
  let bin;
  let repaired = false;
  try {
    bin = resolveFfmpeg();
  } catch {
    // A marketplace install leaves ffmpeg-static without its binary, because plugin
    // dependencies are installed with --ignore-scripts. That is the expected state on
    // first run, not a user error, so repair it here rather than reporting a failure
    // the user has to go and fix by hand in the plugin cache.
    const repair = await repairBundledFfmpeg();
    repaired = repair.attempted && repair.ok;
    try {
      bin = resolveFfmpeg();
    } catch (err) {
      // resolveFfmpeg tailors its message to why it failed, so a fixed
      // "brew install ffmpeg" hint here would contradict the specific fix it names.
      return [bad("ffmpeg", err.message)];
    }
  }
  const results = [ok("ffmpeg", `${bin}${repaired ? " (bundled binary just restored)" : ""}`)];
  try {
    const caps = await capabilities();
    const missing = ["scale", "crop", "tile", "drawtext", "drawbox", "select"].filter(
      (f) => !caps[f]
    );
    results.push(
      missing.length
        ? bad("ffmpeg filters", `missing: ${missing.join(", ")}`, "brew install ffmpeg")
        : ok("ffmpeg filters", "scale, crop, tile, drawtext, drawbox, select")
    );
  } catch (err) {
    results.push(warn("ffmpeg filters", err.message));
  }
  return results;
}

async function checkNative() {
  if (!(await hasSwift())) {
    return [
      bad(
        "swiftc",
        "Xcode Command Line Tools not found",
        "xcode-select --install, then `npm run build:native`"
      ),
    ];
  }
  try {
    const { built } = await buildNative();
    return [ok("sckrec", `${BINARY}${built ? " (just compiled)" : ""}`)];
  } catch (err) {
    return [bad("sckrec", err.message, "npm run build:native --force")];
  }
}

/**
 * Screen Recording permission has no direct API from Node, but it has a reliable
 * proxy: without it, ScreenCaptureKit either refuses to enumerate windows or
 * returns them with every title blanked. Both are detected here, because the
 * failure mode users actually hit is a silently empty recording, not an error.
 */
async function checkPermission() {
  let windows;
  try {
    windows = await listWindows();
  } catch (err) {
    return [
      bad(
        "screen recording permission",
        `could not enumerate windows: ${err.message}`,
        "System Settings > Privacy & Security > Screen & System Audio Recording — " +
          "enable your terminal app, then restart it."
      ),
    ];
  }
  const named = windows.filter((w) => (w.title || "").length > 0);
  if (windows.length > 0 && named.length === 0) {
    return [
      bad(
        "screen recording permission",
        "windows are visible but all titles are blank — permission is not granted",
        "System Settings > Privacy & Security > Screen & System Audio Recording — " +
          "enable your terminal app, then restart it."
      ),
    ];
  }
  return [ok("screen recording permission", `granted (${windows.length} windows visible)`)];
}

async function checkChrome() {
  let windows = [];
  try {
    windows = await listWindows();
  } catch {
    return [warn("Chrome", "could not enumerate windows")];
  }
  const chrome = windows.filter(
    (w) => w.bundleId === "com.google.Chrome" && w.width > 200 && w.height > 200
  );
  if (!chrome.length) {
    return [
      warn(
        "Chrome",
        "no Chrome window found",
        "Open Chrome with at least one window before recording."
      ),
    ];
  }
  const biggest = chrome.sort((a, b) => b.width * b.height - a.width * a.height)[0];
  const results = [
    ok(
      "Chrome",
      `${chrome.length} window(s); default target: "${biggest.title}" ${biggest.width}x${biggest.height}`
    ),
  ];

  // Overlapping windows are the single most confusing failure: the recording looks
  // fine, runs the right length, and contains a frozen page, because the browser
  // stops painting a window that another window covers.
  const overlapping = chrome.some((a) =>
    chrome.some((b) => a !== b && Math.abs(a.x - b.x) < 200 && Math.abs(a.y - b.y) < 200)
  );
  if (chrome.length > 1) {
    results.push(
      warn(
        "Chrome windows",
        `${chrome.length} windows match` +
          (overlapping ? " and at least two overlap" : "") +
          `; the wrong one may be recorded`,
        overlapping
          ? "Move or close the overlapping window — a covered window stops painting and " +
            "records blank. Pass title_contains or window_id to pick deliberately."
          : "Pass title_contains or window_id to start_recording to pick deliberately."
      )
    );
  }
  results.push(
    warn(
      "active tab",
      "window capture records only each window's ACTIVE tab",
      "Switch to the tab you want to validate before recording — Claude in Chrome can " +
        "drive a background tab, which would never appear in the recording."
    )
  );
  return results;
}

async function checkDisk() {
  try {
    const { stdout } = await execFileAsync("df", ["-k", DATA_HOME], { timeout: 10_000 });
    const line = stdout.trim().split("\n").pop();
    const availKb = Number(line.split(/\s+/)[3]);
    const gb = availKb / 1024 / 1024;
    // ~30 MB/min at these settings; 2 GB is a comfortable floor.
    if (gb < 2) return [warn("disk space", `${gb.toFixed(1)} GB free in ${DATA_HOME}`)];
    return [ok("disk space", `${gb.toFixed(1)} GB free`)];
  } catch {
    return [warn("disk space", "could not determine free space")];
  }
}

/**
 * How much disk the tool itself is holding. Reported because nothing ever did: a day of
 * ordinary use reached 4.5 GB, and it was only noticed when sessions were listed at the
 * end of it.
 */
function checkFootprint() {
  try {
    const f = totalFootprint();
    const size = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${(n / 1e6).toFixed(0)} MB`);
    const detail =
      `${size(f.bytes)} across ${f.sessions} session(s)` +
      (f.reclaimableCount
        ? ` · ${size(f.reclaimableBytes)} in ${f.reclaimableCount} never analysed`
        : "") +
      (f.importsBytes ? ` · imports cache ${size(f.importsBytes)}` : "");
    const fix = "prune_recordings shows what would be freed; it deletes nothing without confirm:true.";
    if (f.bytes > 5e9 || f.reclaimableBytes > 1e9) return [warn("disk footprint", detail, fix)];
    return [ok("disk footprint", detail)];
  } catch {
    // doctor must never throw; a footprint it cannot measure is not a reason to fail.
    return [warn("disk footprint", "could not measure recordings on disk")];
  }
}

async function checkAvfFallback() {
  try {
    const { screens } = await listAvfDevices();
    if (!screens.length) return [warn("display-capture fallback", "no avfoundation screen device")];
    return [
      ok(
        "display-capture fallback",
        screens.map((s) => `[${s.index}] ${s.name}`).join(", ")
      ),
    ];
  } catch (err) {
    return [warn("display-capture fallback", err.message)];
  }
}

export async function runDoctor() {
  const checks = [
    await checkMacOS(),
    ...(await checkFfmpeg()),
    ...(await checkNative()),
    ...(await checkPermission()),
    ...(await checkChrome()),
    ...(await checkAvfFallback()),
    ...(await checkDisk()),
    ...checkFootprint(),
  ];
  const failures = checks.filter((c) => c.status === "fail");
  const warnings = checks.filter((c) => c.status === "warn");
  return {
    ready: failures.length === 0,
    checks,
    summary:
      failures.length === 0
        ? `Ready to record${warnings.length ? ` (${warnings.length} warning(s))` : ""}.`
        : `${failures.length} blocking problem(s) must be fixed before recording.`,
    host: `${os.platform()} ${os.release()} · node ${process.version} · data: ${DATA_HOME}`,
  };
}

export function formatDoctor(result) {
  const glyph = { ok: "OK  ", warn: "WARN", fail: "FAIL" };
  const lines = [result.summary, ""];
  for (const c of result.checks) {
    lines.push(`[${glyph[c.status]}] ${c.name}: ${c.detail}`);
    if (c.fix) lines.push(`         fix: ${c.fix}`);
  }
  lines.push("", result.host);
  return lines.join("\n");
}

