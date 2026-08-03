import { DEFAULTS } from "./select.mjs";

/**
 * Per-segment change statistics, split at each mark.
 *
 * The tool already computes a change magnitude for every sampled frame; it just never
 * aggregated it over the span a caller said they cared about. Two failure modes this
 * catches, both reported from real use: a camera pan recorded for twelve seconds where
 * the camera never moved, and ten seconds aimed at an object that was never in frame.
 * Both cost a full record → analyse → re-run cycle, and both are obvious the moment the
 * peak change across the marked span is printed next to the mark that opened it.
 */

/**
 * A segment is "static" exactly when `findTransitions` would find no transition in it.
 *
 * Deliberately not a new tuned constant. `findTransitions` opens a run at
 * `delta >= transitionDelta` (select.mjs), so reusing that number makes "static" a
 * checkable statement about the rest of the pipeline rather than a threshold someone
 * picked. It also classifies the reported cases correctly, which the settled threshold
 * (0.012) does not: peaks of 0.010 and 0.020 are static, a peak of 0.410 is not.
 */
export const STATIC_PEAK_DELTA = DEFAULTS.transitionDelta;

const START_LABEL = "start of recording";
const END_LABEL = "end of recording";

/**
 * Split the scored frames at each mark and describe what happened in between.
 *
 * The first sample of a segment keeps the delta it was scored with, which was measured
 * against the previous segment's last frame. That is deliberate: the change an action
 * caused belongs to the span the action opened.
 */
export function buildSegments(scored, events = [], { staticPeakDelta = STATIC_PEAK_DELTA } = {}) {
  if (!scored.length) return [];

  const lastT = scored[scored.length - 1].t;
  const marks = events
    .filter((e) => e.type === "mark" && e.t != null && e.t > 0 && e.t <= lastT)
    .sort((a, b) => a.t - b.t);

  const bounds = [{ t: 0, note: START_LABEL }];
  for (const m of marks) {
    // Two marks inside one sample period would otherwise produce a zero-width segment.
    if (bounds[bounds.length - 1].t === m.t) continue;
    bounds.push({ t: m.t, note: m.note ?? "(unlabelled mark)" });
  }

  const segments = [];
  for (let i = 0; i < bounds.length; i++) {
    const fromT = bounds[i].t;
    const toT = i + 1 < bounds.length ? bounds[i + 1].t : lastT;

    // The very first sample's delta is 0 by construction — it has no predecessor — so
    // including it drags the opening segment's mean down by 1/n.
    const rows = scored.filter((s) => s.index > 0 && s.t >= fromT && (i + 1 < bounds.length ? s.t < toT : s.t <= toT));

    const peakDelta = rows.reduce((m, s) => Math.max(m, s.delta), 0);
    const meanDelta = rows.length ? rows.reduce((n, s) => n + s.delta, 0) / rows.length : 0;

    segments.push({
      index: i + 1,
      fromT: Number(fromT.toFixed(2)),
      toT: Number(toT.toFixed(2)),
      durationSec: Number((toT - fromT).toFixed(2)),
      samples: rows.length,
      meanDelta: Number(meanDelta.toFixed(4)),
      peakDelta: Number(peakDelta.toFixed(3)),
      static: rows.length > 0 && peakDelta < staticPeakDelta,
      openedBy: bounds[i].note,
      closedBy: i + 1 < bounds.length ? bounds[i + 1].note : END_LABEL,
    });
  }
  return segments;
}

/** The header block. One line per segment, plus what closed it. */
export function formatSegments(segments) {
  if (segments.length <= 1) return null;
  const lines = ["SEGMENTS  (split at each mark; d = visual change 0..1)"];
  for (const s of segments) {
    const span = `${s.fromT.toFixed(2)}–${s.toT.toFixed(2)}s`;
    lines.push(
      `  ${String(s.index).padStart(2)}  ${span.padEnd(16)} ${`${s.durationSec.toFixed(1)}s`.padStart(6)}  ` +
        `mean d=${s.meanDelta.toFixed(3)}  peak d=${s.peakDelta.toFixed(3)}` +
        (s.static ? "   STATIC — nothing visibly changed" : "")
    );
    lines.push(`        ends at: ${s.closedBy}`);
  }
  return lines.join("\n");
}

/**
 * The finding this whole module exists for.
 *
 * A static *first* segment is not reported: the page sits still before anything is done
 * to it, so noting it would raise a false alarm on every recording. A static segment
 * that a mark opened is the strongest single signal the tool produces.
 */
export function segmentNotes(segments) {
  const notes = [];
  for (const s of segments) {
    if (s.index === 1 || !s.static) continue;
    notes.push(
      `Segment ${s.index} ("${s.openedBy}" → ${s.closedBy}) is static: over ` +
        `${s.durationSec.toFixed(1)} seconds the largest visual change was ` +
        `${s.peakDelta.toFixed(3)}, below the ${STATIC_PEAK_DELTA} threshold at which this ` +
        `tool considers the UI to be changing at all. Whatever was expected to happen in ` +
        `that span, the window did not visibly change while it was in effect. Check the ` +
        `frames either side before concluding, and check any occlusion or capture notes ` +
        `above — a window that stopped painting looks exactly like this.`
    );
  }
  return notes;
}
