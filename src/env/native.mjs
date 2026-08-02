import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { PLUGIN_ROOT, NATIVE_DIR, ensureDirs } from "./paths.mjs";
import { frontmostChromeWindow, boundsMatch, isChrome } from "./chrome.mjs";

const execFileAsync = promisify(execFile);

export const SOURCE = path.join(PLUGIN_ROOT, "native", "sckrec.swift");
export const BINARY = path.join(NATIVE_DIR, "sckrec");

/** Rebuild when the source is newer than the binary, so edits never go stale. */
function isStale() {
  if (!fs.existsSync(BINARY)) return true;
  if (!fs.existsSync(SOURCE)) return false;
  return fs.statSync(SOURCE).mtimeMs > fs.statSync(BINARY).mtimeMs;
}

export async function hasSwift() {
  try {
    await execFileAsync("xcrun", ["--find", "swiftc"], { timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Compiles native/sckrec.swift into the data dir. Kept out of the repo so a
 * read-only or shared plugin checkout still works.
 *
 * swiftc requires top-level code to live in a file literally named main.swift,
 * so the source is staged under that name in a scratch build dir.
 */
export async function buildNative({ force = false } = {}) {
  ensureDirs();
  if (!force && !isStale()) return { built: false, path: BINARY };

  if (!fs.existsSync(SOURCE)) {
    throw new Error(`native source missing: ${SOURCE}`);
  }
  if (!(await hasSwift())) {
    throw new Error(
      "swiftc not found. Install the Xcode Command Line Tools with `xcode-select --install`, " +
        "then run `npm run build:native` in the plugin directory."
    );
  }

  const buildDir = path.join(NATIVE_DIR, "build");
  fs.mkdirSync(buildDir, { recursive: true });
  const staged = path.join(buildDir, "main.swift");
  fs.copyFileSync(SOURCE, staged);

  try {
    await execFileAsync("xcrun", ["swiftc", "-O", staged, "-o", BINARY], {
      timeout: 240_000,
    });
  } catch (err) {
    const detail = (err.stderr || err.message || "")
      .split("\n")
      .filter((l) => /error:/.test(l))
      .slice(0, 10)
      .join("\n");
    throw new Error(`failed to compile sckrec:\n${detail || err.message}`);
  }
  return { built: true, path: BINARY };
}

/** Build if needed, then hand back the binary path. */
export async function ensureNative() {
  await buildNative();
  if (!fs.existsSync(BINARY)) throw new Error(`sckrec missing after build: ${BINARY}`);
  return BINARY;
}

/** Windows ScreenCaptureKit is willing to share, largest first. */
export async function listWindows() {
  const bin = await ensureNative();
  const { stdout } = await execFileAsync(bin, ["--list"], { timeout: 30_000 });
  return JSON.parse(stdout);
}

/**
 * Resolve the window a capture request refers to, without starting a capture.
 *
 * Returns the chosen window plus how it was chosen and how many others matched, so
 * callers can warn when the choice was ambiguous. Picking by size alone is not
 * enough: two Chrome windows showing the same page have identical titles *and*
 * identical dimensions, and silently recording the wrong one produces a recording in
 * which nothing ever happens.
 */
export async function findWindow({ bundleId = "com.google.Chrome", windowId, titleContains } = {}) {
  const windows = await listWindows();
  let candidates = windows.filter((w) => w.width > 200 && w.height > 200);

  if (windowId != null) {
    const exact = candidates.find((w) => w.windowId === Number(windowId));
    return exact ? { window: exact, how: "window_id", candidates: 1 } : { window: null, how: "window_id", candidates: 0 };
  }

  candidates = candidates.filter((w) => w.bundleId === bundleId);
  if (titleContains) {
    const needle = String(titleContains).toLowerCase();
    // A title filter that matches nothing is an error, never a reason to fall back.
    // Silently recording a different window than the caller named produces a
    // recording in which nothing they did ever appears.
    candidates = candidates.filter((w) => (w.title || "").toLowerCase().includes(needle));
    if (!candidates.length) {
      return { window: null, how: "title_no_match", candidates: 0 };
    }
  }
  if (!candidates.length) return { window: null, how: "none", candidates: 0 };
  const total = candidates.length;

  // Prefer the window Chrome itself calls frontmost — that is the one Claude in
  // Chrome drives — identified by matching its bounds, which stay unique when titles
  // and sizes do not.
  if (isChrome(bundleId) && total > 1) {
    const front = await frontmostChromeWindow();
    if (front) {
      const match = candidates.find((w) => boundsMatch(w, front));
      if (match) return { window: match, how: "frontmost", candidates: total };
    }
  }

  const sorted = [...candidates].sort((a, b) => b.width * b.height - a.width * a.height);
  return { window: sorted[0], how: total > 1 ? "largest" : "only", candidates: total };
}
