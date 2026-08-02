import fs from "node:fs";
import path from "node:path";
import { ffmpeg, ffmpegRaw, probeDuration, probeSize } from "../env/ffmpeg.mjs";

// Measured, not guessed: at 64x64 a 64px spinner inside a 3000px-wide window moved
// the frame difference by 0.0003 — indistinguishable from noise. 128x128 puts each
// sample pixel at roughly 23x16 source pixels, which is fine enough for a spinner,
// a toast or a small modal to register. Memory stays modest: ~16 KB per sampled
// frame, so ~39 MB for a ten-minute recording at 4 fps.
export const SAMPLE_W = 128;
export const SAMPLE_H = 128;

/**
 * Decode the whole recording once into a flat buffer of tiny greyscale frames.
 *
 * Everything downstream (delta scoring, dedupe, selection) works on these, which
 * keeps analysis of a ten-minute recording to a single decode pass and a couple of
 * megabytes of memory instead of thousands of JPEGs on disk.
 */
export async function sampleGrayFrames(video, { sampleFps = 4, from = 0, to = null } = {}) {
  const args = [];
  if (from > 0) args.push("-ss", String(from));
  args.push("-i", video);
  if (to != null) args.push("-t", String(Math.max(0.1, to - from)));
  args.push(
    "-vf", `fps=${sampleFps},scale=${SAMPLE_W}:${SAMPLE_H},format=gray`,
    "-f", "rawvideo",
    "-pix_fmt", "gray",
    "-"
  );

  const raw = await ffmpegRaw(args);
  const frameBytes = SAMPLE_W * SAMPLE_H;
  const count = Math.floor(raw.length / frameBytes);
  const frames = [];
  for (let i = 0; i < count; i++) {
    frames.push({
      index: i,
      t: from + i / sampleFps,
      pixels: raw.subarray(i * frameBytes, (i + 1) * frameBytes),
    });
  }
  return frames;
}

/** Extract one full-resolution still at an exact timestamp. */
export async function extractFrame(video, t, outPath, { maxLongEdge = null, quality = 3 } = {}) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const filters = [];
  if (maxLongEdge) {
    // Only ever downscale; upscaling a small window wastes tokens on nothing.
    filters.push(
      `scale='if(gt(iw,ih),min(iw,${maxLongEdge}),-2)':'if(gt(iw,ih),-2,min(ih,${maxLongEdge}))'`
    );
  }
  const args = ["-ss", String(Math.max(0, t)), "-i", video, "-frames:v", "1"];
  if (filters.length) args.push("-vf", filters.join(","));
  args.push("-q:v", String(quality), "-y", outPath);
  await ffmpeg(args);
  if (!fs.existsSync(outPath)) throw new Error(`failed to extract frame at t=${t}`);
  return outPath;
}

/**
 * Re-encode until the file fits a byte budget.
 *
 * Claude Code charges a flat 1600 tokens per MCP image regardless of size, so the
 * only reason to keep bytes down is transport and the per-image size cap — hence a
 * simple quality ladder rather than anything cleverer.
 */
export async function fitToBytes(imgPath, { maxBytes = 180_000, maxLongEdge = 1456 } = {}) {
  const ladder = [
    { q: 3, edge: maxLongEdge },
    { q: 6, edge: maxLongEdge },
    { q: 9, edge: Math.round(maxLongEdge * 0.85) },
    { q: 12, edge: Math.round(maxLongEdge * 0.7) },
    { q: 16, edge: Math.round(maxLongEdge * 0.55) },
  ];
  let size = fs.statSync(imgPath).size;
  if (size <= maxBytes) return { path: imgPath, bytes: size, reencoded: false };

  const tmp = imgPath.replace(/\.jpg$/, "") + ".fit.jpg";
  for (const step of ladder) {
    await ffmpeg([
      "-i", imgPath,
      "-vf", `scale='min(iw,${step.edge})':-2`,
      "-q:v", String(step.q),
      "-y", tmp,
    ]);
    size = fs.statSync(tmp).size;
    if (size <= maxBytes) break;
  }
  fs.renameSync(tmp, imgPath);
  return { path: imgPath, bytes: fs.statSync(imgPath).size, reencoded: true };
}

export async function videoInfo(file) {
  const [duration, size] = await Promise.all([probeDuration(file), probeSize(file)]);
  return { duration, ...(size || { width: null, height: null }) };
}

export function readAsBase64(p) {
  return fs.readFileSync(p).toString("base64");
}
