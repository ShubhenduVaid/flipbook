import { SAMPLE_W, SAMPLE_H } from "./frames.mjs";
import { resizeGray } from "./delta.mjs";

/**
 * Finding the part of the frame worth spending pixels on.
 *
 * Images cost a flat 1600 tokens whatever they contain, so resolution spent on desktop
 * background and browser chrome is resolution not spent on the thing under test. In a
 * day of reported use roughly 65% of every frame was waste: a 1400px app centred in a
 * 3440px window. The cost is diagnostic rather than aesthetic — a group of seven fish
 * at normal zoom was a few pixels each and settled nothing, while one fish reframed to
 * ~347px settled five questions at once.
 *
 * The 128x128 sample grid makes the arithmetic trivial, and one property is
 * load-bearing: `scale=128:128` does *not* preserve aspect, so sample pixel (i, j) maps
 * linearly onto fraction (i/128, j/128) of the source frame whatever the window's shape.
 * A bounding box measured in sample coordinates already *is* a fractional rect, with no
 * aspect correction anywhere.
 */
export const ROI_DEFAULTS = {
  pixelThreshold: 12, // matches changedFraction's threshold in delta.mjs
  minHitPairs: 2, // a pixel must move in at least this many frame pairs to be signal
  repaintGuard: 0.6, // ignore pairs where more than this much of the frame moved
  padFraction: 0.06, // pad each side by this fraction of the frame
  minSide: 0.1, // never produce a box narrower than this fraction of a dimension
  minSourcePx: 320, // …nor smaller than this many source pixels, when dimensions are known
  maxAreaFraction: 0.6, // a box covering more than this means cropping would not help
  hintAreaFraction: 0.02, // below this, the framing hint fires
};

/**
 * Per-pixel count of how many sampled frame pairs moved that pixel appreciably.
 *
 * Pairs where most of the frame moved are skipped: a navigation or a theme switch
 * repaints everything and would otherwise wash the mask out to the whole frame, which is
 * precisely the case where cropping has nothing to offer.
 */
export function changeMask(scored, opts = ROI_DEFAULTS) {
  const mask = new Uint16Array(SAMPLE_W * SAMPLE_H);
  let pairs = 0;
  for (let i = 1; i < scored.length; i++) {
    const a = scored[i - 1].pixels;
    const b = scored[i].pixels;
    if (!a || !b) continue;

    let moved = 0;
    for (let p = 0; p < mask.length; p++) {
      if (Math.abs(a[p] - b[p]) > opts.pixelThreshold) moved++;
    }
    if (moved / mask.length > opts.repaintGuard) continue;

    pairs++;
    for (let p = 0; p < mask.length; p++) {
      if (Math.abs(a[p] - b[p]) > opts.pixelThreshold) mask[p]++;
    }
  }
  return { mask, pairs };
}

/** Bounding box of the mask, in fractions of the source frame. */
export function changeBox(scored, opts = ROI_DEFAULTS) {
  const { mask, pairs } = changeMask(scored, opts);

  let minX = SAMPLE_W;
  let minY = SAMPLE_H;
  let maxX = -1;
  let maxY = -1;
  let hitPixels = 0;
  for (let y = 0; y < SAMPLE_H; y++) {
    for (let x = 0; x < SAMPLE_W; x++) {
      // Requiring more than one hit is what keeps compression noise out of the box.
      if (mask[y * SAMPLE_W + x] < opts.minHitPairs) continue;
      hitPixels++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < 0) {
    return { found: false, x: 0, y: 0, w: 0, h: 0, areaFraction: 0, rawAreaFraction: 0, pairs, hitPixels: 0 };
  }

  const x = minX / SAMPLE_W;
  const y = minY / SAMPLE_H;
  const w = (maxX + 1) / SAMPLE_W - x;
  const h = (maxY + 1) / SAMPLE_H - y;
  return {
    found: true,
    x, y, w, h,
    areaFraction: w * h,
    // The union of pixels that ever moved, which is the fact worth reporting — the
    // bounding box around them is always at least as large.
    rawAreaFraction: hitPixels / mask.length,
    pairs,
    hitPixels,
  };
}

/** Pad, clamp and enforce a usable minimum. This is what `roi: "auto"` resolves to. */
export function padBox(box, { width = null, height = null } = {}, opts = ROI_DEFAULTS) {
  const grow = (start, size, pad, minFraction, sourcePx) => {
    let lo = start - pad;
    let hi = start + size + pad;
    let min = minFraction;
    if (sourcePx) min = Math.max(min, Math.min(1, opts.minSourcePx / sourcePx));
    if (hi - lo < min) {
      const centre = (lo + hi) / 2;
      lo = centre - min / 2;
      hi = centre + min / 2;
    }
    if (lo < 0) {
      hi = Math.min(1, hi - lo);
      lo = 0;
    }
    if (hi > 1) {
      lo = Math.max(0, lo - (hi - 1));
      hi = 1;
    }
    return [lo, hi - lo];
  };

  const [x, w] = grow(box.x, box.w, opts.padFraction, opts.minSide, width);
  const [y, h] = grow(box.y, box.h, opts.padFraction, opts.minSide, height);
  return { x: round4(x), y: round4(y), w: round4(w), h: round4(h) };
}

function round4(n) {
  return Number(n.toFixed(4));
}

/** Rect expressed in source pixels, for prose and structured output. */
export function roiPixels(rect, { width, height }) {
  if (!width || !height) return null;
  return {
    x: Math.round(rect.x * width),
    y: Math.round(rect.y * height),
    w: Math.round(rect.w * width),
    h: Math.round(rect.h * height),
  };
}

/**
 * What `roi: "auto"` resolves to, or a reasoned refusal.
 *
 * A box covering most of the frame means the change is spread across the page, and
 * cropping to it would discard context for no gain in resolution — so it declines
 * rather than performing a crop that buys nothing.
 */
export function autoRoi(scored, { info = {}, opts = ROI_DEFAULTS } = {}) {
  const box = changeBox(scored, opts);
  if (!box.found || box.pairs < opts.minHitPairs) {
    return { applied: false, rect: null, areaFraction: 0, reason: "nothing changed enough to frame on" };
  }
  const rect = padBox(box, info, opts);
  if (rect.w * rect.h > opts.maxAreaFraction) {
    return {
      applied: false,
      rect: null,
      areaFraction: box.rawAreaFraction,
      reason:
        `the pixels that changed span ${Math.round(rect.w * rect.h * 100)}% of the frame, so ` +
        `cropping to them would lose context without gaining resolution`,
    };
  }
  return {
    applied: true,
    rect,
    areaFraction: box.rawAreaFraction,
    reason: `changed pixels occupied ${(box.rawAreaFraction * 100).toFixed(1)}% of the frame`,
  };
}

/** Validate and clamp a caller-supplied fractional rect. Throws with an actionable message. */
export function normalizeRoi(roi) {
  if (roi == null) return null;
  if (roi === "auto") return "auto";
  const need = ["x", "y", "w", "h"];
  if (typeof roi !== "object") {
    throw new Error(`roi must be "auto" or an object with x, y, w and h — got ${typeof roi}`);
  }
  for (const k of need) {
    const v = roi[k];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new Error(`roi.${k} must be a number between 0 and 1 (a fraction of the frame)`);
    }
    if (v < 0 || v > 1) {
      throw new Error(`roi.${k} is ${v}; it must be a fraction of the frame between 0 and 1`);
    }
  }
  if (roi.w <= 0 || roi.h <= 0) throw new Error("roi.w and roi.h must be greater than 0");

  // Clamp rather than reject: a rect running a little past the edge is a rounding slip,
  // not a mistake worth failing a whole analysis over.
  const x = Math.min(roi.x, 1);
  const y = Math.min(roi.y, 1);
  return {
    x: round4(x),
    y: round4(y),
    w: round4(Math.min(roi.w, 1 - x)),
    h: round4(Math.min(roi.h, 1 - y)),
  };
}

/**
 * The one place a crop filter string is built.
 *
 * Every consumer — the sampler, the still extractor and the contact-sheet cells — takes
 * this exact string, for the same reason `longEdgeScale` exists: three hand-rolled crops
 * are three chances to disagree about what "the region" means.
 *
 * Returns null when the source dimensions are unknown, and the caller must refuse rather
 * than carry on uncropped: a full frame under a "CROPPED VIEW" header is worse than an
 * error.
 */
export function cropFilter(rect, { width, height } = {}) {
  if (!width || !height || !rect) return null;
  const even = (n) => Math.max(2, n - (n % 2));
  const w = Math.min(even(Math.round(rect.w * width)), even(width));
  const h = Math.min(even(Math.round(rect.h * height)), even(height));
  let x = Math.round(rect.x * width);
  let y = Math.round(rect.y * height);
  // An out-of-range x or y is a hard ffmpeg error, not a warning.
  x = Math.max(0, Math.min(x - (x % 2), width - w));
  y = Math.max(0, Math.min(y - (y % 2), height - h));
  return `crop=${w}:${h}:${x}:${y}`;
}

/** One sentence naming exactly what is, and is not, visible in the images. */
export function describeRoi(rect, info = {}) {
  const px = roiPixels(rect, info);
  const size = px
    ? `a ${px.w}x${px.h} px region at (${px.x},${px.y}) of the ${info.width}x${info.height} frame`
    : "a sub-region of the frame";
  return (
    `CROPPED VIEW — every image below shows only ${size} ` +
    `(${Math.round(rect.w * 100)}% x ${Math.round(rect.h * 100)}% of it). The rest of the page ` +
    `is NOT visible in any image below, so its absence is not evidence of anything. Re-run ` +
    `without \`roi\` to see the whole window.`
  );
}

/** Short marker for image captions, where the full sentence would not fit. */
export function roiCaptionTag(rect, info = {}) {
  const px = roiPixels(rect, info);
  return px
    ? `[CROP ${px.w}x${px.h} @ ${px.x},${px.y}]`
    : `[CROP ${Math.round(rect.w * 100)}%x${Math.round(rect.h * 100)}%]`;
}

/**
 * Extract the rect from a 128x128 sample buffer and stretch it back to 128x128.
 *
 * Upsampling adds no information, and that is not the point — keeping the buffer at its
 * documented size is. `scoreFrames`, `samePicture`, `dHash` and `peakBlockDiff` all take
 * SAMPLE_W/SAMPLE_H as defaults, so a natural-sized sub-rect would read past the end of
 * the buffer and silently return NaN deltas, disabling dedupe.
 *
 * The gain is sensitivity: `mad` and `changedFraction` normalise by buffer length, so a
 * spinner occupying 0.3% of the full frame occupies ~8% of the cropped one.
 */
export function cropPixelsToSample(pixels, rect) {
  const x0 = Math.max(0, Math.min(SAMPLE_W - 1, Math.floor(rect.x * SAMPLE_W)));
  const y0 = Math.max(0, Math.min(SAMPLE_H - 1, Math.floor(rect.y * SAMPLE_H)));
  const w = Math.max(1, Math.min(SAMPLE_W - x0, Math.round(rect.w * SAMPLE_W)));
  const h = Math.max(1, Math.min(SAMPLE_H - y0, Math.round(rect.h * SAMPLE_H)));

  const sub = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      sub[y * w + x] = pixels[(y0 + y) * SAMPLE_W + (x0 + x)];
    }
  }
  return resizeGray(sub, w, h, SAMPLE_W, SAMPLE_H);
}

/**
 * The framing hint: what to crop to, named precisely enough to paste back.
 *
 * Two conditions, both required. The union of everything that ever changed must be tiny,
 * *and* no single frame pair may have moved much either. Together they distinguish "a
 * small thing changed" from "a small thing changed and nothing else ever did" — only the
 * second is a framing problem rather than a subtle app.
 */
export function framingHint(scored, { info = {}, opts = ROI_DEFAULTS } = {}) {
  if (scored.length < 3) return null;
  const box = changeBox(scored, opts);
  if (!box.found || box.pairs < opts.minHitPairs) return null;
  if (box.rawAreaFraction > opts.hintAreaFraction) return null;

  const peakArea = scored.reduce((m, s) => Math.max(m, s.area ?? 0), 0);
  if (peakArea > opts.hintAreaFraction) return null;

  // Below a few sample pixels across, the box is indistinguishable from noise.
  if (box.w * SAMPLE_W < 3 || box.h * SAMPLE_H < 3) return null;

  const rect = padBox(box, info, opts);
  const px = roiPixels(rect, info);
  const where = px
    ? `a ${px.w}x${px.h} px region at (${px.x},${px.y}) of the ${info.width}x${info.height} frame`
    : `a region ${Math.round(rect.w * 100)}% x ${Math.round(rect.h * 100)}% of the frame`;

  return (
    `Only ${(box.rawAreaFraction * 100).toFixed(1)}% of the frame ever changed, all of it ` +
    `inside ${where}. At contact-sheet size that region is roughly ` +
    `${Math.max(1, Math.round(rect.w * 340))} pixels across, which is too small to read. ` +
    `Re-run with roi:${JSON.stringify(rect)} — or roi:"auto", which resolves to the same ` +
    `region — to see it at full size.`
  );
}
