import { z } from "zod";
import {
  createSession, updateMeta, readMeta, setActiveSession, getActiveSession,
  appendEvent, readEvents, videoPath, framesDir,
} from "../capture/session.mjs";
import { startRecording, stopRecording, isRecording, activeRecordings } from "../capture/record.mjs";
import { analyzeVideo } from "../analyze/analyze.mjs";
import { alignEvents } from "../analyze/timeline.mjs";
import { probeDuration } from "../env/ffmpeg.mjs";

export function registerCaptureTools(server) {
  server.registerTool(
    "start_recording",
    {
      title: "Start recording a browser window",
      description:
        "Begin continuously recording a window (Chrome by default) so that everything " +
        "between screenshots — spinners, layout shift, flicker, toasts that appear and " +
        "vanish, how long things took — is captured. Records the window's own content, so " +
        "it works even when the browser is behind other windows or on another Space, and " +
        "it does not interfere with Claude-in-Chrome tools. Drive the app as normal after " +
        "calling this, then call stop_recording.",
      inputSchema: {
        label: z.string().optional().describe("Short description of what is being validated."),
        target: z.enum(["chrome", "window", "display"]).optional()
          .describe("chrome (default) or window = single-window capture; display = whole screen fallback."),
        bundle_id: z.string().optional().describe("App bundle id when target is 'window'. Default com.google.Chrome."),
        window_id: z.number().int().optional().describe("Exact ScreenCaptureKit window id, from doctor output."),
        title_contains: z.string().optional().describe("Disambiguate between several windows by title substring."),
        fps: z.number().int().min(1).max(60).optional().describe("Capture framerate (default 30)."),
        max_duration_s: z.number().int().min(1).max(3600).optional()
          .describe("Hard stop after this many seconds (default 600), so a forgotten recording cannot fill the disk."),
      },
    },
    async (args) => {
      const running = activeRecordings();
      if (running.length) {
        return {
          isError: true,
          content: [{
            type: "text",
            text: `A recording is already in progress (${running.join(", ")}). Call stop_recording first.`,
          }],
        };
      }

      const target = args.target ?? "chrome";
      const fps = args.fps ?? 30;
      const maxDurationSec = args.max_duration_s ?? 600;

      const session = createSession({
        label: args.label ?? null,
        target,
        fps,
        maxDurationSec,
      });
      const out = videoPath(session.id);

      let rec;
      try {
        rec = await startRecording({
          id: session.id,
          outPath: out,
          target: target === "chrome" ? "window" : target,
          bundleId: args.bundle_id ?? "com.google.Chrome",
          windowId: args.window_id,
          titleContains: args.title_contains,
          fps,
          maxDurationSec,
        });
      } catch (err) {
        updateMeta(session.id, { status: "failed", error: err.message });
        return {
          isError: true,
          content: [{
            type: "text",
            text: `Could not start recording: ${err.message}\n\nRun doctor for a full diagnosis.`,
          }],
        };
      }

      const startedAtMs = Date.now();
      updateMeta(session.id, {
        status: "recording",
        startedAtMs,
        backend: rec.backend,
        window: rec.window
          ? {
              title: rec.window.title,
              app: rec.window.app,
              windowId: rec.window.windowId,
              width: rec.window.captureWidth,
              height: rec.window.captureHeight,
            }
          : null,
      });
      setActiveSession(session.id);
      appendEvent(session.id, { tsMs: startedAtMs, type: "recording_started" });

      const w = rec.window;
      return {
        content: [{
          type: "text",
          text:
            `Recording ${session.id}.\n` +
            (w ? `Window: "${w.title}" (${w.app}) at ${w.captureWidth}x${w.captureHeight}\n` : `Backend: ${rec.backend}\n`) +
            `Framerate ${fps}, hard stop after ${maxDurationSec}s.\n\n` +
            `Now drive the app as you normally would. Claude-in-Chrome tools are ` +
            `automatically correlated to the timeline; use mark to annotate anything else. ` +
            `Call stop_recording with a rubric when the flow is complete.`,
        }],
        structuredContent: { session_id: session.id, video_path: out, window: rec.window ?? null, backend: rec.backend },
      };
    }
  );

  server.registerTool(
    "mark",
    {
      title: "Annotate the recording timeline",
      description:
        "Add a timestamped note to the recording in progress — what you just did, or what " +
        "you expect to happen next. Notes appear in the timeline and pull nearby frames " +
        "into the keyframe selection.",
      inputSchema: {
        note: z.string().describe("What is happening at this moment."),
        session_id: z.string().optional().describe("Defaults to the recording in progress."),
      },
    },
    async ({ note, session_id }) => {
      const id = session_id ?? getActiveSession();
      if (!id || !readMeta(id)) {
        return { isError: true, content: [{ type: "text", text: "No active recording to annotate." }] };
      }
      appendEvent(id, { tsMs: Date.now(), type: "mark", note });
      return { content: [{ type: "text", text: `Marked: ${note}` }] };
    }
  );

  server.registerTool(
    "stop_recording",
    {
      title: "Stop recording and analyse it",
      description:
        "Stop the recording and return visual evidence: a labelled contact sheet of the " +
        "whole run, full-resolution frames of the moments that changed, and a timeline " +
        "correlating each moment with the actions that caused it. Supply a rubric to state " +
        "what 'working correctly' means — the evidence is returned for you to judge, never " +
        "a pass/fail verdict.",
      inputSchema: {
        session_id: z.string().optional().describe("Defaults to the recording in progress."),
        rubric: z.string().optional()
          .describe("What must be true for this flow to be correct. One criterion per line works well."),
        max_images: z.number().int().min(1).max(7).optional()
          .describe("Image budget including the contact sheet (default 6; 7 is the safe ceiling)."),
        return_mode: z.enum(["inline", "paths"]).optional()
          .describe("inline (default) embeds images; paths returns file paths to open with Read."),
        analyze: z.boolean().optional().describe("Set false to just stop and keep the file."),
      },
    },
    async ({ session_id, rubric, max_images, return_mode, analyze = true }) => {
      const id = session_id ?? getActiveSession();
      if (!id) {
        return { isError: true, content: [{ type: "text", text: "No active recording." }] };
      }
      if (!isRecording(id)) {
        const meta = readMeta(id);
        if (!meta) {
          return { isError: true, content: [{ type: "text", text: `Unknown session ${id}.` }] };
        }
        return {
          isError: true,
          content: [{
            type: "text",
            text: `Session ${id} is not recording (status: ${meta.status}). ` +
              `Use analyze_recording to re-analyse it.`,
          }],
        };
      }

      const result = await stopRecording(id);
      setActiveSession(null);
      appendEvent(id, { tsMs: Date.now(), type: "recording_stopped" });

      if (!result || result.bytes === 0) {
        updateMeta(id, { status: "failed", error: result?.error ?? "no data" });
        return {
          isError: true,
          content: [{
            type: "text",
            text:
              `Recording ${id} produced no data.\n${result?.error ?? ""}\n\n` +
              `Run doctor — this is usually Screen Recording permission or a window that ` +
              `closed mid-recording.`,
          }],
        };
      }

      const durationSec = await probeDuration(result.outPath);
      const meta = updateMeta(id, {
        status: "recorded",
        durationSec: durationSec ?? result.wallClockSec,
        bytes: result.bytes,
        stoppedAtMs: Date.now(),
      });

      if (!analyze) {
        return {
          content: [{
            type: "text",
            text: `Stopped ${id}. ${(result.bytes / 1e6).toFixed(1)} MB, ` +
              `${(durationSec ?? 0).toFixed(1)}s at ${result.outPath}`,
          }],
          structuredContent: { session_id: id, video_path: result.outPath, durationSec },
        };
      }

      const events = alignEvents(readEvents(id), meta.startedAtMs, durationSec);
      const analysis = await analyzeVideo({
        video: result.outPath,
        events,
        rubric: rubric ?? null,
        maxImages: max_images ?? 6,
        returnMode: return_mode ?? "inline",
        outDir: framesDir(id),
        label: meta.label,
      });
      updateMeta(id, { status: "analyzed" });
      return {
        ...analysis,
        structuredContent: { session_id: id, ...analysis.structuredContent },
      };
    }
  );
}
