import test from "node:test";
import assert from "node:assert/strict";

import {
  contentBox, findGeometryJumps, findFlatOnset, geometryNote, flatOnsetNote, ANOMALY_DEFAULTS,
} from "../../src/analyze/anomaly.mjs";
import { SAMPLE_W, SAMPLE_H } from "../../src/analyze/frames.mjs";
import { blankFrame, texturedFrame } from "./helpers.mjs";

const VERDICT = /\b(PASS|FAIL|PASSED|FAILED)\b|✅|❌/;

/** Textured content inside a uniform surround — a page painted into part of the window. */
function contentIn(box, { surround = 20, seed = 7 } = {}) {
  const out = blankFrame(surround);
  const texture = texturedFrame(seed);
  for (let y = box.y; y < box.y + box.h && y < SAMPLE_H; y++) {
    for (let x = box.x; x < box.x + box.w && x < SAMPLE_W; x++) {
      out[y * SAMPLE_W + x] = texture[y * SAMPLE_W + x];
    }
  }
  return out;
}

const scoredFrom = (frames, sampleFps = 4) =>
  frames.map((pixels, i) => ({ index: i, t: i / sampleFps, delta: 0.1, pixels }));

const repeat = (frame, n) => Array.from({ length: n }, () => frame);

test("contentBox finds the painted region and how much of the frame is border", () => {
  const box = contentBox(contentIn({ x: 32, y: 32, w: 64, h: 64 }));

  assert.ok(Math.abs(box.x0 - 0.25) < 0.02, `x0 ${box.x0}`);
  assert.ok(Math.abs(box.x1 - 0.75) < 0.02, `x1 ${box.x1}`);
  assert.ok(Math.abs(box.boxFraction - 0.25) < 0.03, `boxFraction ${box.boxFraction}`);
  assert.ok(box.borderFraction > 0.7);
});

test("contentBox treats a full-bleed page as having no border", () => {
  const box = contentBox(texturedFrame(3));
  assert.ok(box.borderFraction < 0.05, `borderFraction ${box.borderFraction}`);
});

test("a viewport that shrinks into a corner and stays there is detected", () => {
  const frames = [...repeat(texturedFrame(1), 4), ...repeat(contentIn({ x: 0, y: 0, w: 40, h: 40 }), 6)];
  const jumps = findGeometryJumps(scoredFrom(frames));

  assert.equal(jumps.length, 1, "one incident, one finding");
  assert.equal(jumps[0].kind, "shrank");
  assert.equal(jumps[0].t, 1.0, "reported at the first shrunken sample");
  assert.ok(jumps[0].after.borderFraction > 0.6);
});

test("a full-page navigation is not a geometry change", () => {
  const frames = [...repeat(texturedFrame(1), 4), ...repeat(texturedFrame(99), 6)];
  assert.deepEqual(findGeometryJumps(scoredFrom(frames)), [], "content still reaches every edge");
});

test("a modal over a page that keeps painting is not a geometry change", () => {
  const base = texturedFrame(5);
  const withModal = Uint8Array.from(base);
  for (let y = 40; y < 88; y++) {
    for (let x = 40; x < 88; x++) withModal[y * SAMPLE_W + x] = 250;
  }
  const frames = [...repeat(base, 4), ...repeat(withModal, 6)];
  assert.deepEqual(findGeometryJumps(scoredFrom(frames)), []);
});

test("a one-sample flicker is not a geometry change", () => {
  const frames = [
    ...repeat(texturedFrame(1), 4),
    contentIn({ x: 0, y: 0, w: 40, h: 40 }),
    ...repeat(texturedFrame(1), 5),
  ];
  assert.deepEqual(findGeometryJumps(scoredFrom(frames)), [], "it has to persist to count");
});

test("permanently letterboxed content never triggers the onset rule", () => {
  const a = contentIn({ x: 30, y: 30, w: 60, h: 60 }, { seed: 1 });
  const b = contentIn({ x: 30, y: 30, w: 60, h: 60 }, { seed: 2 });
  const frames = [...repeat(a, 5), ...repeat(b, 5)];
  assert.deepEqual(findGeometryJumps(scoredFrom(frames)), [], "the border was always there");
});

test("a shrink that later reverts is one finding, not two", () => {
  const frames = [
    ...repeat(texturedFrame(1), 4),
    ...repeat(contentIn({ x: 0, y: 0, w: 40, h: 40 }), 5),
    ...repeat(texturedFrame(1), 5),
  ];
  const jumps = findGeometryJumps(scoredFrom(frames));
  assert.equal(jumps.length, 1);
  assert.ok(jumps[0].restoredAtT > jumps[0].t, "the restoration is recorded on the same incident");
});

test("a window that goes blank partway through is detected", () => {
  const frames = [...repeat(texturedFrame(1), 4), ...repeat(blankFrame(18), 8)];
  const onset = findFlatOnset(scoredFrom(frames), { sampleFps: 4 });

  assert.ok(onset, "the transition into flatness is the interesting event");
  assert.equal(onset.t, 1.0);
  assert.equal(onset.toEnd, true);
  assert.ok(onset.secondsFlat >= 1.5);
});

test("a recording that was blank throughout is left to the existing whole-recording note", () => {
  const frames = repeat(blankFrame(18), 12);
  assert.equal(findFlatOnset(scoredFrom(frames), { sampleFps: 4 }), null);
});

test("a brief white flash between live stretches is not a blank window", () => {
  const frames = [
    ...repeat(texturedFrame(1), 4),
    ...repeat(blankFrame(250), 2),
    ...repeat(texturedFrame(2), 5),
  ];
  assert.equal(findFlatOnset(scoredFrom(frames), { sampleFps: 4 }), null);
});

test("both notes name their timestamp, explain the cause, and state no verdict", () => {
  const frames = [...repeat(texturedFrame(1), 4), ...repeat(contentIn({ x: 0, y: 0, w: 40, h: 40 }), 6)];
  const scored = scoredFrom(frames);
  const geometry = geometryNote(findGeometryJumps(scored)[0]);
  const flat = flatOnsetNote(
    findFlatOnset(scoredFrom([...repeat(texturedFrame(1), 4), ...repeat(blankFrame(18), 8)]), {
      sampleFps: 4,
    })
  );

  for (const note of [geometry, flat]) {
    assert.match(note, /t=\d+\.\d+s/, "a timestamp to judge against");
    assert.doesNotMatch(note, VERDICT, "evidence, never a verdict");
  }
  assert.match(geometry, /device metrics/, "names the cause that produced a misdiagnosis");
  assert.match(geometry, /fullscreen player|deliberately resized/, "and admits the benign case");
  assert.match(flat, /stopped painting/);
});

// Caught by running the real pipeline over a synthetic recording: a wholly uniform
// frame has no content box, and its all-zero sentinel read as an enormous edge shift
// the moment anything at all appeared — so every blink of a small badge on a plain
// background was reported as a capture fault.
test("content appearing on a wholly uniform frame is not a geometry change", () => {
  const blank = blankFrame(32);
  const badge = contentIn({ x: 54, y: 43, w: 9, h: 6 }, { surround: 32 });
  const frames = [...repeat(blank, 4), ...repeat(badge, 6)];

  assert.deepEqual(findGeometryJumps(scoredFrom(frames)), [], "there was no geometry to change");
});

test("contentBox flags a featureless frame rather than reporting a zero-size box", () => {
  assert.equal(contentBox(blankFrame(32)).empty, true);
  assert.equal(contentBox(texturedFrame(2)).empty, false);
});

test("the onset rule needs a real transition, not just a high border fraction", () => {
  // The gate that keeps a permanently dark or letterboxed layout silent: the border has
  // to have been absent beforehand, not merely present afterwards.
  assert.ok(
    ANOMALY_DEFAULTS.borderOnsetBefore < ANOMALY_DEFAULTS.borderOnsetAfter,
    "otherwise every dark-themed page reports a capture fault"
  );
  assert.ok(ANOMALY_DEFAULTS.persistAfter > 1, "a single frame is a flicker, not a change");
  assert.ok(
    ANOMALY_DEFAULTS.flatVariance <= ANOMALY_DEFAULTS.liveVariance,
    "the flat and live bands must not overlap"
  );
});
