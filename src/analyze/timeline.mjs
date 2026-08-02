/**
 * Text is roughly one token per four characters, so a timeline row costs about a
 * hundredth of an image. This channel is where the density lives: hundreds of
 * moments for the price of a fraction of one frame.
 */

function fmtT(t) {
  return t.toFixed(2).padStart(7);
}

/** Human-readable one-liner for a recorded browser action. */
export function describeEvent(ev) {
  if (ev.type === "mark") return `note: ${ev.note}`;
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
 * Merge sampled deltas, recorded actions and selected keyframes into one ordered
 * list. Quiet stretches are collapsed so the interesting moments stay legible.
 */
export function buildTimeline({ scored, events = [], keyframes = [], quietDelta = 0.02, maxRows = 220 }) {
  const frameAt = new Map();
  keyframes.forEach((f, i) => frameAt.set(f.index, i + 1));

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

  rows.sort((a, b) => a.t - b.t || (a.kind === "event" ? -1 : 1));

  // Under pressure, keep events and keyframes; plain samples are the least valuable.
  if (rows.length > maxRows) {
    const priority = rows.filter((r) => r.kind === "event" || r.frame);
    const rest = rows.filter((r) => !(r.kind === "event" || r.frame));
    rest.sort((a, b) => (b.delta || 0) - (a.delta || 0));
    const keep = new Set([...priority, ...rest.slice(0, Math.max(0, maxRows - priority.length))]);
    return rows.filter((r) => keep.has(r));
  }
  return rows;
}

export function formatTimeline(rows, { sampleFps = 4 } = {}) {
  const out = [
    "TIMELINE  (t = seconds into the recording; d = visual change 0..1; F## = frame shown above)",
  ];
  for (const r of rows) {
    if (r.kind === "quiet") {
      const secs = (r.samples / sampleFps).toFixed(1);
      out.push(`${fmtT(r.t)}  ·        (no visual change for ${secs}s)`);
    } else if (r.kind === "event") {
      out.push(`${fmtT(r.t)}  ·        ${r.text}`);
    } else {
      const f = r.frame ? `F${String(r.frame).padStart(2, "0")}` : "   ";
      out.push(`${fmtT(r.t)}  ${f}  d=${r.delta.toFixed(3)}`);
    }
  }
  return out.join("\n");
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
