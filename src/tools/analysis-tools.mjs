import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { readMeta, readEvents, videoPath, framesDir } from "../capture/session.mjs";
import { analyzeVideo } from "../analyze/analyze.mjs";
import { alignEvents, resolveTimeOrigin } from "../analyze/timeline.mjs";
import { resolveInput } from "../analyze/input.mjs";
import { sampleGrayFrames, extractFrame, fitToBytes, videoInfo, readAsBase64 } from "../analyze/frames.mjs";
import { scoreFrames } from "../analyze/delta.mjs";
import { selectKeyframes } from "../analyze/select.mjs";
import { planImages } from "../analyze/budget.mjs";
import { normalizeRoi, cropFilter, roiCaptionTag, describeRoi } from "../analyze/roi.mjs";
import { roiSchema } from "./schemas.mjs";

/** Both tools accept either a stored session or an arbitrary file on disk. */
async function resolveSource({ session_id, path: inputPath }) {
  if (session_id) {
    const meta = readMeta(session_id);
    if (!meta) throw new Error(`unknown session: ${session_id}`);
    const v = videoPath(session_id);
    if (!fs.existsSync(v)) throw new Error(`session ${session_id} has no recording on disk`);
    return {
      video: v,
      outDir: framesDir(session_id),
      meta,
      events: alignEvents(readEvents(session_id), meta.startedAtMs, meta.durationSec),
      note: null,
    };
  }
  if (!inputPath) throw new Error("provide either session_id or path");
  const resolved = await resolveInput(inputPath);
  return {
    video: resolved.video,
    outDir: path.join(resolved.workDir, "frames"),
    meta: { label: path.basename(inputPath) },
    events: [],
    note: resolved.note,
  };
}

export function registerAnalysisTools(server) {
  server.registerTool(
    "analyze_recording",
    {
      title: "Analyse a recording",
      description:
        "Turn any recording into visual evidence: a labelled contact sheet, full-resolution " +
        "frames of the moments that changed, and a timeline. Works on recordings made by " +
        "this plugin (session_id), on your own screen recordings (path to .mov/.mp4/.webm), " +
        "on animated GIFs — including ones from Claude in Chrome's gif_creator, whose later " +
        "frames Claude cannot otherwise see — and on a directory of stills.",
      inputSchema: {
        session_id: z.string().optional().describe("A session from list_recordings."),
        path: z.string().optional().describe("Path to a video, an animated GIF, or a directory of stills."),
        rubric: z.string().optional().describe("What must be true for this to be correct. One criterion per line."),
        from: z.number().min(0).optional().describe("Start of the time range to analyse, in seconds."),
        to: z.number().min(0).optional().describe("End of the time range to analyse, in seconds."),
        max_images: z.number().int().min(1).max(7).optional().describe("Image budget including the contact sheet (default 6)."),
        focus: z.string().optional().describe("What to pay attention to, e.g. 'the checkout panel'."),
        sample_fps: z.number().min(0.5).max(15).optional().describe("Analysis sampling rate (default 4)."),
        return_mode: z.enum(["inline", "paths"]).optional().describe("inline (default) embeds images; paths returns file paths."),
        roi: roiSchema,
      },
    },
    async (args) => {
      let src;
      try {
        src = await resolveSource(args);
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: err.message }] };
      }

      try {
        const analysis = await analyzeVideo({
          video: src.video,
          events: src.events,
          rubric: args.rubric ?? null,
          from: args.from ?? 0,
          to: args.to ?? null,
          maxImages: args.max_images ?? 6,
          sampleFps: args.sample_fps ?? 4,
          returnMode: args.return_mode ?? "inline",
          outDir: src.outDir,
          label: src.meta?.label ?? null,
          focus: args.focus ?? null,
          roi: args.roi ?? null,
        });
        if (src.note) {
          analysis.content.unshift({ type: "text", text: `NOTE: ${src.note}` });
        }
        return analysis;
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: `Analysis failed: ${err.message}` }] };
      }
    }
  );

  server.registerTool(
    "get_frames",
    {
      title: "Zoom into a time range at full resolution",
      description:
        "Drill down after an overview: pull specific moments out of a recording at full " +
        "resolution. Give exact timestamps with `at`, or a range with from/to and let the " +
        "most-changed moments in that window be picked. This is how a long recording stays " +
        "workable — the first pass shows everything small, this shows any part of it large.",
      inputSchema: {
        session_id: z.string().optional().describe("A session from list_recordings."),
        path: z.string().optional().describe("Path to a video, GIF, or directory of stills."),
        at: z.array(z.number()).optional().describe("Exact timestamps in seconds, or offsets from after_mark."),
        from: z.number().optional().describe("Range start in seconds, or an offset from after_mark."),
        to: z.number().optional().describe("Range end in seconds, or an offset from after_mark."),
        after_mark: z.union([z.string(), z.number().int().min(1)]).optional().describe(
          "Read at/from/to as offsets from a mark rather than from the start of the " +
            "recording. Give a 1-based mark index or a case-insensitive substring of the " +
            "mark's note; a miss lists every mark so you can pick. With no at/from/to this " +
            "returns the 3 seconds following the mark. Session recordings only — a `path` " +
            "source has no marks."
        ),
        offset: z.number().optional().describe(
          "Seconds added to the mark before at/from/to are applied. Negative looks before " +
            "it. Default 0. Ignored without after_mark."
        ),
        max_images: z.number().int().min(1).max(7).optional().describe("How many frames to return (default 4)."),
        return_mode: z.enum(["inline", "paths"]).optional().describe("inline (default) embeds images; paths returns file paths."),
        roi: roiSchema,
      },
    },
    async (args) => {
      let src;
      try {
        src = await resolveSource(args);
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: err.message }] };
      }

      const plan = planImages({ maxImages: args.max_images ?? 4 });
      const budget = Math.max(1, Math.min(args.max_images ?? 4, plan.total + 1));
      const returnMode = args.return_mode ?? "inline";
      const info = await videoInfo(src.video);
      const outDir = path.join(src.outDir, "drilldown");
      fs.mkdirSync(outDir, { recursive: true });

      let roiRect = null;
      try {
        const requested = normalizeRoi(args.roi ?? null);
        if (requested === "auto") {
          // Deliberately not supported here. "auto" is derived from what changed across
          // a whole recording; asking for it while drilling into three frames would
          // silently answer a different question.
          throw new Error(
            'roi:"auto" needs a whole recording to derive a region from. Call ' +
              "analyze_recording with roi:\"auto\" to get the region, then pass that " +
              "explicit rect here."
          );
        }
        if (requested && !info.width) {
          throw new Error(
            "roi was requested but the frame size of this recording could not be read, " +
              "so there is nothing to crop against. Re-run without roi."
          );
        }
        roiRect = requested;
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: err.message }] };
      }
      const roiFilter = roiRect ? cropFilter(roiRect, info) : null;

      // A mark turns at/from/to into offsets from that moment, which removes the
      // hand-computed arithmetic — and the off-by-a-bit misses that came with it —
      // from "give me 1.5s after the third mark".
      let origin;
      try {
        if (args.after_mark != null && !args.session_id) {
          throw new Error(
            "after_mark only works on recordings made by this plugin, because marks live " +
              "in the session's event log. This call used a file path, which has none. " +
              "Pass session_id (see list_recordings), or use absolute at/from/to."
          );
        }
        origin = resolveTimeOrigin({
          afterMark: args.after_mark ?? null,
          offset: args.offset ?? 0,
          at: args.at ?? null,
          from: args.from ?? null,
          to: args.to ?? null,
          events: src.events,
          duration: info.duration ?? null,
        });
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: err.message }] };
      }

      const relativeTo = origin.mark
        ? ` (relative to mark ${origin.mark.index} "${origin.mark.note}" at t=${origin.mark.t.toFixed(2)}s` +
          `${origin.offset ? ` plus an offset of ${origin.offset}s` : ""})`
        : "";

      let picks = [];
      let how = "";

      if (origin.at?.length) {
        picks = origin.at.slice(0, budget).map((t) => ({ t, reasons: ["requested"] }));
        how = `${picks.length} requested timestamp(s)${relativeTo}`;
      } else {
        const from = origin.from ?? 0;
        const to = origin.to ?? info.duration ?? null;
        const raw = await sampleGrayFrames(src.video, { sampleFps: 6, from, to });
        if (!raw.length) {
          return {
            isError: true,
            content: [{ type: "text", text: `No frames in range ${from.toFixed(2)}–${to?.toFixed(2) ?? "end"}s.` }],
          };
        }
        const scored = scoreFrames(raw);
        const { frames } = selectKeyframes(scored, { events: src.events, maxFrames: budget });
        picks = frames.slice(0, budget);
        how =
          `${picks.length} most-changed moment(s) between ${from.toFixed(2)}s and ` +
          `${(to ?? info.duration ?? 0).toFixed(2)}s${relativeTo}`;
      }

      const content = [{
        type: "text",
        text:
          `FULL-RESOLUTION FRAMES — ${how} from ${path.basename(src.video)}` +
          (roiRect ? `\n${describeRoi(roiRect, info)}` : "") +
          (src.note ? `\nNOTE: ${src.note}` : ""),
      }];

      const cropTag = roiRect ? `${roiCaptionTag(roiRect, info)} ` : "";
      const produced = [];
      for (const p of picks) {
        // The crop is part of the identity of the file: without it, drilling into the
        // same moment cropped and uncropped would overwrite one with the other.
        const suffix = roiRect ? `-crop${Math.round(roiRect.x * 100)}_${Math.round(roiRect.y * 100)}` : "";
        const file = path.join(outDir, `at-${p.t.toFixed(2).replace(".", "_")}s${suffix}.jpg`);
        try {
          await extractFrame(src.video, p.t, file, { maxLongEdge: 1456, quality: 2, roiFilter });
        } catch (err) {
          content.push({ type: "text", text: `t=${p.t.toFixed(2)}s — could not extract: ${err.message}` });
          continue;
        }
        const fitted = await fitToBytes(file, { maxLongEdge: 1456 });
        // Absolute time first: that is what every other tool here cites, and what a
        // finding has to be reported in. The offset is the convenience, not the truth.
        const rel = origin.mark
          ? ` (${(p.t - origin.mark.t >= 0 ? "+" : "") + (p.t - origin.mark.t).toFixed(2)}s from mark ` +
            `${origin.mark.index} "${origin.mark.note}")`
          : "";
        content.push({
          type: "text",
          text: `${cropTag}t=${p.t.toFixed(2)}s${rel}${p.reasons ? ` · ${p.reasons.join(", ")}` : ""}`,
        });
        content.push(
          returnMode === "paths"
            ? { type: "text", text: `[image on disk] ${fitted.path}` }
            : { type: "image", data: readAsBase64(fitted.path), mimeType: "image/jpeg" }
        );
        produced.push({ t: p.t, path: fitted.path });
      }

      return {
        content,
        structuredContent: {
          video: src.video,
          frames: produced,
          durationSec: info.duration,
          roi: { applied: Boolean(roiRect), rect: roiRect },
          origin: {
            mark: origin.mark,
            offset: origin.offset,
            absoluteFrom: origin.from,
            absoluteTo: origin.to,
          },
        },
      };
    }
  );
}
