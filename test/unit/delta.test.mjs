import test from "node:test";
import assert from "node:assert/strict";

import {
  resizeGray, dHash, hamming, mad, changedFraction, peakBlockDiff,
  scoreFrames, brightness, variance,
} from "../../src/analyze/delta.mjs";
import { SAMPLE_W, SAMPLE_H } from "../../src/analyze/frames.mjs";
import { blankFrame, withRect, texturedFrame, shiftBrightness } from "./helpers.mjs";

test("resizeGray box-averages down to the requested size", () => {
  const src = new Uint8Array(4 * 4).fill(100);
  src[0] = 200;
  const out = resizeGray(src, 4, 4, 2, 2);
  assert.equal(out.length, 4);
  // Top-left 2x2 block averages 200,100,100,100 -> 125.
  assert.equal(out[0], 125);
  assert.equal(out[3], 100);
});

test("mad is zero for identical frames and grows with difference", () => {
  const a = texturedFrame(1);
  assert.equal(mad(a, a), 0);
  const b = shiftBrightness(a, 40);
  assert.ok(mad(a, b) > 0.1, "a 40-level shift should register");
});

test("changedFraction counts only pixels past the threshold", () => {
  const base = blankFrame(20);
  const nudged = shiftBrightness(base, 5); // below the default threshold of 12
  assert.equal(changedFraction(base, nudged), 0);

  const half = withRect(base, { x: 0, y: 0, w: SAMPLE_W, h: SAMPLE_H / 2 });
  assert.ok(Math.abs(changedFraction(base, half) - 0.5) < 0.01);
});

/**
 * The measurement that forced 128x128 sampling and per-block scoring: at
 * 64x64 a spinner-sized region moved the whole-frame average by 0.0003, which is
 * indistinguishable from noise.
 */
test("a small bright region barely moves mad but strongly moves peakBlockDiff", () => {
  const page = blankFrame(20);
  // ~6x8 sample pixels is roughly a 64px spinner inside a 3000px-wide window.
  const withSpinner = withRect(page, { x: 60, y: 60, w: 6, h: 8, value: 240 });

  const globalDiff = mad(page, withSpinner);
  const localDiff = peakBlockDiff(page, withSpinner);

  assert.ok(globalDiff < 0.01, `whole-frame mad should stay tiny, got ${globalDiff}`);
  assert.ok(localDiff > 0.05, `peak block should register clearly, got ${localDiff}`);
  assert.ok(
    localDiff > globalDiff * 10,
    "the local measure is what makes a spinner visible at all"
  );
});

test("peakBlockDiff is zero for identical frames", () => {
  const a = texturedFrame(7);
  assert.equal(peakBlockDiff(a, a), 0);
});

test("dHash ignores a uniform brightness shift", () => {
  const a = texturedFrame(3);
  const brighter = shiftBrightness(a, 30);
  assert.equal(
    hamming(dHash(a), dHash(brighter)),
    0,
    "a page dimming behind a modal must not read as 'everything changed'"
  );
});

test("dHash differs for structurally different frames", () => {
  const a = texturedFrame(3);
  const b = texturedFrame(99);
  assert.ok(hamming(dHash(a), dHash(b)) > 8);
});

test("brightness and variance identify a flat frame", () => {
  const black = blankFrame(0);
  assert.equal(brightness(black), 0);
  assert.equal(variance(black), 0);

  const textured = texturedFrame(5);
  assert.ok(variance(textured) > 0.05, "a real page has spatial variance");
});

test("scoreFrames takes the larger of the global and local scores", () => {
  const page = blankFrame(20);
  const toast = withRect(page, { x: 90, y: 8, w: 12, h: 6, value: 250 });

  const scored = scoreFrames([
    { index: 0, t: 0, pixels: page },
    { index: 1, t: 0.25, pixels: toast },
    { index: 2, t: 0.5, pixels: toast },
  ]);

  assert.equal(scored[0].delta, 0, "the first frame has no predecessor");
  assert.ok(scored[1].delta > 0.05, `toast appearing must score, got ${scored[1].delta}`);
  assert.equal(scored[2].delta, 0, "an unchanged frame scores zero");
  assert.ok(scored[1].peak >= scored[1].area, "peak is tracked separately from area");
});

test("scoreFrames attaches a hash and pixels to every row", () => {
  const scored = scoreFrames([{ index: 0, t: 0, pixels: texturedFrame(2) }]);
  assert.equal(scored[0].hash.length, 64);
  assert.equal(scored[0].pixels.length, SAMPLE_W * SAMPLE_H);
});
