import test from "node:test";
import assert from "node:assert/strict";

import {
  alignEvents, buildTimeline, formatTimeline, describeEvent,
} from "../../src/analyze/timeline.mjs";
import { scoredFromDeltas } from "./helpers.mjs";

test("alignEvents converts wall-clock stamps to recording-relative seconds", () => {
  const start = 1_000_000;
  const aligned = alignEvents(
    [
      { tsMs: start, type: "recording_started" },
      { tsMs: start + 2500, type: "mark", note: "clicked submit" },
    ],
    start,
    10
  );
  assert.equal(aligned[0].t, 0);
  assert.equal(aligned[1].t, 2.5);
});

test("alignEvents drops events outside the recording window", () => {
  const start = 1_000_000;
  const aligned = alignEvents(
    [
      { tsMs: start - 5000, type: "mark", note: "long before" },
      { tsMs: start + 1000, type: "mark", note: "inside" },
      { tsMs: start + 60_000, type: "mark", note: "long after" },
    ],
    start,
    10
  );
  assert.equal(aligned.length, 1);
  assert.equal(aligned[0].note, "inside");
});

test("alignEvents ignores entries with no timestamp", () => {
  assert.equal(alignEvents([{ type: "mark", note: "no stamp" }], 0, 10).length, 0);
});

test("describeEvent renders a browser action compactly", () => {
  const text = describeEvent({
    type: "tool",
    tool: "mcp__claude-in-chrome__computer",
    input: { action: "left_click", coordinate: [640, 410], text: "Submit" },
  });
  assert.match(text, /^action: computer/, "the long MCP prefix is stripped");
  assert.match(text, /left_click/);
  assert.match(text, /640,410/);
});

test("describeEvent renders marks and console lines", () => {
  assert.equal(describeEvent({ type: "mark", note: "expect a toast" }), "note: expect a toast");
  assert.match(
    describeEvent({ type: "console", level: "error", text: "TypeError: x" }),
    /console error: TypeError/
  );
});

test("buildTimeline collapses quiet stretches into a single row", () => {
  const deltas = [0.3, 0.001, 0.001, 0.001, 0.001, 0.001, 0.001, 0.3];
  const rows = buildTimeline({ scored: scoredFromDeltas(deltas), events: [], keyframes: [] });

  const quiet = rows.filter((r) => r.kind === "quiet");
  assert.equal(quiet.length, 1, "one collapsed row, not six near-identical samples");
  assert.equal(quiet[0].samples, 6);
});

test("buildTimeline interleaves events in time order", () => {
  const scored = scoredFromDeltas([0.3, 0.001, 0.3, 0.001]);
  const rows = buildTimeline({
    scored,
    events: [{ t: 0.4, type: "mark", note: "midway" }],
    keyframes: [],
  });
  const times = rows.map((r) => r.t);
  assert.deepEqual([...times].sort((a, b) => a - b), times, "rows are ordered by time");
  assert.ok(rows.some((r) => r.kind === "event"));
});

test("buildTimeline marks rows that correspond to shown keyframes", () => {
  const scored = scoredFromDeltas([0.3, 0.001, 0.3]);
  const rows = buildTimeline({
    scored,
    events: [],
    keyframes: [{ index: 0 }, { index: 2 }],
  });
  const numbered = rows.filter((r) => r.frame);
  assert.equal(numbered.length, 2);
  assert.deepEqual(numbered.map((r) => r.frame), [1, 2], "frames are numbered F01, F02");
});

test("under row pressure, events and keyframes survive and plain samples are dropped", () => {
  const deltas = Array.from({ length: 400 }, () => 0.2);
  const scored = scoredFromDeltas(deltas);
  const events = [
    { t: 1, type: "mark", note: "one" },
    { t: 2, type: "mark", note: "two" },
  ];
  const rows = buildTimeline({ scored, events, keyframes: [{ index: 5 }], maxRows: 50 });

  assert.ok(rows.length <= 50 + events.length, "row cap is respected");
  assert.equal(rows.filter((r) => r.kind === "event").length, 2, "no event is dropped");
  assert.ok(rows.some((r) => r.frame === 1), "the keyframe row survives");
});

test("formatTimeline produces a readable, labelled block", () => {
  const scored = scoredFromDeltas([0.3, 0.001, 0.001, 0.001]);
  const rows = buildTimeline({
    scored,
    events: [{ t: 0.25, type: "mark", note: "clicked" }],
    keyframes: [{ index: 0 }],
  });
  const text = formatTimeline(rows, { sampleFps: 4 });

  assert.match(text, /TIMELINE/);
  assert.match(text, /F01/);
  assert.match(text, /note: clicked/);
  assert.match(text, /no visual change for/);
});
