import test from "node:test";
import assert from "node:assert/strict";

import {
  alignEvents, buildTimeline, formatTimeline, fitTimeline, formatRow, describeEvent,
  rowPriority, ROW_TIERS,
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
  const { rows } = buildTimeline({ scored: scoredFromDeltas(deltas), events: [], keyframes: [] });

  const quiet = rows.filter((r) => r.kind === "quiet");
  assert.equal(quiet.length, 1, "one collapsed row, not six near-identical samples");
  assert.equal(quiet[0].samples, 6);
});

test("buildTimeline interleaves events in time order", () => {
  const scored = scoredFromDeltas([0.3, 0.001, 0.3, 0.001]);
  const { rows } = buildTimeline({
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
  const { rows } = buildTimeline({
    scored,
    events: [],
    keyframes: [{ index: 0 }, { index: 2 }],
  });
  const numbered = rows.filter((r) => r.frame);
  assert.equal(numbered.length, 2);
  assert.deepEqual(numbered.map((r) => r.frame), [1, 2], "frames are numbered F01, F02");
});

test("under row pressure, marks and keyframes survive and plain samples are dropped", () => {
  const deltas = Array.from({ length: 400 }, () => 0.2);
  const scored = scoredFromDeltas(deltas);
  const events = [
    { t: 1, type: "mark", note: "one" },
    { t: 2, type: "mark", note: "two" },
  ];
  const { rows, dropped } = buildTimeline({ scored, events, keyframes: [{ index: 5 }], maxRows: 50 });

  // The old implementation built its keep-set from the priority rows unconditionally
  // and could return more rows than the cap it advertised.
  assert.ok(rows.length <= 50, "the row cap is a cap, not a suggestion");
  assert.equal(rows.filter((r) => r.kind === "event").length, 2, "no mark is dropped");
  assert.ok(rows.some((r) => r.frame === 1), "the keyframe row survives");
  assert.equal(dropped.total, dropped.quiet + dropped.samples + dropped.keyframes + dropped.tools);
});

test("buildTimeline keeps every mark even when marks alone exceed the row cap", () => {
  const scored = scoredFromDeltas(Array.from({ length: 200 }, () => 0.2));
  const events = Array.from({ length: 40 }, (_, i) => ({
    t: i * 0.1,
    type: "mark",
    note: `mark ${i}`,
  }));
  const { rows } = buildTimeline({ scored, events, keyframes: [], maxRows: 20 });
  assert.equal(rows.filter((r) => r.kind === "event").length, 40, "pinned rows are never given up");
});

test("rowPriority pins marks and segments, and ranks tool calls below them", () => {
  assert.equal(rowPriority({ kind: "event", event: { type: "mark" } }), ROW_TIERS.pinned);
  assert.equal(rowPriority({ kind: "segment" }), ROW_TIERS.pinned);
  assert.equal(rowPriority({ kind: "event", event: { type: "tool" } }), ROW_TIERS.tool);
  assert.equal(rowPriority({ kind: "sample", frame: 3 }), ROW_TIERS.keyframe);
  assert.equal(rowPriority({ kind: "sample" }), ROW_TIERS.sample);
  assert.equal(rowPriority({ kind: "quiet" }), ROW_TIERS.quiet);
  assert.equal(rowPriority({ kind: "quiet" }, { first: true }), ROW_TIERS.pinned);
});

test("formatTimeline produces a readable, labelled block", () => {
  const scored = scoredFromDeltas([0.3, 0.001, 0.001, 0.001]);
  const { rows } = buildTimeline({
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

test("formatRow renders a segment divider with its peak change", () => {
  const line = formatRow(
    { kind: "segment", t: 3.2, segment: 2, peakDelta: 0.41, isStatic: false, label: "clicked Generate" },
    { sampleFps: 4 }
  );
  assert.match(line, /segment 2/);
  assert.match(line, /peak d=0\.410/);
  assert.match(line, /clicked Generate/);
});

// The reported defect: a mark placed at the very end of a long run vanished from the
// result while every tool call before it survived, because the timeline was fitted by
// slicing the formatted text and rows are in time order.
test("fitTimeline keeps a mark at the very end of a long recording", () => {
  const scored = scoredFromDeltas(Array.from({ length: 800 }, (_, i) => (i % 3 ? 0.001 : 0.05)));
  const lastT = scored[scored.length - 1].t;
  const { rows, dropped } = buildTimeline({
    scored,
    events: [
      { t: 0.5, type: "tool", tool: "mcp__claude-in-chrome__computer", input: { action: "click" } },
      { t: lastT, type: "mark", note: "R8: pan across town" },
    ],
    keyframes: [],
  });

  const fitted = fitTimeline(rows, { sampleFps: 4, maxChars: 600, alreadyDropped: dropped });
  assert.ok(fitted.text.length <= 600, "the block fits its allowance");
  assert.match(fitted.text, /R8: pan across town/, "the last mark survives the fit");
  assert.equal(fitted.truncated, true);
  assert.ok(fitted.rowsShown < fitted.rowsTotal);
});

test("fitTimeline keeps every one of many scattered marks under a brutal budget", () => {
  const scored = scoredFromDeltas(Array.from({ length: 800 }, () => 0.05));
  const events = Array.from({ length: 12 }, (_, i) => ({
    t: i * 16,
    type: "mark",
    note: `checkpoint ${i}`,
  }));
  const { rows, dropped } = buildTimeline({ scored, events, keyframes: [] });
  const fitted = fitTimeline(rows, { sampleFps: 4, maxChars: 900, alreadyDropped: dropped });

  for (let i = 0; i < 12; i++) {
    assert.match(fitted.text, new RegExp(`checkpoint ${i}\\b`), `mark ${i} survives`);
  }
  assert.equal(
    fitted.dropped.total,
    fitted.rowsTotal - fitted.rowsShown,
    "the footer's arithmetic is honest"
  );
});

test("fitTimeline gives up plain samples before quiet stretches and actions", () => {
  const rows = [
    { kind: "sample", t: 0, delta: 0.5, frame: 1 },
    ...Array.from({ length: 40 }, (_, i) => ({ kind: "sample", t: 1 + i * 0.25, delta: 0.021 })),
    { kind: "quiet", t: 11, samples: 24 },
    { kind: "event", t: 12, text: "action: computer left_click", event: { type: "tool" } },
    { kind: "sample", t: 13, delta: 0.5, frame: 2 },
  ];
  const fitted = fitTimeline(rows, { sampleFps: 4, maxChars: 420 });

  assert.match(fitted.text, /left_click/, "the action outlives the samples");
  assert.match(fitted.text, /no visual change for/, "so does the quiet stretch");
  assert.ok(fitted.dropped.samples > 0);
  assert.equal(fitted.dropped.tools, 0);
});

test("fitTimeline drops repeated actions before distinct ones", () => {
  const repeat = (t) => ({ kind: "event", t, text: "action: computer screenshot", event: { type: "tool" } });
  const rows = [
    { kind: "sample", t: 0, delta: 0.5 },
    repeat(1), repeat(2), repeat(3), repeat(4),
    { kind: "event", t: 5, text: "action: navigate /checkout", event: { type: "tool" } },
    { kind: "sample", t: 6, delta: 0.5 },
  ];
  // Tight enough that four of the six action rows must go, loose enough that one can stay.
  const fitted = fitTimeline(rows, { sampleFps: 4, maxChars: 360 });
  assert.match(fitted.text, /navigate \/checkout/, "the one distinct action survives");
  assert.ok(fitted.dropped.tools >= 1, "and at least one repeat was given up for it");
});

test("fitTimeline returns the whole block untouched when it already fits", () => {
  const rows = [{ kind: "sample", t: 0, delta: 0.5 }, { kind: "sample", t: 1, delta: 0.2 }];
  const fitted = fitTimeline(rows, { sampleFps: 4, maxChars: 10_000 });
  assert.equal(fitted.truncated, false);
  assert.equal(fitted.dropped.total, 0);
  assert.equal(fitted.rowsShown, 2);
});

test("describeEvent caps a runaway mark note so one note cannot starve the timeline", () => {
  const text = describeEvent({ type: "mark", note: "x".repeat(5000) });
  assert.ok(text.length <= 170, `expected a capped note, got ${text.length} chars`);
  assert.match(text, /…$/);
});
