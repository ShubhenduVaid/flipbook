/**
 * Generate the README demo contact sheet.
 *
 *   node scripts/make-demo.mjs
 *
 * Records the bundled fixture and writes docs/demo-contact-sheet.jpg.
 *
 * Deliberately launches Chrome with a throwaway profile in app mode. That yields a
 * window with no tab strip, no bookmarks bar, no history and no extensions, so the
 * published image cannot leak anything about whoever generated it — which matters,
 * because this tool records real screens. It also never touches your normal browser.
 */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { listWindows } from "../src/env/native.mjs";
import { startRecording, stopRecording } from "../src/capture/record.mjs";
import { analyzeVideo } from "../src/analyze/analyze.mjs";
import { probeDuration } from "../src/env/ffmpeg.mjs";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const fixture = path.join(repo, "test", "fixtures", "spinner-toast.html");
const outDir = path.join(repo, "docs");
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "flipbook-demo-"));
const profile = path.join(workDir, "profile");
const video = path.join(workDir, "demo.mov");

const TITLE = "flipbook fixture";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let chrome;
async function cleanup() {
  try {
    chrome?.kill("SIGTERM");
  } catch {}
  await sleep(500);
  try {
    // Kill only the throwaway-profile instance, never the user's Chrome.
    await execFileAsync("pkill", ["-f", `user-data-dir=${profile}`]);
  } catch {}
}

// The page holds its opening state until this moment, so the capture can start
// first and the sheet reads in the order the flow actually happens.
const LEAD_MS = 14_000;
const PREROLL_MS = 1_500;
const startAt = Date.now() + LEAD_MS;

try {
  console.log("launching a throwaway Chrome profile in app mode…");
  chrome = spawn(
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    [
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
      "--window-size=1180,800",
      "--window-position=80,80",
      `--app=file://${fixture}?loop=1&at=${startAt}`,
    ],
    { stdio: "ignore", detached: false }
  );

  // Wait for the window to exist and be large enough to record.
  let target = null;
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(500);
    const windows = await listWindows().catch(() => []);
    target = windows.find(
      (w) => (w.title || "").toLowerCase().includes(TITLE) && w.width > 400
    );
  }
  if (!target) throw new Error("the demo window never appeared");
  console.log(`recording "${target.title}" (${target.width}x${target.height})`);

  // Begin a little before the flow starts, so the sheet opens on the resting state.
  const untilStart = startAt - Date.now() - PREROLL_MS;
  if (untilStart < 0) {
    throw new Error(
      `window discovery took too long — the flow already started ${-untilStart}ms ago. ` +
        `Raise LEAD_MS.`
    );
  }
  await sleep(untilStart);

  const rec = await startRecording({
    id: "demo",
    outPath: video,
    target: "window",
    bundleId: "com.google.Chrome",
    windowId: target.windowId,
    fps: 30,
    maxDurationSec: 30,
  });

  // One full cycle plus margin, so the sheet always contains spinner, panel and toast.
  const seconds = 13;
  console.log(`capturing ${seconds}s…`);
  await sleep(seconds * 1000);

  const stopped = await stopRecording("demo");
  if (!stopped || stopped.bytes === 0) throw new Error(`recording produced no data`);
  const duration = await probeDuration(video);
  console.log(`captured ${(stopped.bytes / 1e6).toFixed(2)} MB, ${duration?.toFixed(1)}s`);

  fs.mkdirSync(outDir, { recursive: true });
  const result = await analyzeVideo({
    video,
    events: [],
    outDir: workDir,
    label: "checkout flow",
    returnMode: "paths",
    rubric: "A loading spinner appears while the order is processing.\nA confirmation panel appears.\nA success toast appears and then disappears.",
  });

  const sheet = result.structuredContent.contactSheet;
  if (!sheet) throw new Error("no contact sheet was produced");
  const dest = path.join(outDir, "demo-contact-sheet.jpg");
  fs.copyFileSync(sheet, dest);

  console.log(`\nwrote ${dest} (${(fs.statSync(dest).size / 1024).toFixed(0)} KB)`);
  console.log(`keyframes: ${result.structuredContent.keyframes.map((k) => k.t + "s").join(", ")}`);
  for (const n of result.structuredContent.notes) console.log(`note: ${n}`);
} finally {
  await cleanup();
  if (process.argv.includes("--keep")) {
    console.log(`kept working files in ${workDir}`);
  } else {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
  console.log("cleaned up the throwaway profile");
}
