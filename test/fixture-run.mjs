/**
 * Manual end-to-end check against test/fixtures/spinner-toast.html.
 *
 *   node test/fixture-run.mjs [--front] [--seconds 9]
 *
 * Verifies the claim the whole plugin rests on: that keyframe selection surfaces a
 * transient spinner and a toast that has already vanished by the end of the run —
 * the two things a before/after screenshot pair cannot show.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

import { startRecording, stopRecording } from "../src/capture/record.mjs";
import { analyzeVideo } from "../src/analyze/analyze.mjs";
import { probeDuration } from "../src/env/ffmpeg.mjs";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "fixtures", "spinner-toast.html");

const front = process.argv.includes("--front");
const secArg = process.argv.indexOf("--seconds");
const seconds = secArg > -1 ? Number(process.argv[secArg + 1]) : 9;

const outDir = path.join(here, "..", ".fixture-out", front ? "front" : "occluded");
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
const video = path.join(outDir, "run.mov");

const osa = (script) => execFileAsync("osascript", ["-e", script], { timeout: 30_000 });

console.log(`\n=== fixture run (${front ? "Chrome frontmost" : "Chrome occluded"}) ===`);

// Open a blank tab first and only navigate to the fixture once recording is running.
// Loading the fixture up front means it is already mid-animation at t=0, so the very
// first frame shows a spinner — which then legitimately dedupes against the real
// spinner later and makes the run look like a miss.
await osa(`tell application "Google Chrome"
  make new tab at end of tabs of window 1 with properties {URL:"about:blank"}
  set active tab index of window 1 to (count of tabs of window 1)
end tell`);
await new Promise((r) => setTimeout(r, 800));

if (front) await osa('tell application "Google Chrome" to activate');
await new Promise((r) => setTimeout(r, 800));

const rec = await startRecording({
  id: "fixture",
  outPath: video,
  target: "window",
  bundleId: "com.google.Chrome",
  fps: 30,
  maxDurationSec: seconds + 5,
});
const recStartMs = Date.now();
console.log(`recording "${rec.window?.title}" ${rec.window?.captureWidth}x${rec.window?.captureHeight}`);

// Navigate to the fixture now that capture is running, so the whole flow — blank
// page, load, spinner, panel, toast — happens inside the recording.
await osa(
  `tell application "Google Chrome" to set URL of active tab of window 1 to "file://${fixture}"`
);
const t0 = Date.now();
const reloadOffset = (t0 - recStartMs) / 1000;
console.log(`fixture navigation began ${reloadOffset.toFixed(2)}s into the recording`);

const events = [
  { tsMs: t0, type: "mark", note: "navigated to fixture — flow starts" },
  { tsMs: t0 + 1000, type: "mark", note: "expect spinner to appear" },
  { tsMs: t0 + 5000, type: "mark", note: "expect toast to appear" },
];

await new Promise((r) => setTimeout(r, seconds * 1000));
const stopped = await stopRecording("fixture");
console.log(`stopped: ${(stopped.bytes / 1e6).toFixed(2)} MB, ${(await probeDuration(video))?.toFixed(2)}s`);

const aligned = events.map((e) => ({ ...e, t: Number(((e.tsMs - recStartMs) / 1000).toFixed(2)) }));

const result = await analyzeVideo({
  video,
  events: aligned,
  outDir,
  label: `fixture (${front ? "frontmost" : "occluded"})`,
  rubric: "A loading spinner is shown while the order is processing.\nA confirmation panel appears.\nA success toast appears and then disappears.",
});

const sc = result.structuredContent;
console.log(`\nkeyframes: ${sc.keyframes.length}   transitions: ${sc.transitionCount}   tokens: ${sc.estimatedTokens}/${sc.tokenCeiling}`);
console.log("selected moments:");
for (const k of sc.keyframes) {
  console.log(`  t=${String(k.t).padStart(6)}s  d=${k.delta.toFixed(3)}  ${k.anomalous ? "ANOM " : "     "}${k.reasons.join(", ")}`);
}
console.log(`\ncontact sheet: ${sc.contactSheet}`);
for (const n of sc.notes) console.log(`note: ${n}`);

// The fixture's own schedule, shifted into recording time by the navigation offset:
// spinner 1–3s, panel from 3s, toast 5–6.5s after the page loads.
//
// TOLERANCE is not slack for a flaky product — it accounts for the offset itself being
// approximate. It is measured from when the AppleScript navigation call returns, which
// is not exactly when the page's timers start, so every fixture timestamp carries a few
// hundred milliseconds of uncertainty. Without it, a slow navigation slides the toast
// window past a keyframe that did correctly capture the toast.
const TOLERANCE = 0.6;
const shift = (lo, hi) => ({
  lo: lo + reloadOffset - TOLERANCE,
  hi: hi + reloadOffset + TOLERANCE,
});
const windows = [
  { name: "spinner visible", ...shift(1.0, 3.0) },
  { name: "result panel present", ...shift(3.0, 4.5) },
  { name: "toast visible", ...shift(5.0, 6.6) },
];
console.log("\ncoverage of the moments that matter:");
let missed = 0;
for (const w of windows) {
  const hit = sc.keyframes.some((k) => k.t >= w.lo && k.t <= w.hi);
  if (!hit) missed++;
  console.log(`  ${hit ? "HIT " : "MISS"}  ${w.name}`);
}
console.log(missed === 0 ? "\nAll critical moments captured." : `\n${missed} critical moment(s) missed.`);
process.exit(missed === 0 ? 0 : 1);
