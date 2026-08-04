import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSegments, formatSegments, segmentNotes, STATIC_PEAK_DELTA,
} from "../../src/analyze/segments.mjs";
import { findTransitions } from "../../src/analyze/select.mjs";
import { scoredFromDeltas } from "./helpers.mjs";

const VERDICT = /\b(PASS|FAIL|PASSED|FAILED)\b|✅|❌/;

function marksAt(...pairs) {
  return pairs.map(([t, note]) => ({ t, type: "mark", note }));
}

test("three marks produce four contiguous segments covering the whole recording", () => {
  const scored = scoredFromDeltas(Array.from({ length: 40 }, () => 0.1));
  const segments = buildSegments(scored, marksAt([2, "a"], [4, "b"], [6, "c"]));

  assert.equal(segments.length, 4);
  assert.equal(segments[0].fromT, 0);
  assert.equal(segments[3].toT, scored[scored.length - 1].t);
  for (let i = 1; i < segments.length; i++) {
    assert.equal(segments[i].fromT, segments[i - 1].toT, "segments are contiguous, never overlapping");
  }
});

test("no marks gives exactly one segment spanning the recording", () => {
  const scored = scoredFromDeltas(Array.from({ length: 12 }, () => 0.1));
  const segments = buildSegments(scored, []);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].openedBy, "start of recording");
  assert.equal(segments[0].closedBy, "end of recording");
});

// The three cases from the field report: a 12s pan where the camera never moved
// (peak 0.01), 10s aimed at an object never in frame (peak 0.02), and a working
// sun-position sweep (peak 0.41). The settled threshold of 0.012 gets the middle one
// wrong; the transition threshold gets all three right.
test("the reported peaks are classified correctly", () => {
  const cases = [
    { peak: 0.01, expected: true },
    { peak: 0.02, expected: true },
    { peak: 0.41, expected: false },
  ];
  for (const { peak, expected } of cases) {
    const scored = scoredFromDeltas([0, ...Array.from({ length: 20 }, () => peak)]);
    const [seg] = buildSegments(scored, []);
    assert.equal(seg.static, expected, `peak ${peak} should be static=${expected}`);
    assert.equal(seg.peakDelta, peak);
  }
});

test("static means exactly what findTransitions would say about the same frames", () => {
  const profiles = [
    Array.from({ length: 20 }, () => 0.005),
    Array.from({ length: 20 }, () => 0.02),
    Array.from({ length: 20 }, (_, i) => (i === 9 ? 0.4 : 0.005)),
    Array.from({ length: 20 }, (_, i) => (i % 4 === 0 ? 0.06 : 0.001)),
  ];
  for (const deltas of profiles) {
    const scored = scoredFromDeltas([0, ...deltas]);
    const [seg] = buildSegments(scored, []);
    const transitions = findTransitions(scored.slice(1));
    assert.equal(
      seg.static,
      transitions.length === 0,
      `static should agree with findTransitions for ${JSON.stringify(deltas.slice(0, 4))}…`
    );
  }
});

test("the opening segment's mean excludes the first frame, whose delta is 0 by construction", () => {
  const scored = scoredFromDeltas([0, 0.2, 0.4]);
  const [seg] = buildSegments(scored, []);
  assert.equal(seg.samples, 2, "the unscoreable first frame is not counted");
  assert.equal(seg.meanDelta, 0.3, "mean of 0.2 and 0.4, not of 0, 0.2 and 0.4");
});

test("a mark past the last sample does not produce a phantom segment", () => {
  const scored = scoredFromDeltas(Array.from({ length: 8 }, () => 0.1));
  const segments = buildSegments(scored, marksAt([999, "way past the end"]));
  assert.equal(segments.length, 1);
});

test("two marks inside one sample period do not produce a zero-width segment", () => {
  const scored = scoredFromDeltas(Array.from({ length: 20 }, () => 0.1));
  const segments = buildSegments(scored, marksAt([1.0, "first"], [1.0, "second"]));
  assert.equal(segments.length, 2);
  assert.ok(segments.every((s) => s.durationSec > 0));
});

test("a segment records the marks that opened and closed it", () => {
  const scored = scoredFromDeltas(Array.from({ length: 40 }, () => 0.1));
  const segments = buildSegments(scored, marksAt([2, "clicked Generate"]));
  assert.equal(segments[0].closedBy, "clicked Generate");
  assert.equal(segments[1].openedBy, "clicked Generate");
  assert.equal(segments[1].closedBy, "end of recording");
});

test("segmentNotes reports a static marked segment but never a static first one", () => {
  const scored = scoredFromDeltas([0, ...Array.from({ length: 40 }, () => 0.001)]);
  const segments = buildSegments(scored, marksAt([4, "clicked Generate"]));
  const notes = segmentNotes(segments);

  assert.equal(notes.length, 1, "only the marked segment is worth a note");
  assert.match(notes[0], /Segment 2/);
  assert.match(notes[0], /clicked Generate/);
  assert.match(notes[0], /static/);
  assert.doesNotMatch(notes[0], VERDICT, "evidence, never a verdict");
});

test("segmentNotes says nothing when the marked segment moved", () => {
  const scored = scoredFromDeltas([0, ...Array.from({ length: 40 }, () => 0.3)]);
  const segments = buildSegments(scored, marksAt([4, "clicked Generate"]));
  assert.equal(segmentNotes(segments).length, 0);
});

test("formatSegments prints the span, the peak and the STATIC flag", () => {
  const scored = scoredFromDeltas([0, ...Array.from({ length: 40 }, () => 0.001)]);
  const segments = buildSegments(scored, marksAt([4, "clicked Generate"]));
  const text = formatSegments(segments);

  assert.match(text, /SEGMENTS/);
  assert.match(text, /STATIC/);
  assert.match(text, /clicked Generate/);
  assert.doesNotMatch(text, VERDICT);
});

test("formatSegments stays silent when there is only one segment to describe", () => {
  const scored = scoredFromDeltas(Array.from({ length: 8 }, () => 0.1));
  assert.equal(formatSegments(buildSegments(scored, [])), null);
});

test("the static threshold is the transition threshold, not a separate constant", () => {
  assert.equal(STATIC_PEAK_DELTA, 0.035);
});
