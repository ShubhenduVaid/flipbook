import fs from "node:fs";
import path from "node:path";
import { ffmpeg } from "../env/ffmpeg.mjs";

const FONT_CANDIDATES = [
  "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
  "/System/Library/Fonts/Supplemental/Arial.ttf",
  "/System/Library/Fonts/Supplemental/Courier New Bold.ttf",
  "/Library/Fonts/Arial.ttf",
  "/System/Library/Fonts/Geneva.ttf",
];

let fontCache;
export function resolveFont() {
  if (fontCache !== undefined) return fontCache;
  fontCache = FONT_CANDIDATES.find((f) => fs.existsSync(f)) || null;
  return fontCache;
}

/** drawtext treats these as syntax; a stray colon silently breaks the filtergraph. */
function esc(text) {
  return String(text)
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "’")
    .replace(/%/g, "\\%");
}

/**
 * One labelled cell. The timestamp is burned into the pixels rather than described
 * in text, because a grid of unlabelled thumbnails is unusable to the model — it can
 * see something changed but cannot say when.
 */
async function renderCell(video, frame, outPath, { cellW, cellH, ordinal }) {
  const font = resolveFont();
  const filters = [`scale=${cellW}:${cellH}:force_original_aspect_ratio=decrease`,
                   `pad=${cellW}:${cellH}:(ow-iw)/2:(oh-ih)/2:color=0x101010`];

  if (frame.anomalous) {
    filters.push(`drawbox=x=0:y=0:w=iw:h=ih:color=0xE5484D@0.95:t=5`);
  }
  if (font) {
    // Clamped rather than purely proportional: a two-cell sheet has enormous cells,
    // and a label scaled to them covers the screenshot it is supposed to annotate.
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));
    const titleSize = clamp(cellW / 24, 13, 26);
    const whySize = clamp(cellW / 32, 11, 18);

    const label = esc(`${String(ordinal).padStart(2, "0")}  t=${frame.t.toFixed(2)}s`);
    filters.push(
      `drawtext=fontfile=${font}:text='${label}':fontcolor=white:fontsize=${titleSize}` +
        `:box=1:boxcolor=0x000000@0.7:boxborderw=5:x=10:y=10`
    );
    if (frame.reasons?.length) {
      const why = esc(frame.reasons.slice(0, 2).join(", ").slice(0, 40));
      filters.push(
        `drawtext=fontfile=${font}:text='${why}':fontcolor=0xC9D1D9:fontsize=${whySize}` +
          `:box=1:boxcolor=0x000000@0.6:boxborderw=4:x=10:y=h-th-10`
      );
    }
  }

  await ffmpeg([
    "-ss", String(Math.max(0, frame.t)),
    "-i", video,
    "-frames:v", "1",
    "-vf", filters.join(","),
    "-q:v", "4",
    "-y", outPath,
  ]);
  return outPath;
}

async function renderBlank(outPath, { cellW, cellH }) {
  await ffmpeg([
    "-f", "lavfi",
    "-i", `color=c=0x101010:s=${cellW}x${cellH}`,
    "-frames:v", "1",
    "-q:v", "8",
    "-y", outPath,
  ]);
  return outPath;
}

/**
 * Tile keyframes into one image. This is the highest-value item in the whole result:
 * the entire timeline for the price of a single image out of a budget of about seven.
 */
export async function buildContactSheet(video, frames, outDir, {
  targetWidth = 1456,
  videoAspect = 1.5,
  padding = 6,
} = {}) {
  if (!frames.length) return null;
  fs.mkdirSync(outDir, { recursive: true });

  const n = frames.length;
  const cols = Math.min(4, Math.ceil(Math.sqrt(n)));
  const rows = Math.ceil(n / cols);

  let cellW = Math.floor((targetWidth - padding * (cols + 1)) / cols);
  cellW = Math.max(220, cellW - (cellW % 2));
  let cellH = Math.round(cellW / videoAspect);
  cellH = cellH - (cellH % 2);

  const cellDir = path.join(outDir, "cells");
  fs.rmSync(cellDir, { recursive: true, force: true });
  fs.mkdirSync(cellDir, { recursive: true });

  for (let i = 0; i < n; i++) {
    await renderCell(video, frames[i], path.join(cellDir, `cell_${String(i).padStart(3, "0")}.jpg`), {
      cellW,
      cellH,
      ordinal: i + 1,
    });
  }
  // tile expects a full grid; without filler the last row can be dropped entirely.
  for (let i = n; i < cols * rows; i++) {
    await renderBlank(path.join(cellDir, `cell_${String(i).padStart(3, "0")}.jpg`), { cellW, cellH });
  }

  const sheetPath = path.join(outDir, "contact-sheet.jpg");
  await ffmpeg([
    "-framerate", "1",
    "-i", path.join(cellDir, "cell_%03d.jpg"),
    "-vf", `tile=${cols}x${rows}:padding=${padding}:margin=${padding}:color=0x1C1C1C`,
    "-frames:v", "1",
    "-q:v", "3",
    "-y", sheetPath,
  ]);

  fs.rmSync(cellDir, { recursive: true, force: true });
  return { path: sheetPath, cols, rows, cellW, cellH, count: n };
}
