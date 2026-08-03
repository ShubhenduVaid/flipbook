import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ffmpeg } from "../env/ffmpeg.mjs";
import { IMPORTS_DIR } from "../env/paths.mjs";

export const VIDEO_EXTS = new Set([".mov", ".mp4", ".m4v", ".webm", ".gif", ".mkv", ".avi"]);
export const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tiff"]);

function workDirFor(input) {
  const h = crypto.createHash("sha1").update(path.resolve(input)).digest("hex").slice(0, 10);
  return path.join(IMPORTS_DIR, `${path.basename(input).replace(/[^\w.-]/g, "_")}-${h}`);
}

/**
 * Accept whatever the user has: a video, an animated GIF, or a directory of stills.
 *
 * GIFs matter more than they look. Claude can only ever see a GIF's first frame, so a
 * GIF produced by Claude in Chrome's gif_creator is useless as evidence on its own —
 * but ffmpeg decodes every frame, which turns one into real evidence here.
 */
export async function resolveInput(input, { stillsFps = 4 } = {}) {
  const resolved = path.resolve(input.replace(/^file:\/\//, ""));
  if (!fs.existsSync(resolved)) throw new Error(`not found: ${resolved}`);

  const stat = fs.statSync(resolved);

  if (stat.isDirectory()) {
    const files = fs
      .readdirSync(resolved)
      .filter((f) => IMAGE_EXTS.has(path.extname(f).toLowerCase()))
      .sort();
    if (!files.length) throw new Error(`no images found in directory: ${resolved}`);

    const work = workDirFor(resolved);
    fs.mkdirSync(work, { recursive: true });
    const listFile = path.join(work, "stills.txt");
    // concat demuxer keeps arbitrary filenames working, unlike %03d patterns.
    fs.writeFileSync(
      listFile,
      files
        .map((f) => `file '${path.join(resolved, f).replace(/'/g, "'\\''")}'\nduration ${1 / stillsFps}`)
        .join("\n") + `\nfile '${path.join(resolved, files[files.length - 1]).replace(/'/g, "'\\''")}'\n`
    );
    const out = path.join(work, "stills.mp4");
    await ffmpeg([
      "-f", "concat", "-safe", "0", "-i", listFile,
      "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=" + stillsFps,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
      "-y", out,
    ]);
    return {
      video: out,
      workDir: work,
      kind: "stills",
      note: `${files.length} stills assembled at ${stillsFps} fps; timestamps are synthetic (image N is at N/${stillsFps}s).`,
    };
  }

  const ext = path.extname(resolved).toLowerCase();
  if (IMAGE_EXTS.has(ext)) {
    throw new Error(
      `${path.basename(resolved)} is a single image — pass its directory to analyse a sequence, ` +
        `or use the Read tool to just look at one picture.`
    );
  }
  if (!VIDEO_EXTS.has(ext)) {
    throw new Error(
      `unsupported file type "${ext}". Supported: ${[...VIDEO_EXTS].join(", ")}, ` +
        `or a directory of stills.`
    );
  }

  return {
    video: resolved,
    workDir: workDirFor(resolved),
    kind: ext === ".gif" ? "gif" : "video",
    note:
      ext === ".gif"
        ? "Animated GIF decoded frame by frame. Claude's vision API only ever sees a GIF's first frame, so this is the only way its later frames become usable evidence."
        : null,
  };
}
