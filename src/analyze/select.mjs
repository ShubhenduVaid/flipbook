import { brightness, variance, mad, peakBlockDiff } from "./delta.mjs";

export const DEFAULTS = {
  transitionDelta: 0.035, // above this, the UI is actively changing
  stableDelta: 0.012, // below this, the UI has settled
  settleFrames: 2, // consecutive stable samples that count as "settled"
  settleLagSec: 0.6, // how long after an action to look for its result
  // Two frames count as the same picture only if they are close on both measures.
  dupMad: 0.003, // near-identical on average, and…
  // …no region differs meaningfully either. Calibrated against the fixture: the idle
  // page versus the same page showing a spinner measures 0.0267 here, so the cutoff
  // sits well below that, while genuinely identical frames measure under 0.005.
  dupPeakBlock: 0.015,
};

/**
 * Whether two candidate frames show the same thing.
 *
 * Deliberately compares pixels rather than perceptual hashes. A dHash of a mostly
 * dark page is nearly constant — measured Hamming distance between the idle page and
 * the same page showing a spinner was 0 — so hash-based dedupe silently discarded
 * exactly the frames worth keeping.
 */
function samePicture(a, b, opts) {
  return mad(a.pixels, b.pixels) < opts.dupMad && peakBlockDiff(a.pixels, b.pixels) < opts.dupPeakBlock;
}

/** Contiguous runs where the UI is changing, each with its settled-after frame. */
export function findTransitions(scored, opts = DEFAULTS) {
  const transitions = [];
  let run = null;

  for (let i = 0; i < scored.length; i++) {
    const f = scored[i];
    if (f.delta >= opts.transitionDelta) {
      if (!run) run = { startIdx: i, endIdx: i, peakIdx: i, peak: f.delta };
      else {
        run.endIdx = i;
        if (f.delta > run.peak) {
          run.peak = f.delta;
          run.peakIdx = i;
        }
      }
    } else if (run) {
      // Look ahead for the frame where it actually comes to rest — a half-rendered
      // frame mid-animation says nothing; the state it settles into is the evidence.
      let stable = 0;
      let settledIdx = i;
      for (let j = i; j < scored.length; j++) {
        if (scored[j].delta <= opts.stableDelta) {
          stable++;
          if (stable >= opts.settleFrames) {
            settledIdx = j;
            break;
          }
        } else {
          stable = 0;
        }
        settledIdx = j;
      }
      run.settledIdx = settledIdx;
      transitions.push(run);
      run = null;
    }
  }
  if (run) {
    run.settledIdx = Math.min(run.endIdx + opts.settleFrames, scored.length - 1);
    transitions.push(run);
  }
  return transitions;
}

function nearestIndex(scored, t) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < scored.length; i++) {
    const d = Math.abs(scored[i].t - t);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/**
 * Choose the frames worth spending image budget on.
 *
 * Uniform sampling is the obvious approach and the wrong one: most of a recording is
 * a page sitting still, so uniform frames spend the budget proving nothing changed.
 * These candidates are the moments a QA engineer would actually look at.
 */
export function selectKeyframes(scored, { events = [], maxFrames = 16, opts = DEFAULTS } = {}) {
  if (!scored.length) return { frames: [], transitions: [], notes: ["recording had no frames"] };

  const notes = [];
  const candidates = new Map(); // index -> {reasons:Set, score}

  const add = (idx, reason, weight) => {
    if (idx < 0 || idx >= scored.length) return;
    const cur = candidates.get(idx) || { idx, reasons: new Set(), score: 0 };
    cur.reasons.add(reason);
    cur.score += weight;
    candidates.set(idx, cur);
  };

  add(0, "start", 100);
  add(scored.length - 1, "end", 100);

  const transitions = findTransitions(scored, opts);
  for (const tr of transitions) {
    add(tr.peakIdx, "peak-change", 10 + tr.peak * 30);
    if (tr.settledIdx != null) add(tr.settledIdx, "settled", 20 + tr.peak * 30);
  }

  // A recorded action is a question; the frame ~600ms later is the answer.
  for (const ev of events) {
    if (ev.t == null) continue;
    const idx = nearestIndex(scored, ev.t + opts.settleLagSec);
    add(idx, `after:${ev.label || ev.type || "action"}`, 25);
    const atIdx = nearestIndex(scored, ev.t);
    add(atIdx, `at:${ev.label || ev.type || "action"}`, 8);
  }

  if (transitions.length === 0) {
    notes.push(
      "No visual change detected across the whole recording — the page never updated. " +
        "That is itself a finding if an action was expected to do something."
    );
    // Spread a few frames so the model can still see what was on screen.
    const step = Math.max(1, Math.floor(scored.length / 4));
    for (let i = step; i < scored.length - 1; i += step) add(i, "uniform", 1);
  }

  // Rank by score, then keep only visually distinct frames.
  //
  // When two candidates show the same picture the earlier one wins, and inherits the
  // later one's reasons. This matters more than it looks: the frame showing a result
  // panel at 3.75s is identical to the final frame at 8s, and keeping the later one
  // discards the only thing worth knowing — when the state was actually reached. The
  // merged reasons still record that the state persisted to the end of the run.
  // VIDEO_QA_DEBUG_SELECT=1 traces every accept/merge decision to stderr. Threshold
  // tuning is unreadable without it, and stderr is safe under the stdio transport.
  const debug = process.env.VIDEO_QA_DEBUG_SELECT
    ? (msg) => console.error(`[select] ${msg}`)
    : () => {};

  const ranked = [...candidates.values()].sort((a, b) => b.score - a.score);
  const accepted = [];
  for (const c of ranked) {
    if (accepted.length >= maxFrames) {
      debug(`budget full, dropping t=${scored[c.idx].t.toFixed(2)} (${[...c.reasons].join("|")})`);
      continue;
    }
    const f = scored[c.idx];
    const dupAt = accepted.findIndex((a) => samePicture(scored[a.idx], f, opts));
    if (dupAt >= 0) {
      const a = accepted[dupAt];
      if (c.idx < a.idx) {
        debug(
          `t=${f.t.toFixed(2)} duplicates later t=${scored[a.idx].t.toFixed(2)} — keeping earlier`
        );
        accepted[dupAt] = {
          idx: c.idx,
          reasons: new Set([...c.reasons, ...a.reasons]),
          score: Math.max(c.score, a.score),
        };
      } else {
        debug(
          `t=${f.t.toFixed(2)} (${[...c.reasons].join("|")}) merged into ` +
            `t=${scored[a.idx].t.toFixed(2)}`
        );
        for (const r of c.reasons) a.reasons.add(r);
      }
      continue;
    }
    debug(`accept t=${f.t.toFixed(2)} score=${c.score.toFixed(1)} (${[...c.reasons].join("|")})`);
    accepted.push(c);
  }

  accepted.sort((a, b) => a.idx - b.idx);

  const frames = accepted.map((c) => {
    const f = scored[c.idx];
    return {
      t: Number(f.t.toFixed(2)),
      index: c.idx,
      delta: Number(f.delta.toFixed(3)),
      area: Number(f.area.toFixed(3)),
      reasons: [...c.reasons],
      score: Number(c.score.toFixed(1)),
      anomalous: f.delta >= opts.transitionDelta * 2,
      brightness: Number(brightness(f.pixels).toFixed(3)),
      variance: Number(variance(f.pixels).toFixed(3)),
    };
  });

  // The failure this catches is the one users actually hit: permission or window
  // problems yield a technically valid video containing nothing at all.
  const flat = frames.filter((f) => f.variance < 0.02);
  if (frames.length && flat.length === frames.length) {
    notes.push(
      "Every sampled frame is a flat, featureless image. The recording is almost " +
        "certainly blank — run doctor to check Screen Recording permission."
    );
  }

  return { frames, transitions, notes };
}
