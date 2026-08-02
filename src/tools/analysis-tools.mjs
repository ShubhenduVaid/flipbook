import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { readMeta, readEvents, videoPath, framesDir } from "../capture/session.mjs";
import { analyzeVideo } from "../analyze/analyze.mjs";
import { alignEvents } from "../analyze/timeline.mjs";
import { resolveInput } from "../analyze/input.mjs";
import { sampleGrayFrames, extractFrame, fitToBytes, videoInfo, readAsBase64 } from "../analyze/frames.mjs";
import { scoreFrames } from "../analyze/delta.mjs";
import { selectKeyframes } from "../analyze/select.mjs";
import { planImages } from "../analyze/budget.mjs";

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
        at: z.array(z.number().min(0)).optional().describe("Exact timestamps in seconds."),
        from: z.number().min(0).optional().describe("Range start in seconds."),
        to: z.number().min(0).optional().describe("Range end in seconds."),
        max_images: z.number().int().min(1).max(7).optional().describe("How many frames to return (default 4)."),
        return_mode: z.enum(["inline", "paths"]).optional().describe("inline (default) embeds images; paths returns file paths."),
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

      let picks = [];
      let how = "";

      if (args.at?.length) {
        picks = args.at.slice(0, budget).map((t) => ({ t, reasons: ["requested"] }));
        how = `${picks.length} requested timestamp(s)`;
      } else {
        const from = args.from ?? 0;
        const to = args.to ?? info.duration ?? null;
        const raw = await sampleGrayFrames(src.video, { sampleFps: 6, from, to });
        if (!raw.length) {
          return {
            isError: true,
            content: [{ type: "text", text: `No frames in range ${from}–${to ?? "end"}s.` }],
          };
        }
        const scored = scoreFrames(raw);
        const { frames } = selectKeyframes(scored, { events: src.events, maxFrames: budget });
        picks = frames.slice(0, budget);
        how = `${picks.length} most-changed moment(s) between ${from.toFixed(2)}s and ${(to ?? info.duration ?? 0).toFixed(2)}s`;
      }

      const content = [{
        type: "text",
        text:
          `FULL-RESOLUTION FRAMES — ${how} from ${path.basename(src.video)}` +
          (src.note ? `\nNOTE: ${src.note}` : ""),
      }];

      const produced = [];
      for (const p of picks) {
        const file = path.join(outDir, `at-${p.t.toFixed(2).replace(".", "_")}s.jpg`);
        try {
          await extractFrame(src.video, p.t, file, { maxLongEdge: 1456, quality: 2 });
        } catch (err) {
          content.push({ type: "text", text: `t=${p.t.toFixed(2)}s — could not extract: ${err.message}` });
          continue;
        }
        const fitted = await fitToBytes(file, { maxLongEdge: 1456 });
        content.push({
          type: "text",
          text: `t=${p.t.toFixed(2)}s${p.reasons ? ` · ${p.reasons.join(", ")}` : ""}`,
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
        structuredContent: { video: src.video, frames: produced, durationSec: info.duration },
      };
    }
  );
}
