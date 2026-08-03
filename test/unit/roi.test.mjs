import test from "node:test";
import assert from "node:assert/strict";

import {
  changeBox, changeMask, padBox, roiPixels, framingHint, ROI_DEFAULTS,
  autoRoi, normalizeRoi, cropFilter, describeRoi, roiCaptionTag, cropPixelsToSample,
} from "../../src/analyze/roi.mjs";
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

test("normalizeRoi passes 'auto' through and validates an explicit rect", () => {
  assert.equal(normalizeRoi("auto"), "auto");
  assert.equal(normalizeRoi(null), null);
  assert.deepEqual(normalizeRoi({ x: 0.25, y: 0.5, w: 0.25, h: 0.25 }), {
    x: 0.25, y: 0.5, w: 0.25, h: 0.25,
  });
});

test("normalizeRoi clamps a rect that runs past the edge rather than failing the run", () => {
  const rect = normalizeRoi({ x: 0.9, y: 0.9, w: 0.5, h: 0.5 });
  assert.ok(rect.x + rect.w <= 1.0001);
  assert.ok(rect.y + rect.h <= 1.0001);
});

test("normalizeRoi rejects nonsense with a message that says what to pass", () => {
  assert.throws(() => normalizeRoi({ x: 0, y: 0, w: 1 }), /roi\.h must be a number/);
  assert.throws(() => normalizeRoi({ x: 2, y: 0, w: 1, h: 1 }), /fraction of the frame/);
  assert.throws(() => normalizeRoi({ x: 0, y: 0, w: 0, h: 1 }), /greater than 0/);
  assert.throws(() => normalizeRoi("middle"), /must be "auto" or an object/);
});

test("cropFilter produces an in-range, even-dimensioned ffmpeg crop", () => {
  const f = cropFilter({ x: 0.25, y: 0.5, w: 0.25, h: 0.25 }, { width: 1441, height: 901 });
  const [, w, h, x, y] = f.match(/^crop=(\d+):(\d+):(\d+):(\d+)$/).map(Number);

  assert.equal(w % 2, 0, "even width, for the yuv420p re-encode paths");
  assert.equal(h % 2, 0);
  assert.ok(x + w <= 1441, "an out-of-range crop is a hard ffmpeg error, not a warning");
  assert.ok(y + h <= 901);
});

test("cropFilter clamps a rect pushed hard against the right edge", () => {
  const f = cropFilter({ x: 0.9, y: 0.9, w: 0.3, h: 0.3 }, { width: 1440, height: 900 });
  const [, w, h, x, y] = f.match(/^crop=(\d+):(\d+):(\d+):(\d+)$/).map(Number);
  assert.ok(x + w <= 1440);
  assert.ok(y + h <= 900);
});

test("cropFilter returns null when the frame size is unknown, so the caller must refuse", () => {
  assert.equal(cropFilter({ x: 0, y: 0, w: 1, h: 1 }, { width: null, height: null }), null);
  assert.equal(cropFilter(null, { width: 100, height: 100 }), null);
});

test("autoRoi crops to a small changing region and explains why", () => {
  const base = blankFrame(30);
  const lit = withRect(base, { x: 40, y: 60, w: 8, h: 10, value: 240 });
  const auto = autoRoi(scoredFrom(alternating(base, lit, 10)), { info: INFO });

  assert.equal(auto.applied, true);
  assert.ok(auto.rect.w < 0.5, "the region, not the page");
  assert.match(auto.reason, /% of the frame/);
});

test("autoRoi declines when the change is scattered across the page", () => {
  // Little actually changes, but it changes in opposite corners — so the bounding box
  // spans nearly the whole frame and cropping to it would buy no resolution at all.
  const base = blankFrame(30);
  const corners = withRect(withRect(base, { x: 4, y: 4, w: 8, h: 8, value: 240 }), {
    x: 112, y: 112, w: 8, h: 8, value: 240,
  });
  const auto = autoRoi(scoredFrom(alternating(base, corners, 10)), { info: INFO });

  assert.equal(auto.applied, false);
  assert.equal(auto.rect, null);
  assert.match(auto.reason, /without gaining resolution/);
});

test("autoRoi declines when every frame repaints wholesale", () => {
  const base = blankFrame(30);
  const lit = withRect(base, { x: 4, y: 4, w: 118, h: 118, value: 240 });
  const auto = autoRoi(scoredFrom(alternating(base, lit, 10)), { info: INFO });

  assert.equal(auto.applied, false, "a full repaint says nothing about where to crop");
  assert.match(auto.reason, /nothing changed enough/);
});

test("autoRoi declines when nothing changed at all", () => {
  const base = texturedFrame(9);
  const auto = autoRoi(scoredFrom([base, base, base, base]), { info: INFO });
  assert.equal(auto.applied, false);
  assert.match(auto.reason, /nothing changed/);
});

test("describeRoi says what is visible and that the rest is not", () => {
  const text = describeRoi({ x: 0.25, y: 0.5, w: 0.25, h: 0.25 }, INFO);
  assert.match(text, /CROPPED VIEW/);
  assert.match(text, /360x225 px region at \(360,450\)/);
  assert.match(text, /NOT visible/, "the sentence that stops a crop being read as the page");
  assert.match(text, /absence is not evidence/);
});

test("roiCaptionTag is short enough to prefix every caption", () => {
  const tag = roiCaptionTag({ x: 0.25, y: 0.5, w: 0.25, h: 0.25 }, INFO);
  assert.ok(tag.length < 32, tag);
  assert.match(tag, /^\[CROP /);
});

test("cropPixelsToSample returns a full-size buffer, so downstream defaults still hold", () => {
  const base = blankFrame(30);
  const lit = withRect(base, { x: 40, y: 60, w: 8, h: 10, value: 240 });
  const out = cropPixelsToSample(lit, { x: 0.3, y: 0.45, w: 0.1, h: 0.1 });

  assert.equal(out.length, SAMPLE_W * SAMPLE_H, "a natural-sized sub-rect would read past the end");
});

test("cropping amplifies a small change, which is the point of doing it", () => {
  const base = blankFrame(30);
  const lit = withRect(base, { x: 40, y: 60, w: 8, h: 10, value: 240 });
  const rect = { x: 0.28, y: 0.43, w: 0.14, h: 0.14 };

  const changedWhole = countDiff(base, lit) / (SAMPLE_W * SAMPLE_H);
  const changedCrop =
    countDiff(cropPixelsToSample(base, rect), cropPixelsToSample(lit, rect)) / (SAMPLE_W * SAMPLE_H);

  assert.ok(changedCrop > changedWhole * 5, `${changedCrop} should dwarf ${changedWhole}`);
});

function countDiff(a, b) {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 12) n++;
  return n;
}
