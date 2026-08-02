import { SAMPLE_W, SAMPLE_H } from "../../src/analyze/frames.mjs";

/**
 * Synthetic frame builders.
 *
 * These deliberately mimic the real measurements that drove the analysis design: a
 * dark page with a small bright region is what a spinner or a toast actually looks
 * like at sample resolution, and it is the case naive whole-frame differencing
 * misses.
 */

export function blankFrame(value = 20) {
  return new Uint8Array(SAMPLE_W * SAMPLE_H).fill(value);
}

/** Paint an axis-aligned rectangle, in sample-pixel coordinates. */
export function withRect(base, { x, y, w, h, value = 240 }) {
  const out = Uint8Array.from(base);
  for (let yy = y; yy < y + h && yy < SAMPLE_H; yy++) {
    for (let xx = x; xx < x + w && xx < SAMPLE_W; xx++) {
      out[yy * SAMPLE_W + xx] = value;
    }
  }
  return out;
}

/** A page with structure, so variance is non-trivial and dHash is meaningful. */
export function texturedFrame(seed = 1) {
  const out = new Uint8Array(SAMPLE_W * SAMPLE_H);
  let s = seed;
  for (let i = 0; i < out.length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out[i] = 40 + ((s >> 16) % 120);
  }
  return out;
}

export function shiftBrightness(frame, delta) {
  const out = Uint8Array.from(frame);
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.max(0, Math.min(255, out[i] + delta));
  }
  return out;
}

/**
 * Build the `scored` array that selectKeyframes consumes, straight from a delta
 * profile. Lets a test describe a recording as "quiet, then a spike, then quiet"
 * without decoding any video.
 */
export function scoredFromDeltas(deltas, { sampleFps = 4, frames = null } = {}) {
  return deltas.map((delta, i) => ({
    index: i,
    t: i / sampleFps,
    delta,
    area: delta / 2,
    peak: delta,
    hash: new Uint8Array(64),
    pixels: frames ? frames[i] : texturedFrame(i + 1),
  }));
}
