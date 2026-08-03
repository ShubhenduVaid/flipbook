import test from "node:test";
import assert from "node:assert/strict";

import { changeBox, changeMask, padBox, roiPixels, framingHint, ROI_DEFAULTS } from "../../src/analyze/roi.mjs";
import { SAMPLE_W, SAMPLE_H } from "../../src/analyze/frames.mjs";
import { blankFrame, withRect, texturedFrame, shiftBrightness } from "./helpers.mjs";

const VERDICT = /\b(PASS|FAIL|PASSED|FAILED)\b|✅|❌/;
const INFO = { width: 1440, height: 900 };

/** Score rows carry `area` (changedFraction) alongside the pixels; framingHint reads both. */
function scoredFrom(frames, area = 0.004) {
  return frames.map((pixels, i) => ({ index: i, t: i / 4, delta: 0.05, area: i ? area : 0, pixels }));
}

const alternating = (a, b, n) => Array.from({ length: n }, (_, i) => (i % 2 ? b : a));

test("changeMask ignores pairs where most of the frame repainted", () => {
  const scored = scoredFrom([texturedFrame(1), texturedFrame(2), texturedFrame(3)]);
  const { pairs } = changeMask(scored, ROI_DEFAULTS);
  assert.equal(pairs, 0, "a full repaint has nothing to say about where to crop");
});

test("changeBox brackets a small region that repeatedly changes", () => {
  const base = blankFrame(30);
  const lit = withRect(base, { x: 40, y: 60, w: 8, h: 10, value: 240 });
  const box = changeBox(scoredFrom(alternating(base, lit, 8)), ROI_DEFAULTS);

  assert.equal(box.found, true);
  assert.ok(Math.abs(box.x - 40 / SAMPLE_W) < 0.01, `x ${box.x}`);
  assert.ok(Math.abs(box.y - 60 / SAMPLE_H) < 0.01, `y ${box.y}`);
  assert.ok(Math.abs(box.w - 8 / SAMPLE_W) < 0.02, `w ${box.w}`);
  assert.ok(box.rawAreaFraction < 0.01, `rawAreaFraction ${box.rawAreaFraction}`);
});

test("changeBox reports nothing when only noise moved", () => {
  const base = texturedFrame(4);
  const jittered = shiftBrightness(base, 3); // below pixelThreshold of 12
  const box = changeBox(scoredFrom(alternating(base, jittered, 8)), ROI_DEFAULTS);
  assert.equal(box.found, false);
});

test("padBox grows a sliver to a usable minimum and stays inside the frame", () => {
  const rect = padBox({ x: 0.31, y: 0.46, w: 0.02, h: 0.02 }, INFO, ROI_DEFAULTS);

  assert.ok(rect.w >= ROI_DEFAULTS.minSide, `w ${rect.w}`);
  assert.ok(rect.w * INFO.width >= ROI_DEFAULTS.minSourcePx - 1, "at least minSourcePx wide");
  assert.ok(rect.x >= 0 && rect.y >= 0);
  assert.ok(rect.x + rect.w <= 1.0001 && rect.y + rect.h <= 1.0001, "never runs off the frame");
});

test("padBox clamps a box hard against an edge without shrinking it", () => {
  const rect = padBox({ x: 0.95, y: 0.0, w: 0.05, h: 0.05 }, INFO, ROI_DEFAULTS);
  assert.ok(rect.x + rect.w <= 1.0001);
  assert.ok(rect.w >= ROI_DEFAULTS.minSide);
  assert.equal(rect.y, 0);
});

test("roiPixels converts a fractional rect into source pixels", () => {
  assert.deepEqual(roiPixels({ x: 0.25, y: 0.5, w: 0.25, h: 0.25 }, INFO), {
    x: 360, y: 450, w: 360, h: 225,
  });
  assert.equal(roiPixels({ x: 0, y: 0, w: 1, h: 1 }, { width: null, height: null }), null);
});

test("framingHint fires for a subject that occupies a sliver of the frame", () => {
  const base = blankFrame(30);
  const lit = withRect(base, { x: 40, y: 60, w: 6, h: 8, value: 240 });
  const hint = framingHint(scoredFrom(alternating(base, lit, 10)), { info: INFO });

  assert.ok(hint, "this is the recording that could not settle a question");
  assert.match(hint, /Only 0\.\d% of the frame ever changed/);
  assert.match(hint, /roi:\{/, "names the rect to paste back");
  assert.doesNotMatch(hint, VERDICT);
});

test("the rect the hint quotes is a valid, in-frame rect", () => {
  const base = blankFrame(30);
  const lit = withRect(base, { x: 40, y: 60, w: 6, h: 8, value: 240 });
  const hint = framingHint(scoredFrom(alternating(base, lit, 10)), { info: INFO });

  const rect = JSON.parse(hint.match(/roi:(\{[^}]*\})/)[1]);
  for (const k of ["x", "y", "w", "h"]) assert.equal(typeof rect[k], "number");
  assert.ok(rect.x + rect.w <= 1.0001 && rect.y + rect.h <= 1.0001);
  assert.ok(rect.w > 0 && rect.h > 0);
});

test("framingHint stays quiet when a large part of the frame changes", () => {
  const base = blankFrame(30);
  const lit = withRect(base, { x: 10, y: 10, w: 70, h: 70, value: 240 });
  const hint = framingHint(scoredFrom(alternating(base, lit, 10), 0.3), { info: INFO });
  assert.equal(hint, null, "a 30% change is not a framing problem");
});

test("framingHint stays quiet when a frame pair moved a lot even if the box is small", () => {
  const base = blankFrame(30);
  const lit = withRect(base, { x: 40, y: 60, w: 6, h: 8, value: 240 });
  // A tiny bounding box but a large per-frame changed area is a subtle app, not bad framing.
  const hint = framingHint(scoredFrom(alternating(base, lit, 10), 0.4), { info: INFO });
  assert.equal(hint, null);
});

test("framingHint stays quiet on brightness jitter below the pixel threshold", () => {
  const base = texturedFrame(4);
  const hint = framingHint(scoredFrom(alternating(base, shiftBrightness(base, 3), 10)), { info: INFO });
  assert.equal(hint, null);
});

test("framingHint degrades to percentages when the frame size is unknown", () => {
  const base = blankFrame(30);
  const lit = withRect(base, { x: 40, y: 60, w: 6, h: 8, value: 240 });
  const hint = framingHint(scoredFrom(alternating(base, lit, 10)), {
    info: { width: null, height: null },
  });
  assert.ok(hint);
  assert.match(hint, /% x \d+% of the frame/);
});
