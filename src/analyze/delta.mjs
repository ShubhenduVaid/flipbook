import { SAMPLE_W, SAMPLE_H } from "./frames.mjs";

/** Box-average resize for 8-bit greyscale. Used to build perceptual hashes. */
export function resizeGray(src, sw, sh, dw, dh) {
  const out = new Uint8Array(dw * dh);
  const xr = sw / dw;
  const yr = sh / dh;
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor(y * yr);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * yr));
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor(x * xr);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * xr));
      let sum = 0;
      let n = 0;
      for (let yy = y0; yy < y1 && yy < sh; yy++) {
        for (let xx = x0; xx < x1 && xx < sw; xx++) {
          sum += src[yy * sw + xx];
          n++;
        }
      }
      out[y * dw + x] = n ? Math.round(sum / n) : 0;
    }
  }
  return out;
}

/**
 * dHash: compare each pixel with its right-hand neighbour on a 9x8 grid, giving 64
 * bits. Insensitive to uniform brightness and gamma shifts, which matters because a
 * page dimming behind a modal should not read as "everything changed".
 */
export function dHash(pixels, w = SAMPLE_W, h = SAMPLE_H) {
  const g = resizeGray(pixels, w, h, 9, 8);
  const bits = new Uint8Array(64);
  let k = 0;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      bits[k++] = g[y * 9 + x] < g[y * 9 + x + 1] ? 1 : 0;
    }
  }
  return bits;
}

export function hamming(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

/** Mean absolute difference, normalised to 0..1. */
export function mad(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length / 255;
}

/** Fraction of pixels that changed appreciably — catches small but real UI changes. */
export function changedFraction(a, b, threshold = 12) {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > threshold) n++;
  return n / a.length;
}

/**
 * Largest per-block mean difference, over an 8x8 grid of blocks.
 *
 * This is what makes localized changes visible. A toast appearing in the corner of a
 * large page moves the whole-frame average by almost nothing, but it saturates the
 * one block it occupies — so the peak block, not the average, is what catches it.
 */
export function peakBlockDiff(a, b, w = SAMPLE_W, h = SAMPLE_H, grid = 16) {
  const bw = Math.max(1, Math.floor(w / grid));
  const bh = Math.max(1, Math.floor(h / grid));
  let peak = 0;
  for (let by = 0; by < grid; by++) {
    for (let bx = 0; bx < grid; bx++) {
      let sum = 0;
      let n = 0;
      for (let y = by * bh; y < (by + 1) * bh && y < h; y++) {
        for (let x = bx * bw; x < (bx + 1) * bw && x < w; x++) {
          const i = y * w + x;
          sum += Math.abs(a[i] - b[i]);
          n++;
        }
      }
      if (n) peak = Math.max(peak, sum / n / 255);
    }
  }
  return peak;
}

/**
 * Score every sampled frame against the previous one.
 *
 * Two scores are computed and the larger wins, because they catch opposite things:
 * the global score sees navigation and layout shift, which move everything a little;
 * the local score sees a spinner, toast or modal, which move one region a lot. Using
 * either alone misses half of what a QA pass is looking for.
 */
export function scoreFrames(frames) {
  const scored = [];
  let prev = null;
  for (const f of frames) {
    const hash = dHash(f.pixels);
    let delta = 0;
    let area = 0;
    let peak = 0;
    if (prev) {
      const m = mad(prev.pixels, f.pixels);
      area = changedFraction(prev.pixels, f.pixels);
      peak = peakBlockDiff(prev.pixels, f.pixels);
      const global = m * 2.5 + area * 0.8;
      const local = peak * 0.9;
      delta = Math.min(1, Math.max(global, local));
    }
    const row = { index: f.index, t: f.t, delta, area, peak, hash, pixels: f.pixels };
    scored.push(row);
    prev = f;
  }
  return scored;
}

/** Mean brightness 0..1. Used to detect the silently-black recording failure mode. */
export function brightness(pixels) {
  let sum = 0;
  for (let i = 0; i < pixels.length; i++) sum += pixels[i];
  return sum / pixels.length / 255;
}

/** Spatial variance 0..1: a uniform frame (all black, all white) has ~0. */
export function variance(pixels) {
  let sum = 0;
  for (let i = 0; i < pixels.length; i++) sum += pixels[i];
  const mean = sum / pixels.length;
  let acc = 0;
  for (let i = 0; i < pixels.length; i++) acc += (pixels[i] - mean) ** 2;
  return Math.sqrt(acc / pixels.length) / 255;
}
