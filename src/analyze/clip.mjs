import fs from "node:fs";
import path from "node:path";
import { ffmpeg } from "../env/ffmpeg.mjs";
import { longEdgeScale } from "./frames.mjs";
import { resolveMark } from "./timeline.mjs";

/**
 * A short clip of the recording, for a human.
 *
 * The skill docs are right that a GIF adds no information Claude did not already have —
 * the vision API reads only its first frame. But that framing misses a real use: after
 * validating something, the useful thing to hand back to the person who asked is a few
 * seconds of the fixed behaviour, not a paragraph describing stills. Until now those
 * frames lived inside a session directory and had to be described in prose.
 *
 * So this is deliberately not evidence. It costs no image budget, it is never cropped by
 * `roi` (a human wants the context a crop removes), and its description says plainly
 * that it shows Claude nothing.
 */
export const CLIP_LIMITS = {
  maxSeconds: 30,
  defaultSeconds: 6,
  maxBytes: { mp4: 8_000_000, gif: 6_000_000 },
  defaultFps: { mp4: 12, gif: 8 },
  defaultWidth: 720,
};

/** Pure: turn a clip spec plus the event log into an absolute range. */
export function resolveClipRange(clip, { events = [], duration = null } = {}) {
  if (!clip || typeof clip !== "object") throw new Error("clip must be an object");

  let from;
  let label;
  if (clip.mark != null) {
    const mark = resolveMark(events, clip.mark);
    from = mark.t;
    label = `mark ${mark.index} "${mark.note}"`;
  } else {
    from = clip.from ?? 0;
    label = null;
  }

  let to;
  if (clip.to_mark != null) {
    const end = resolveMark(events, clip.to_mark);
    if (end.t <= from) {
      throw new Error(
        `clip.to_mark "${clip.to_mark}" is at t=${end.t.toFixed(2)}s, which is not after ` +
          `the start at t=${from.toFixed(2)}s. Swap them, or use clip.to for a duration.`
      );
    }
    to = end.t;
    label = label ? `${label} → mark ${end.index} "${end.note}"` : null;
  } else if (clip.to != null) {
    // Relative when a mark set the origin, absolute otherwise — the same rule get_frames
    // uses, so the two cannot mean different things by the same argument.
    to = clip.mark != null ? from + clip.to : clip.to;
  } else {
    to = from + CLIP_LIMITS.defaultSeconds;
  }

  from = Math.max(0, from);
  if (duration != null) to = Math.min(to, duration);
  if (to <= from) {
    throw new Error(
      `clip range is empty: ${from.toFixed(2)}s to ${to.toFixed(2)}s` +
        (duration != null ? ` in a ${duration.toFixed(2)}s recording` : "")
    );
  }

  // Trim rather than refuse. A range that is too long is a reasonable request with an
  // unreasonable size, and half of it is more use than an error.
  const requested = to - from;
  const clamped = requested > CLIP_LIMITS.maxSeconds;
  if (clamped) to = from + CLIP_LIMITS.maxSeconds;

  return {
    from: Number(from.toFixed(2)),
    to: Number(to.toFixed(2)),
    seconds: Number((to - from).toFixed(2)),
    requestedSeconds: Number(requested.toFixed(2)),
    label,
    clamped,
  };
}

async function encode(video, outPath, { from, seconds, format, fps, width }) {
  if (format === "gif") {
    // paletteuse takes two inputs, so this has to be -lavfi rather than -vf. Generating
    // the palette from the clip's own frames, weighted toward what changes, is a visible
    // quality difference on UI footage: a mostly-static page with one moving region.
    const palette = `${outPath}.palette.png`;
    try {
      await ffmpeg([
        "-ss", String(from), "-i", video, "-t", String(seconds),
        "-vf", `fps=${fps},scale=${width}:-2:flags=lanczos,palettegen=stats_mode=diff`,
        "-y", palette,
      ]);
      await ffmpeg([
        "-ss", String(from), "-i", video, "-t", String(seconds), "-i", palette,
        "-lavfi",
        `fps=${fps},scale=${width}:-2:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3`,
        "-loop", "0", "-y", outPath,
      ]);
    } finally {
      // Otherwise it inflates the very footprint the next commit is about measuring.
      fs.rmSync(palette, { force: true });
    }
    return;
  }

  await ffmpeg([
    "-ss", String(from), "-i", video, "-t", String(seconds),
    "-vf", `fps=${fps},${longEdgeScale(width)}`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "30",
    "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    // sckrec writes no audio track, but a user-supplied path might.
    "-an",
    "-y", outPath,
  ]);
}

/**
 * Encode the clip, shrinking once if it comes out too large.
 *
 * Deliberately not `fitToBytes`: that targets 180 KB and renames the fitted file over the
 * original, which is right for a still and wrong for something a person will watch.
 */
export async function exportClip(video, outPath, { from, to, format = "mp4", fps = null, width = null }) {
  const seconds = to - from;
  let useFps = fps ?? CLIP_LIMITS.defaultFps[format];
  let useWidth = width ?? CLIP_LIMITS.defaultWidth;

  await encode(video, outPath, { from, seconds, format, fps: useFps, width: useWidth });
  let bytes = fs.statSync(outPath).size;
  let downscaled = false;

  if (bytes > CLIP_LIMITS.maxBytes[format]) {
    useWidth = Math.max(160, Math.round(useWidth * 0.6));
    useFps = Math.max(1, Math.round(useFps * 0.6));
    await encode(video, outPath, { from, seconds, format, fps: useFps, width: useWidth });
    bytes = fs.statSync(outPath).size;
    downscaled = true;
  }

  return {
    path: outPath,
    bytes,
    format,
    from,
    to,
    seconds: Number(seconds.toFixed(2)),
    fps: useFps,
    width: useWidth,
    downscaled,
    oversized: bytes > CLIP_LIMITS.maxBytes[format],
  };
}

/** The description that goes on the resource link, saying what the clip is not. */
export function clipDescription(clip, range) {
  const mb = (clip.bytes / 1e6).toFixed(1);
  return (
    `Shareable clip: ${clip.from.toFixed(2)}s–${clip.to.toFixed(2)}s (${clip.seconds.toFixed(1)}s) ` +
    `as ${clip.format}, ${clip.width}px wide, ${mb} MB` +
    `${range?.label ? `, covering ${range.label}` : ""}. ` +
    `${range?.clamped ? `Trimmed from the ${range.requestedSeconds.toFixed(1)}s requested, which is over the ${CLIP_LIMITS.maxSeconds}s cap. ` : ""}` +
    `${clip.oversized ? "Larger than intended — the range may be long or very busy. " : ""}` +
    `This is a file for a human to open and share. You cannot watch it, and it holds no ` +
    `evidence beyond the frames above. It is never cropped by \`roi\`: it shows the whole window.`
  );
}

/** Where a clip lives, named so two different ranges do not overwrite each other. */
export function clipPath(outDir, { from, to, format }) {
  const stamp = (n) => n.toFixed(1).replace(".", "_");
  return path.join(outDir, `clip-${stamp(from)}s-${stamp(to)}s.${format}`);
}
