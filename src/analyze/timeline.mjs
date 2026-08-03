/**
 * Text is roughly one token per four characters, so a timeline row costs about a
 * hundredth of an image. This channel is where the density lives: hundreds of
 * moments for the price of a fraction of one frame.
 */

const TIMELINE_HEADER =
  "TIMELINE  (t = seconds into the recording; d = visual change 0..1; F## = frame shown above)";

/** A mark is free text from the caller; every other field is already capped. */
const MAX_NOTE_CHARS = 160;

function fmtT(t) {
  return t.toFixed(2).padStart(7);
}

/** Human-readable one-liner for a recorded browser action. */
export function describeEvent(ev) {
  if (ev.type === "mark") {
    // Marks are never dropped when the timeline has to shrink, which turns one
    // unbounded note into a denial of service on the whole block. Cap it here, where
    // every other caller-supplied field is already capped.
    const note = String(ev.note ?? "");
    return `note: ${note.length > MAX_NOTE_CHARS ? `${note.slice(0, MAX_NOTE_CHARS - 1)}…` : note}`;
  }
  if (ev.type === "console") return `console ${ev.level || "error"}: ${ev.text}`;

  const tool = (ev.tool || "").replace(/^mcp__claude-in-chrome__/, "");
  const input = ev.input || {};
  const bits = [];
  if (input.action) bits.push(input.action);
  if (input.coordinate) bits.push(`(${input.coordinate})`);
  if (input.text) bits.push(`"${String(input.text).slice(0, 40)}"`);
  if (input.url) bits.push(String(input.url).slice(0, 60));
  if (input.selector) bits.push(String(input.selector).slice(0, 40));
  const detail = bits.join(" ");
  return `action: ${tool}${detail ? ` ${detail}` : ""}`;
}

/**
 * What survives when the timeline will not fit.
 *
 * Tier 0 is never dropped, at either truncation site. A mark is the model's own record
 * of what it was doing and the only entry carrying human intent; dropping one turns
 * "I marked this and nothing happened" into a silent absence of evidence, which is the
 * exact failure this tool exists to prevent. Segment boundaries are pinned for the same
 * reason — they are derived from marks — and the first and last rows are pinned so the
 * span the timeline covers is always legible.
 */
export const ROW_TIERS = { pinned: 0, tool: 1, keyframe: 2, quiet: 3, sample: 4 };

export function rowPriority(row, { first = false, last = false } = {}) {
  if (first || last) return ROW_TIERS.pinned;
  if (row.kind === "segment") return ROW_TIERS.pinned;
  if (row.kind === "event") {
    return row.event?.type === "mark" ? ROW_TIERS.pinned : ROW_TIERS.tool;
  }
  if (row.frame) return ROW_TIERS.keyframe;
  if (row.kind === "sample") return ROW_TIERS.sample;
  return ROW_TIERS.quiet;
}

const EMPTY_DROPPED = { total: 0, quiet: 0, samples: 0, keyframes: 0, tools: 0 };

function countKind(row) {
  if (row.kind === "quiet") return "quiet";
  if (row.kind === "event") return "tools";
  return row.frame ? "keyframes" : "samples";
}

function sumDropped(...parts) {
  const out = { ...EMPTY_DROPPED };
  for (const p of parts) {
    if (!p) continue;
    for (const k of Object.keys(out)) out[k] += p[k] || 0;
  }
  return out;
}

/**
 * Rows in the order they should be given up, worst first.
 *
 * Plain samples go before quiet rows deliberately: one more `d=0.019` line says almost
 * nothing, while "no visual change for 12.3s" accounts for a whole stretch. Dropping
 * samples also brings quiet rows next to each other, where `mergeQuiet` folds them into
 * one — so the cheap drops usually make the expensive ones unnecessary.
 */
function dropOrder(rows) {
  const seen = new Map();
  const annotated = rows.map((row, i) => {
    const tier = rowPriority(row, { first: i === 0, last: i === rows.length - 1 });
    let repeat = 0;
    if (row.kind === "event" && row.event?.type !== "mark") {
      const count = seen.get(row.text) || 0;
      repeat = count > 0 ? 1 : 0;
      seen.set(row.text, count + 1);
    }
    return { row, i, tier, repeat };
  });

  return annotated
    .filter((a) => a.tier !== ROW_TIERS.pinned)
    .sort((a, b) => {
      if (a.tier !== b.tier) return b.tier - a.tier;
      switch (a.tier) {
        // Shortest quiet stretches first — they account for the least time.
        case ROW_TIERS.quiet:
          return (a.row.samples || 0) - (b.row.samples || 0) || a.i - b.i;
        case ROW_TIERS.sample:
          return (a.row.delta || 0) - (b.row.delta || 0) || a.i - b.i;
        // Later duplicates of a state go before the first time it was reached.
        case ROW_TIERS.keyframe:
          return (b.row.frame || 0) - (a.row.frame || 0);
        // Repeated actions carry no information the first one did not.
        default:
          return b.repeat - a.repeat || a.i - b.i;
      }
    })
    .map((a) => a.row);
}

/** Fold runs of adjacent quiet rows into one, so dropped samples cost no time accounting. */
function mergeQuiet(rows) {
  const out = [];
  for (const row of rows) {
    const prev = out[out.length - 1];
    if (row.kind === "quiet" && prev?.kind === "quiet") {
      out[out.length - 1] = {
        ...prev,
        t: row.t,
        samples: (prev.samples || 0) + (row.samples || 0),
      };
      continue;
    }
    out.push(row);
  }
  return out;
}

/**
 * Merge sampled deltas, recorded actions, segment boundaries and selected keyframes
 * into one ordered list. Quiet stretches are collapsed so the interesting moments stay
 * legible.
 */
export function buildTimeline({
  scored,
  events = [],
  keyframes = [],
  segments = [],
  quietDelta = 0.02,
  maxRows = 220,
}) {
  const frameAt = new Map();
  keyframes.forEach((f, i) => {
    frameAt.set(f.index, i + 1);
  });

  const rows = [];
  let quietRun = 0;

  for (const s of scored) {
    const isFrame = frameAt.has(s.index);
    const interesting = isFrame || s.delta >= quietDelta;
    if (!interesting) {
      quietRun++;
      continue;
    }
    if (quietRun > 0) {
      rows.push({ kind: "quiet", t: s.t, samples: quietRun });
      quietRun = 0;
    }
    rows.push({
      kind: "sample",
      t: s.t,
      delta: s.delta,
      frame: frameAt.get(s.index) || null,
    });
  }
  if (quietRun > 0) {
    rows.push({ kind: "quiet", t: scored.length ? scored[scored.length - 1].t : 0, samples: quietRun });
  }

  for (const ev of events) {
    if (ev.t == null) continue;
    rows.push({ kind: "event", t: ev.t, text: describeEvent(ev), event: ev });
  }

  // A divider at each boundary, so the segment stats in the header can be located in
  // the timeline without counting marks.
  for (const seg of segments) {
    if (seg.index === 1) continue; // the first boundary is the start of the recording
    rows.push({
      kind: "segment",
      t: seg.fromT,
      segment: seg.index,
      peakDelta: seg.peakDelta,
      isStatic: seg.static,
      label: seg.openedBy,
    });
  }

  // A rank function rather than a ternary: an inconsistent comparator (which the two
  // arms of `a.kind === "event" ? -1 : 1` gave for two events) leaves the order of ties
  // up to the sort implementation.
  const rank = (r) => (r.kind === "segment" ? 0 : r.kind === "event" ? 1 : 2);
  rows.sort((a, b) => a.t - b.t || rank(a) - rank(b));

  if (rows.length <= maxRows) return { rows, dropped: { ...EMPTY_DROPPED } };

  // Under row pressure, give up the least informative rows. The previous version built
  // its keep-set from the priority rows unconditionally, so a recording with more
  // events than maxRows returned more rows than the cap it advertised.
  const order = dropOrder(rows);
  const doomed = new Set();
  const dropped = { ...EMPTY_DROPPED };
  for (const row of order) {
    if (rows.length - doomed.size <= maxRows) break;
    doomed.add(row);
    dropped[countKind(row)]++;
    dropped.total++;
  }
  return { rows: mergeQuiet(rows.filter((r) => !doomed.has(r))), dropped };
}

/** One rendered line. Extracted so the fitter can price a row without re-rendering it. */
export function formatRow(row, { sampleFps = 4 } = {}) {
  if (row.kind === "quiet") {
    const secs = (row.samples / sampleFps).toFixed(1);
    return `${fmtT(row.t)}  ·        (no visual change for ${secs}s)`;
  }
  if (row.kind === "event") return `${fmtT(row.t)}  ·        ${row.text}`;
  if (row.kind === "segment") {
    const label = row.label ? ` · "${row.label}"` : "";
    const stat = row.isStatic ? " · static" : "";
    return (
      `${fmtT(row.t)}  ────── segment ${row.segment} · ` +
      `peak d=${(row.peakDelta ?? 0).toFixed(3)}${stat}${label} ──────`
    );
  }
  const f = row.frame ? `F${String(row.frame).padStart(2, "0")}` : "   ";
  return `${fmtT(row.t)}  ${f}  d=${row.delta.toFixed(3)}`;
}

export function formatTimeline(rows, { sampleFps = 4 } = {}) {
  return [TIMELINE_HEADER, ...rows.map((r) => formatRow(r, { sampleFps }))].join("\n");
}

// Kept terse on purpose: the timeline's guaranteed floor is 800 characters, and a
// verbose footer spends a third of it explaining what is missing rather than showing it.
function droppedFooter(dropped, rowsShown, rowsTotal) {
  const bits = [];
  if (dropped.samples) bits.push(`${dropped.samples} low-change`);
  if (dropped.quiet) bits.push(`${dropped.quiet} quiet`);
  if (dropped.keyframes) bits.push(`${dropped.keyframes} keyframe`);
  if (dropped.tools) bits.push(`${dropped.tools} repeated action`);
  return (
    `… ${rowsTotal - rowsShown}/${rowsTotal} rows omitted to fit the budget` +
    `${bits.length ? ` (${bits.join(", ")})` : ""}. Every mark and segment boundary is shown; ` +
    `get_frames with a time range shows any period in full.`
  );
}

/**
 * Format the timeline to fit a character budget by dropping whole rows, never by cutting
 * text.
 *
 * The previous approach ran the formatted block through `clampText`, which slices from
 * the end. Rows are ordered by time, so that deleted the end of the recording — and a
 * mark placed late in a run, which is exactly where the interesting one usually is,
 * vanished from the result while every tool call before it survived.
 */
export function fitTimeline(rows, { sampleFps = 4, maxChars = Infinity, alreadyDropped = null } = {}) {
  const rowsTotal = rows.length + (alreadyDropped?.total ?? 0);
  const render = (kept) => formatTimeline(mergeQuiet(kept), { sampleFps });

  const full = render(rows);
  if (full.length <= maxChars) {
    const dropped = sumDropped(alreadyDropped);
    return {
      text: alreadyDropped?.total
        ? `${full}\n${droppedFooter(dropped, rows.length, rowsTotal)}`
        : full,
      truncated: Boolean(alreadyDropped?.total),
      dropped,
      rowsShown: rows.length,
      rowsTotal,
    };
  }

  // Dropping a row never makes the block longer — merging adjacent quiet rows only
  // shortens it further — so the smallest workable drop count can be found by bisection
  // instead of re-rendering once per candidate row.
  const order = dropOrder(rows);
  const fits = (k) => {
    const doomed = new Set(order.slice(0, k));
    const kept = rows.filter((r) => !doomed.has(r));
    const body = render(kept);
    const footer = droppedFooter(
      sumDropped(alreadyDropped, tally(order.slice(0, k))),
      kept.length,
      rowsTotal
    );
    return { ok: body.length + footer.length + 1 <= maxChars, body, footer, kept, k };
  };

  let lo = 1;
  let hi = order.length;
  let best = fits(order.length);
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const attempt = fits(mid);
    if (attempt.ok) {
      best = attempt;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }

  const dropped = sumDropped(alreadyDropped, tally(order.slice(0, best.k)));
  // Every mark is still here even if that overruns the allowance. A present mark beats a
  // perfectly-sized block.
  const overran = !best.ok;
  const note = overran
    ? "\n(the timeline exceeds its allowance because every mark and segment boundary is shown)"
    : "";
  return {
    text: `${best.body}\n${best.footer}${note}`,
    truncated: true,
    dropped,
    rowsShown: best.kept.length,
    rowsTotal,
  };
}

function tally(dropped) {
  const out = { ...EMPTY_DROPPED };
  for (const row of dropped) {
    out[countKind(row)]++;
    out.total++;
  }
  return out;
}

/** Marks in time order, numbered from 1 the way a caller counts them. */
export function listMarks(events = []) {
  return events
    .filter((e) => e.type === "mark" && e.t != null)
    .sort((a, b) => a.t - b.t)
    .map((e, i) => ({ index: i + 1, t: e.t, note: e.note ?? "(unlabelled mark)" }));
}

/** The listing every mark-resolution error prints, so a miss is self-correcting. */
function formatMarkList(marks) {
  return marks.map((m) => `  ${m.index}  t=${m.t.toFixed(2)}s  "${m.note}"`).join("\n");
}

/**
 * Resolve a mark selector to a time.
 *
 * Accepts a 1-based index or a case-insensitive substring of a mark's note. Every
 * failure prints the full list of marks, because the caller wrote those notes and will
 * recognise the right one immediately — an error that just says "no match" makes them
 * go and look it up.
 */
export function resolveMark(events, selector) {
  const marks = listMarks(events);
  if (!marks.length) {
    throw new Error(
      "This recording has no marks, so there is nothing for after_mark to resolve. Use " +
        "absolute at/from/to instead, or call mark during the next recording."
    );
  }

  const asIndex =
    typeof selector === "number"
      ? selector
      : /^\d+$/.test(String(selector).trim())
        ? Number(String(selector).trim())
        : null;

  if (asIndex != null) {
    const found = marks.find((m) => m.index === asIndex);
    if (!found) {
      throw new Error(
        `There is no mark ${asIndex}. This recording has ${marks.length} mark(s):\n` +
          `${formatMarkList(marks)}\nPass a 1-based index or a substring of one of these notes.`
      );
    }
    return found;
  }

  const needle = String(selector).toLowerCase();
  const hits = marks.filter((m) => m.note.toLowerCase().includes(needle));
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    throw new Error(
      `"${selector}" matches ${hits.length} marks:\n${formatMarkList(hits)}\n` +
        `Pass the 1-based index, or a longer substring that picks out just one.`
    );
  }
  throw new Error(
    `No mark matches "${selector}". This recording has ${marks.length} mark(s):\n` +
      `${formatMarkList(marks)}\nPass a 1-based index or a case-insensitive substring of one of these.`
  );
}

/** Asking for "after mark 2" and getting the remaining four minutes is nobody's intent. */
export const DEFAULT_MARK_WINDOW = 3;

/**
 * Turn a possibly mark-relative request into absolute times.
 *
 * A mark establishes an *origin*: `at`, `from` and `to` are then offsets from it. Every
 * other tool on this server speaks absolute time, so the result carries both — the
 * caller thinks in "1.5s after the third mark", the evidence is cited in seconds into
 * the recording, and neither has to do the arithmetic.
 */
export function resolveTimeOrigin({
  afterMark = null,
  offset = 0,
  at = null,
  from = null,
  to = null,
  events = [],
  duration = null,
}) {
  const mark = afterMark != null ? resolveMark(events, afterMark) : null;
  const base = (mark?.t ?? 0) + (mark ? offset : 0);
  // Rounded to the same two decimals as alignEvents, so an offset from a mark does not
  // arrive as 3.8499999999999996 in a caption a human is meant to read.
  const clamp = (t) => {
    const lo = Math.max(0, t);
    return Number((duration != null ? Math.min(lo, duration) : lo).toFixed(2));
  };

  if (at?.length) {
    return {
      mark, offset: mark ? offset : 0, base,
      at: at.map((t) => clamp(base + t)),
      from: null, to: null, clamped: at.some((t) => base + t < 0 || (duration != null && base + t > duration)),
    };
  }

  const rawFrom = mark ? base + (from ?? 0) : (from ?? 0);
  const rawTo = mark
    ? base + (to ?? DEFAULT_MARK_WINDOW)
    : to != null
      ? to
      : (duration ?? null);

  return {
    mark, offset: mark ? offset : 0, base,
    at: null,
    from: clamp(rawFrom),
    to: rawTo == null ? null : clamp(rawTo),
    clamped: rawFrom < 0 || (duration != null && rawTo != null && rawTo > duration),
  };
}

/**
 * Convert absolute wall-clock event timestamps into seconds from recording start,
 * and drop anything outside the recording window.
 */
export function alignEvents(events, startedAtMs, durationSec) {
  const aligned = [];
  for (const ev of events) {
    if (ev.tsMs == null) continue;
    const t = (ev.tsMs - startedAtMs) / 1000;
    if (t < -1 || (durationSec != null && t > durationSec + 1)) continue;
    aligned.push({ ...ev, t: Math.max(0, Number(t.toFixed(2))) });
  }
  return aligned.sort((a, b) => a.t - b.t);
}
