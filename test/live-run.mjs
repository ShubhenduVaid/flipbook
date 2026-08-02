/**
 * Record for a fixed window while something else drives the browser, then analyse.
 *
 *   node test/live-run.mjs [--seconds 40] [--out result.json]
 *
 * Used to verify non-interference: while this is recording, every
 * mcp__claude-in-chrome__* tool must continue to work normally, and the resulting
 * recording must show what those tools actually did.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startRecording, stopRecording } from "../src/capture/record.mjs";
import { analyzeVideo } from "../src/analyze/analyze.mjs";
import { createSession, setActiveSession, readEvents, videoPath, framesDir, updateMeta, appendEvent } from "../src/capture/session.mjs";
import { alignEvents } from "../src/analyze/timeline.mjs";
import { probeDuration } from "../src/env/ffmpeg.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const secIdx = process.argv.indexOf("--seconds");
const seconds = secIdx > -1 ? Number(process.argv[secIdx + 1]) : 40;
const outIdx = process.argv.indexOf("--out");
const outFile = outIdx > -1 ? process.argv[outIdx + 1] : path.join(here, "..", ".fixture-out", "live-result.json");
const titleIdx = process.argv.indexOf("--title");
const titleContains = titleIdx > -1 ? process.argv[titleIdx + 1] : undefined;

const session = createSession({ label: "live claude-in-chrome run", target: "chrome", fps: 30 });
const video = videoPath(session.id);

const rec = await startRecording({
  id: session.id,
  outPath: video,
  target: "window",
  bundleId: "com.google.Chrome",
  titleContains,
  fps: 30,
  maxDurationSec: seconds + 10,
});
const startedAtMs = Date.now();
updateMeta(session.id, { startedAtMs, status: "recording" });
// Create the event log up front so the hook only ever has to append.
appendEvent(session.id, { tsMs: startedAtMs, type: "recording_started" });
// Publishing the pointer is what lets the PostToolUse hook find this session.
setActiveSession(session.id);

console.log(JSON.stringify({
  event: "recording",
  session: session.id,
  window: rec.window?.title,
  size: `${rec.window?.captureWidth}x${rec.window?.captureHeight}`,
  selection: rec.selection,
  stopsInSec: seconds,
}));

await new Promise((r) => setTimeout(r, seconds * 1000));

const stopped = await stopRecording(session.id);
setActiveSession(null);
const durationSec = await probeDuration(video);
updateMeta(session.id, { status: "recorded", durationSec, bytes: stopped.bytes });

const events = alignEvents(readEvents(session.id), startedAtMs, durationSec);
const analysis = await analyzeVideo({
  video,
  events,
  outDir: framesDir(session.id),
  label: "live claude-in-chrome run",
  returnMode: "paths",
  rubric: "The browser responded to each action.\nNo error state appeared.",
});

const sc = analysis.structuredContent;
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify({ session: session.id, video, events, ...sc }, null, 2));

console.log(JSON.stringify({
  event: "done",
  session: session.id,
  durationSec,
  mb: +(stopped.bytes / 1e6).toFixed(2),
  keyframes: sc.keyframes.map((k) => k.t),
  recordedActions: events.length,
  contactSheet: sc.contactSheet,
  notes: sc.notes,
  resultFile: outFile,
}));
