import { SAMPLE_W, SAMPLE_H } from "./frames.mjs";
import { variance } from "./delta.mjs";

/**
 * Detecting a capture that stopped being about the app.
 *
 * The failure this exists for produced a misdiagnosis, not just wasted time. A browser
 * screenshot taken with size arguments overrides device metrics, which resizes the
 * rendered viewport underneath the unchanged window — so the recorder keeps rolling at
 * the old size and captures a shrunken or unpainted page. One reported run showed the
 * page blank for eleven seconds after a reload and was about to be filed as a serious
 * loading bug; a control run driven with clicks only painted in ~1.8 seconds.
 *
 * The recording was not lying. It was faithfully recording a corrupted window. That is
 * the worst property an evidence tool can have, and documentation is the weakest
 * possible mitigation for it — so it is detected here instead.
 *
 * Both detectors work on the sampled greyscale frames. Nothing in this repo speaks CDP,
 * and nothing may: the security rubric forbids network access from src/.
 */
export const ANOMALY_DEFAULTS = {
  borderTolerance: 6, // grey levels within which a row/column counts as uniform border
  borderOnsetAfter: 0.25, // border must reach at least this much of the frame…
  borderOnsetBefore: 0.1, // …from under this much before
  boxJump: 0.15, // or a content edge must move this fraction of the frame
  stableBefore: 2, // samples of settled geometry required beforehand
  persistAfter: 3, // samples the new geometry must hold
  persistTolerance: 0.03,
  flatVariance: 0.02, // matches the whole-recording blank check in select.mjs
  liveVariance: 0.04, // clearly not flat
  flatRunIn: 3,
  flatMinSeconds: 1.5,
};

function median(values) {
  if (!values.length) return 0;
  const sorted = Float64Array.from(values).sort();
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Bounding box of the non-border content, plus how much of the frame is uniform border.
 *
 * The border value is the *median* of the one-pixel perimeter, not its mean, so a
 * scrollbar or a title bar along one edge does not drag the reference colour off the
 * actual background. Scanning inward only while a whole row or column stays uniform is
 * what keeps an interior panel — a white card on a grey page — from reading as border.
 */
export function contentBox(pixels, opts = ANOMALY_DEFAULTS) {
  const w = SAMPLE_W;
  const h = SAMPLE_H;
  const perimeter = [];
  for (let x = 0; x < w; x++) {
    perimeter.push(pixels[x], pixels[(h - 1) * w + x]);
  }
  for (let y = 0; y < h; y++) {
    perimeter.push(pixels[y * w], pixels[y * w + w - 1]);
  }
  const borderValue = median(perimeter);
  const near = (v) => Math.abs(v - borderValue) <= opts.borderTolerance;

  const rowUniform = (y) => {
    for (let x = 0; x < w; x++) if (!near(pixels[y * w + x])) return false;
    return true;
  };
  const colUniform = (x) => {
    for (let y = 0; y < h; y++) if (!near(pixels[y * w + x])) return false;
    return true;
  };

  let top = 0;
  while (top < h && rowUniform(top)) top++;
  let bottom = h - 1;
  while (bottom > top && rowUniform(bottom)) bottom--;
  let left = 0;
  while (left < w && colUniform(left)) left++;
  let right = w - 1;
  while (right > left && colUniform(right)) right--;

  // A wholly uniform frame has no content at all; report an empty box rather than an
  // inverted one.
  const empty = top >= h || left >= w;
  const x0 = empty ? 0 : left / w;
  const x1 = empty ? 0 : (right + 1) / w;
  const y0 = empty ? 0 : top / h;
  const y1 = empty ? 0 : (bottom + 1) / h;
  const boxFraction = Math.max(0, (x1 - x0) * (y1 - y0));

  return { x0, y0, x1, y1, boxFraction, borderFraction: 1 - boxFraction, borderValue };
}

function edgesSettled(boxes, from, count, tolerance) {
  if (from < 0 || from + count > boxes.length) return false;
  const first = boxes[from];
  for (let i = from + 1; i < from + count; i++) {
    const b = boxes[i];
    if (
      Math.abs(b.x0 - first.x0) > tolerance ||
      Math.abs(b.y0 - first.y0) > tolerance ||
      Math.abs(b.x1 - first.x1) > tolerance ||
      Math.abs(b.y1 - first.y1) > tolerance
    ) {
      return false;
    }
  }
  return true;
}

function edgeShift(a, b) {
  return Math.max(
    Math.abs(a.x0 - b.x0),
    Math.abs(a.y0 - b.y0),
    Math.abs(a.x1 - b.x1),
    Math.abs(a.y1 - b.y1)
  );
}

/**
 * An abrupt, persistent change in the geometry the window is actually painting.
 *
 * Every condition here is about avoiding a false positive on something legitimate:
 *
 *   - a full-page navigation still paints to all four edges, so the border fraction
 *     does not move and no edge jumps;
 *   - a modal dims the page behind it but the page keeps painting, likewise;
 *   - a permanently dark or letterboxed layout has a high border fraction *before* as
 *     well, so requiring a transition from under borderOnsetBefore never fires;
 *   - a one-frame flicker fails the persistence requirement.
 *
 * A video player entering fullscreen mid-recording is genuinely indistinguishable from
 * a viewport override, so the note says so rather than asserting a cause.
 */
export function findGeometryJumps(scored, opts = ANOMALY_DEFAULTS) {
  if (scored.length < opts.stableBefore + opts.persistAfter + 1) return [];
  const boxes = scored.map((s) => contentBox(s.pixels, opts));
  const jumps = [];

  for (let i = opts.stableBefore; i <= boxes.length - opts.persistAfter; i++) {
    if (!edgesSettled(boxes, i - opts.stableBefore, opts.stableBefore, opts.persistTolerance)) continue;
    if (!edgesSettled(boxes, i, opts.persistAfter, opts.persistTolerance)) continue;

    const before = boxes[i - 1];
    const after = boxes[i];
    const jumped = edgeShift(before, after) >= opts.boxJump;
    const borderOnset =
      before.borderFraction < opts.borderOnsetBefore && after.borderFraction >= opts.borderOnsetAfter;
    if (!jumped && !borderOnset) continue;

    // One incident, one note: a shrink that later reverts is the same event as its
    // restoration, so record the restoration on the jump rather than emitting a second.
    const previous = jumps[jumps.length - 1];
    if (previous && edgeShift(boxes[previous.index - 1], after) < opts.persistTolerance) {
      previous.restoredAtT = Number(scored[i].t.toFixed(2));
      continue;
    }

    jumps.push({
      t: Number(scored[i].t.toFixed(2)),
      index: i,
      kind: after.boxFraction < before.boxFraction - 0.05 ? "shrank" : "moved",
      before: {
        boxFraction: Number(before.boxFraction.toFixed(3)),
        borderFraction: Number(before.borderFraction.toFixed(3)),
      },
      after: {
        boxFraction: Number(after.boxFraction.toFixed(3)),
        borderFraction: Number(after.borderFraction.toFixed(3)),
      },
      restoredAtT: null,
    });
    i += opts.persistAfter - 1;
  }
  return jumps;
}

/**
 * A run of flat frames that follows a run of normal ones.
 *
 * The existing blank-recording check fires only when *every* sampled frame is
 * featureless, so it is blind to the case that produced the reported misdiagnosis: a
 * recording that starts fine and goes blank partway through. The transition into
 * flatness is the interesting event, not the state.
 *
 * Returns null when there is no live prefix, leaving the all-flat case to the existing
 * note so the two can never both fire.
 */
export function findFlatOnset(scored, { sampleFps = 4, ...rest } = {}) {
  const opts = { ...ANOMALY_DEFAULTS, ...rest };
  if (scored.length < opts.flatRunIn + 2) return null;
  const variances = scored.map((s) => variance(s.pixels));

  // "Everything from k onward is flat" is the same statement as "k is past the last
  // non-flat frame", which turns the scan from quadratic into one pass.
  let lastLive = -1;
  for (let i = 0; i < variances.length; i++) {
    if (variances[i] >= opts.flatVariance) lastLive = i;
  }
  if (lastLive < 0 || lastLive === variances.length - 1) return null;

  for (let k = opts.flatRunIn; k < variances.length; k++) {
    if (k <= lastLive) continue;
    const liveBefore = variances
      .slice(k - opts.flatRunIn, k)
      .every((v) => v >= opts.liveVariance);
    if (!liveBefore) continue;

    const secondsFlat = (variances.length - k) / sampleFps;
    // A white flash during a navigation is one or two samples; a window that stopped
    // painting stays stopped.
    if (secondsFlat < opts.flatMinSeconds) return null;
    return {
      t: Number(scored[k].t.toFixed(2)),
      index: k,
      secondsFlat: Number(secondsFlat.toFixed(1)),
      toEnd: true,
    };
  }
  return null;
}

/** The prose lives next to the maths so the explanation cannot drift from the detector. */
export function geometryNote(jump) {
  const pct = (v) => `${Math.round(v * 100)}%`;
  const ending = jump.restoredAtT
    ? `It goes back to its earlier geometry at t=${jump.restoredAtT.toFixed(2)}s.`
    : "It stays that way for the rest of the recording.";
  return (
    `At t=${jump.t.toFixed(2)}s the recorded window changed the geometry it was painting. ` +
    `Before that, content covered ${pct(jump.before.boxFraction)} of the frame; from ` +
    `t=${jump.t.toFixed(2)}s onward it covers ${pct(jump.after.boxFraction)}, with ` +
    `${pct(jump.after.borderFraction)} of the frame a single flat colour. ${ending}\n` +
    `  The usual cause is the browser's device metrics being overridden while capture was ` +
    `still running. A screenshot taken with width, height or deviceScaleFactor arguments ` +
    `resizes the rendered viewport underneath the unchanged window, so the recording keeps ` +
    `rolling at the old size and captures a shrunken or unpainted page. Frames after ` +
    `t=${jump.t.toFixed(2)}s would then be evidence about an emulated viewport rather than ` +
    `about the app.\n` +
    `  If a fullscreen player was opened or the window was deliberately resized, this is ` +
    `expected and can be ignored — the two look identical from the pixels. Otherwise, take ` +
    `screenshots without size arguments while recording, or judge only the frames before ` +
    `t=${jump.t.toFixed(2)}s.`
  );
}

export function flatOnsetNote(onset) {
  return (
    `At t=${onset.t.toFixed(2)}s the window went blank and stayed blank for the remaining ` +
    `${onset.secondsFlat.toFixed(1)}s: frames before it have normal detail, frames after are ` +
    `a flat, featureless image. This is not a recording that was blank throughout — the ` +
    `capture was working, and then the window stopped painting.\n` +
    `  The two causes seen in practice are another window coming to sit on top of the target ` +
    `(macOS marks it occluded and the browser stops painting it) and the browser's device ` +
    `metrics being overridden mid-recording by a screenshot taken with size arguments. ` +
    `Do not report findings from frames after t=${onset.t.toFixed(2)}s.`
  );
}
