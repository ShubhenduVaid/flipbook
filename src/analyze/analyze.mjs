import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { sampleGrayFrames, extractFrame, fitToBytes, videoInfo, readAsBase64 } from "./frames.mjs";
import { scoreFrames } from "./delta.mjs";
import { selectKeyframes, DEFAULTS } from "./select.mjs";
import { buildContactSheet } from "./sheet.mjs";
import { planImages, estimateTokens, allocateText, clampText } from "./budget.mjs";
import { buildTimeline, fitTimeline } from "./timeline.mjs";
import { buildSegments, formatSegments, segmentNotes } from "./segments.mjs";
import { findGeometryJumps, findFlatOnset, geometryNote, flatOnsetNote } from "./anomaly.mjs";
import {
  framingHint, autoRoi, normalizeRoi, cropFilter, cropPixelsToSample, describeRoi,
  roiCaptionTag, roiPixels,
} from "./roi.mjs";

const DETAIL_LONG_EDGE = 1456;

/**
 * Turn a recording into the four response channels: one contact sheet, a handful of
 * full-resolution detail frames, a structured timeline, and links to the raw files.
 *
 * Deliberately returns evidence and never a verdict. A tool that answers "PASS"
 * hides its reasoning and cannot be argued with; the model does the judging.
 */
export async function analyzeVideo({
  video,
  events = [],
  rubric = null,
  from = 0,
  to = null,
  maxImages = 6,
  sampleFps = 4,
  returnMode = "inline",
  outDir,
  label = null,
  focus = null,
  roi = null,
}) {
  if (!fs.existsSync(video)) throw new Error(`recording not found: ${video}`);
  fs.mkdirSync(outDir, { recursive: true });

  const info = await videoInfo(video);
  const duration = info.duration ?? 0;
  const rangeTo = to != null ? Math.min(to, duration || to) : null;

  const requestedRoi = normalizeRoi(roi);
  if (requestedRoi && !info.width) {
    // Refuse rather than quietly skip the crop: full frames under a "CROPPED VIEW"
    // header would be worse than no answer at all.
    throw new Error(
      `roi was requested but the frame size of ${path.basename(video)} could not be read, ` +
        `so there is nothing to crop against. Re-run without roi.`
    );
  }

  // Always sample the whole frame once. The capture-integrity detectors have to see the
  // whole window — a viewport that shrank into a corner is invisible once the corner is
  // all that is left — and `roi: "auto"` needs the full frame to find its region at all.
  const raw = await sampleGrayFrames(video, { sampleFps, from, to: rangeTo });
  if (!raw.length) {
    throw new Error(
      `no frames could be decoded from ${video} — the file may be empty or corrupt`
    );
  }
  const scoredFull = scoreFrames(raw);

  const roiState = resolveRoi(requestedRoi, scoredFull, info);
  const roiFilter = roiState.applied ? cropFilter(roiState.rect, info) : null;

  // Re-score on the region rather than decoding a second time. The buffers are stretched
  // back to the sampling size so every downstream default (dHash, peakBlockDiff,
  // samePicture) still holds; the gain is sensitivity, since both change scores are
  // normalised by buffer length. This improves which frames get picked, not how they
  // look — the stills themselves are always extracted from the source at full
  // resolution, through the same crop filter.
  const scored = roiState.applied
    ? scoreFrames(
        scoredFull.map((s) => ({
          index: s.index,
          t: s.t,
          pixels: cropPixelsToSample(s.pixels, roiState.rect),
        }))
      )
    : scoredFull;

  const plan = planImages({ maxImages });
  const { frames: keyframes, transitions, notes } = selectKeyframes(scored, {
    events,
    maxFrames: plan.sheetCells,
    opts: DEFAULTS,
  });

  // Actions happened but the pixels barely moved. The overwhelmingly common cause is
  // not a broken app: macOS marks a window occluded when another window covers it on
  // the same Space, and the browser then stops painting it entirely, so the capture
  // shows only static browser chrome. Verified directly — the identical flow recorded
  // blank while a second browser window sat on top of the target, and recorded
  // perfectly once the target was moved clear.
  // Measured on the whole window: this is a question about the capture, not about the
  // region the caller chose to look at.
  const actionCount = events.filter((e) => e.type === "tool").length;
  const maxDelta = scoredFull.reduce((m, s) => Math.max(m, s.delta), 0);
  if (actionCount > 0 && maxDelta < 0.05) {
    notes.push(
      `${actionCount} browser action(s) were recorded but the window barely changed ` +
        `(largest change ${maxDelta.toFixed(3)}). Most likely the recorded window was ` +
        `covered by another window on the same Space, so the browser stopped painting ` +
        `it. Move or raise the target window so nothing overlaps it and record again. ` +
        `Being behind a full-screen app on a different Space is fine; being underneath ` +
        `another window is not.`
    );
  }

  // Split at each mark, so "I marked this and then nothing happened" is a statement the
  // analysis makes rather than one the reader has to reconstruct from the delta column.
  const segments = buildSegments(scored, events);
  notes.push(...segmentNotes(segments));

  // Did the capture stop being about the app partway through? Both detectors must see
  // the whole frame, so they run before any region of interest is applied — a viewport
  // that shrank into a corner is invisible once the corner is all that is left.
  const geometryJumps = findGeometryJumps(scoredFull);
  const flatOnset = findFlatOnset(scoredFull, { sampleFps });
  const anomalies = [
    ...geometryJumps.map((j) => ({ type: "geometry-change", t: j.t, detail: j })),
    ...(flatOnset ? [{ type: "flat-onset", t: flatOnset.t, detail: flatOnset }] : []),
  ];
  for (const j of geometryJumps) notes.push(geometryNote(j));
  if (flatOnset) notes.push(flatOnsetNote(flatOnset));

  // When the subject occupies a sliver of the frame, say which sliver. A recording that
  // cannot settle a question because the subject is a few pixels across is the other
  // half of the reported waste, and it is knowable at analysis time.
  const hint = roiState.applied ? null : framingHint(scoredFull, { info });
  if (hint) notes.push(hint);
  if (requestedRoi === "auto" && !roiState.applied) {
    notes.push(`roi:"auto" did not crop: ${roiState.reason}. The images below show the whole window.`);
  }

  // The cell aspect has to follow the crop, or every cell gets pillarbox bars around a
  // correctly-cropped image.
  const effW = info.width ? info.width * (roiState.applied ? roiState.rect.w : 1) : null;
  const effH = info.height ? info.height * (roiState.applied ? roiState.rect.h : 1) : null;
  const aspect = effW && effH ? effW / effH : 1.5;
  const sheet = await buildContactSheet(video, keyframes, outDir, {
    videoAspect: aspect,
    roiFilter,
  });

  // The end state matters most for validation, so it is always one of the detail
  // frames; the rest go to the highest-scoring distinct moments.
  const byScore = [...keyframes].sort((a, b) => {
    const bonus = (f) =>
      (f.reasons.includes("settled") ? 12 : 0) +
      (f.reasons.some((r) => r.startsWith("after:")) ? 10 : 0) +
      (f.anomalous ? 8 : 0);
    return b.score + bonus(b) - (a.score + bonus(a));
  });

  const detailPicks = [];
  const last = keyframes[keyframes.length - 1];
  if (last && plan.detail > 0) detailPicks.push(last);
  for (const f of byScore) {
    if (detailPicks.length >= plan.detail) break;
    if (detailPicks.some((d) => d.index === f.index)) continue;
    detailPicks.push(f);
  }
  detailPicks.sort((a, b) => a.t - b.t);

  const detailFiles = [];
  for (const f of detailPicks) {
    const p = path.join(outDir, `frame-${f.t.toFixed(2).replace(".", "_")}s.jpg`);
    await extractFrame(video, f.t, p, { maxLongEdge: DETAIL_LONG_EDGE, quality: 3, roiFilter });
    const fitted = await fitToBytes(p, { maxLongEdge: DETAIL_LONG_EDGE });
    detailFiles.push({ ...f, path: fitted.path, bytes: fitted.bytes });
  }

  const timeline = buildTimeline({ scored, events, keyframes, segments });

  // ---- assemble the response -------------------------------------------------
  //
  // Built as explicit blocks with a budget computed over all of them. The previous
  // version concatenated header and timeline, trimmed that, then recovered the two
  // halves by splitting on the literal "\n\nTIMELINE" — so a rubric long enough to
  // truncate inside the header made the marker disappear and silently dropped the
  // entire timeline, while the captions it never counted pushed the payload over the
  // token ceiling.
  const imageCount = (sheet ? 1 : 0) + detailFiles.length;

  const cropTag = roiState.applied ? `${roiCaptionTag(roiState.rect, info)} ` : "";

  const sheetCaption = sheet
    ? `${cropTag}CONTACT SHEET — ${sheet.count} keyframes, ${sheet.cols}x${sheet.rows}, read ` +
      `left to right then top to bottom. Each cell is labelled with its frame number and ` +
      `timestamp; red-outlined cells are the largest visual changes` +
      (roiState.applied
        ? `, and the amber border marks every cell as a crop, not the whole window.`
        : `.`)
    : null;

  const detailCaptions = detailFiles.map(
    (f, i) =>
      `${cropTag}DETAIL ${i + 1}/${detailFiles.length} — t=${f.t.toFixed(2)}s · ` +
      `change=${f.delta.toFixed(3)} · selected because: ${f.reasons.join(", ")}`
  );

  const linkDescription =
    `Full recording (${duration ? duration.toFixed(1) + "s" : "unknown length"}). ` +
    `Use get_frames to inspect any moment at full resolution.`;

  const header = buildHeader({
    video, label, info, from, to: rangeTo, keyframes, transitions,
    events, rubric, focus, notes, sheet, detailFiles, plan, segments, roiState,
  });

  const fixedChars =
    (sheetCaption?.length ?? 0) +
    detailCaptions.reduce((n, c) => n + c.length, 0) +
    linkDescription.length;

  const budget = allocateText({ images: imageCount, fixedChars });
  const fittedHeader = clampText(
    header,
    budget.header,
    "header trimmed to fit the MCP output budget; the rubric above may be incomplete."
  );
  // Whole rows, never a slice. `clampText` cuts from the end, and rows are in time
  // order, so it deleted the end of the recording — taking any mark placed late in the
  // run with it while every tool call before it survived.
  const fittedTimeline = fitTimeline(timeline.rows, {
    sampleFps,
    maxChars: budget.timeline,
    alreadyDropped: timeline.dropped,
  });

  const content = [];
  content.push({ type: "text", text: fittedHeader.text });

  if (sheet) {
    const sheetFit = await fitToBytes(sheet.path, { maxLongEdge: 1456 });
    content.push({ type: "text", text: sheetCaption });
    content.push(imageContent(sheetFit.path, returnMode));
  }

  detailFiles.forEach((f, i) => {
    content.push({ type: "text", text: detailCaptions[i] });
    content.push(imageContent(f.path, returnMode));
  });

  // Always present, never recovered by string-splitting.
  content.push({ type: "text", text: fittedTimeline.text });

  content.push({
    type: "resource_link",
    uri: pathToFileURL(video).href,
    name: path.basename(video),
    description: linkDescription,
    mimeType: video.endsWith(".mov") ? "video/quicktime" : "video/mp4",
  });

  const structuredContent = {
    video,
    label,
    durationSec: duration ? Number(duration.toFixed(2)) : null,
    width: info.width,
    height: info.height,
    analyzedRange: { from, to: rangeTo ?? duration },
    sampleFps,
    keyframes,
    detailFrames: detailFiles.map((f) => ({ t: f.t, path: f.path, reasons: f.reasons })),
    contactSheet: sheet ? sheet.path : null,
    transitionCount: transitions.length,
    segments,
    anomalies,
    // Always present, applied or not: an absent field could be read as "uncropped".
    roi: {
      mode: roiState.mode,
      applied: roiState.applied,
      rect: roiState.rect,
      sourcePixels: roiState.applied ? roiPixels(roiState.rect, info) : null,
      frame: { width: info.width, height: info.height },
      reason: roiState.reason,
    },
    events: events.map((e) => ({ t: e.t, type: e.type, tool: e.tool, note: e.note })),
    notes,
    estimatedTokens: estimateTokens({
      images: imageCount,
      textChars: content.reduce((n, c) => n + (c.type === "text" ? c.text.length : 0), 0) +
        linkDescription.length,
    }),
    tokenCeiling: plan.ceiling,
    timelineTruncated: fittedTimeline.truncated,
    timelineRowsShown: fittedTimeline.rowsShown,
    timelineRowsTotal: fittedTimeline.rowsTotal,
    timelineDropped: fittedTimeline.dropped,
    headerTruncated: fittedHeader.truncated,
  };

  return { content, structuredContent };
}

/**
 * Turn the requested `roi` into a decision, in one place.
 *
 * Always returns an object with `applied`, so a caller reading `structuredContent.roi`
 * can never mistake an absent field for "these images show the whole window".
 */
function resolveRoi(requested, scoredFull, info) {
  if (!requested) return { mode: null, applied: false, rect: null, reason: "no roi requested" };
  if (requested === "auto") {
    const auto = autoRoi(scoredFull, { info });
    return { mode: "auto", applied: auto.applied, rect: auto.rect, reason: auto.reason };
  }
  return {
    mode: "explicit",
    applied: true,
    rect: requested,
    reason: "region supplied by the caller",
  };
}

function imageContent(p, returnMode) {
  if (returnMode === "paths") {
    return {
      type: "text",
      text: `[image on disk] ${p}\n(read it with the Read tool to view it)`,
    };
  }
  return { type: "image", data: readAsBase64(p), mimeType: "image/jpeg" };
}

function buildHeader({
  video, label, info, from, to, keyframes, transitions, events, rubric, focus, notes, sheet,
  detailFiles, plan, segments = [], roiState = null,
}) {
  const lines = [];
  lines.push(`RECORDING ANALYSIS${label ? ` — ${label}` : ""}`);
  lines.push(
    `${path.basename(video)} · ${info.width ?? "?"}x${info.height ?? "?"} · ` +
      `${info.duration ? info.duration.toFixed(2) + "s" : "unknown length"}` +
      (from || to ? ` · analysed ${from.toFixed(2)}s–${(to ?? info.duration ?? 0).toFixed(2)}s` : "")
  );
  // Immediately after the dimensions and before everything variable-length, so it is the
  // one thing that cannot be pushed out of the header by a long rubric.
  if (roiState?.applied) {
    lines.push("");
    lines.push(describeRoi(roiState.rect, info));
    lines.push("");
  }
  lines.push(
    `${keyframes.length} keyframes selected from ${transitions.length} visual transitions · ` +
      `${events.length} recorded action(s) · ` +
      `${sheet ? 1 : 0} contact sheet + ${detailFiles.length} detail frame(s) of a ${plan.total}-image budget`
  );

  const segmentBlock = formatSegments(segments);
  if (segmentBlock) {
    lines.push("");
    lines.push(segmentBlock);
  }

  if (notes.length) {
    lines.push("");
    for (const n of notes) lines.push(`! ${n}`);
  }

  // Above the rubric, not below it. The header is trimmed from the end, so a long
  // caller-supplied rubric used to eat the instructions for reading the evidence.
  lines.push("");
  lines.push(
    "HOW TO READ THIS: the contact sheet shows the whole recording at a glance; the " +
      "detail frames are full-resolution stills of the moments that changed most or " +
      "followed a recorded action; the timeline lists every sampled moment with its " +
      "change magnitude. If something looks wrong in a cell, call get_frames for that " +
      "time range to see it at full resolution before concluding."
  );
  if (rubric) {
    lines.push(
      "State a verdict per rubric item, citing frame numbers and timestamps as evidence. " +
        "If the evidence is insufficient for an item, say so and request more frames rather " +
        "than guessing."
    );
  }

  if (focus) {
    lines.push("");
    lines.push(`FOCUS: ${focus}`);
  }
  if (rubric) {
    lines.push("");
    lines.push("VALIDATION RUBRIC (judge the evidence below against this):");
    for (const line of String(rubric).split("\n")) lines.push(`  ${line}`);
  }
  return lines.join("\n");
}
