import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ffmpeg, hasFilter } from "../env/ffmpeg.mjs";

/**
 * Recording needs macOS, but analysis runs anywhere ffmpeg does — so the label font has
 * to be found anywhere too. With only macOS paths listed, every cell on Linux rendered
 * unlabelled while the caption still promised a frame number and timestamp in each.
 */
const FONT_CANDIDATES = [
  // macOS
  "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
  "/System/Library/Fonts/Supplemental/Arial.ttf",
  "/System/Library/Fonts/Supplemental/Courier New Bold.ttf",
  "/Library/Fonts/Arial.ttf",
  "/System/Library/Fonts/Geneva.ttf",
  // Linux
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
  "/usr/share/fonts/liberation-sans/LiberationSans-Bold.ttf",
  "/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf",
  "/usr/share/fonts/noto/NotoSans-Bold.ttf",
  "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf",
  // Windows
  "C:\\Windows\\Fonts\\arialbd.ttf",
  "C:\\Windows\\Fonts\\arial.ttf",
  "C:\\Windows\\Fonts\\segoeui.ttf",
];

/** Ask fontconfig for any bold sans face — the long tail of Linux distributions. */
function fcMatch() {
  try {
    const file = execFileSync("fc-match", ["-f", "%{file}", "sans:bold"], {
      timeout: 5_000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return file && /\.(ttf|otf|ttc)$/i.test(file) && fs.existsSync(file) ? file : null;
  } catch {
    return null;
  }
}

let fontCache;
/**
 * The font the contact sheet labels are drawn in, or null when none can be found — in
 * which case cells are unlabelled and the caption has to say so. FLIPBOOK_FONT wins.
 */
export function resolveFont() {
  if (fontCache !== undefined) return fontCache;
  const override = process.env.FLIPBOOK_FONT;
  fontCache =
    (override && fs.existsSync(override) ? override : null) ||
    FONT_CANDIDATES.find((f) => fs.existsSync(f)) ||
    fcMatch() ||
    null;
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

/** ASS treats braces and backslashes as override syntax. */
function assText(text) {
  return String(text).replace(/[{}\\]/g, "");
}

/** ASS colours are &HAABBGGRR, with alpha inverted: 00 is opaque. */
function assColour(rgb, opacity = 1) {
  const a = Math.round((1 - opacity) * 255).toString(16).padStart(2, "0");
  const [r, g, b] = [rgb.slice(0, 2), rgb.slice(2, 4), rgb.slice(4, 6)];
  return `&H${a}${b}${g}${r}`.toUpperCase();
}

/**
 * The same three labels as the drawtext path, as a one-cell subtitle file. Style fields
 * follow the V4+ format line exactly; BorderStyle 3 draws an opaque box behind the text.
 */
function assLabels({ cellW, cellH, title, why, crop, titleSize, whySize }) {
  const style = (name, size, fg, bgOpacity, align) =>
    `Style: ${name},sans-serif,${size},${assColour(fg)},${assColour(fg)},` +
    `${assColour("000000", bgOpacity)},${assColour("000000", bgOpacity)},-1,0,0,0,100,100,0,0,3,4,0,` +
    `${align},10,10,10,1`;
  const line = (styleName, text) => `Dialogue: 0,0:00:00.00,9:59:59.00,${styleName},,0,0,0,,${assText(text)}`;
  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${cellW}`,
    `PlayResY: ${cellH}`,
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, " +
      "Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, " +
      "Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    style("Title", titleSize, "FFFFFF", 0.7, 7),
    style("Why", whySize, "C9D1D9", 0.6, 1),
    style("Crop", whySize, "F5A623", 0.7, 9),
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    line("Title", title),
    ...(why ? [line("Why", why)] : []),
    ...(crop ? [line("Crop", "CROP")] : []),
    "",
  ].join("\n");
}

/**
 * How labels get drawn with this ffmpeg build, decided once per sheet.
 *
 * drawtext when the build has it. Otherwise libass through the subtitles filter: the
 * static Linux ffmpeg that ffmpeg-static ships has libass but no drawtext. The font is
 * copied alone into the cell directory and handed over as fontsdir, so libass cannot
 * fall back to some other face — or fail to find one because a static build has no
 * fontconfig configuration of its own.
 */
async function labelBackend(cellDir) {
  const font = resolveFont();
  if (!font) return { kind: "none", reason: "no font found" };
  if (await hasFilter("drawtext")) {
    return { kind: "drawtext", fontArg: esc(font.replace(/\\/g, "/")) };
  }
  if (await hasFilter("subtitles")) {
    const fontsDir = path.join(cellDir, "fonts");
    fs.mkdirSync(fontsDir, { recursive: true });
    fs.copyFileSync(font, path.join(fontsDir, `label${path.extname(font)}`));
    return { kind: "ass" };
  }
  return { kind: "none", reason: "this ffmpeg has neither drawtext nor subtitles" };
}

/**
 * One labelled cell. The timestamp is burned into the pixels rather than described
 * in text, because a grid of unlabelled thumbnails is unusable to the model — it can
 * see something changed but cannot say when.
 */
async function renderCell(video, frame, outPath, { cellW, cellH, ordinal, roiFilter = null, labels }) {
  const filters = [];
  if (roiFilter) filters.push(roiFilter); // before the scale, as everywhere else
  filters.push(`scale=${cellW}:${cellH}:force_original_aspect_ratio=decrease`,
               `pad=${cellW}:${cellH}:(ow-iw)/2:(oh-ih)/2:color=0x101010`);

  if (frame.anomalous) {
    filters.push(`drawbox=x=0:y=0:w=iw:h=ih:color=0xE5484D@0.95:t=5`);
  }
  // Amber, deliberately not the red of the anomaly box. A cropped cell that reads as a
  // whole page is the failure this batch's capture detectors exist to catch, so the
  // crop is stated in the pixels as well as in the header and the caption.
  if (roiFilter) {
    filters.push(`drawbox=x=0:y=0:w=iw:h=ih:color=0xF5A623@0.9:t=3`);
  }

  // Clamped rather than purely proportional: a two-cell sheet has enormous cells,
  // and a label scaled to them covers the screenshot it is supposed to annotate.
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));
  const titleSize = clamp(cellW / 24, 13, 26);
  const whySize = clamp(cellW / 32, 11, 18);
  const title = `${String(ordinal).padStart(2, "0")}  t=${frame.t.toFixed(2)}s`;
  const why = frame.reasons?.length ? frame.reasons.slice(0, 2).join(", ").slice(0, 40) : null;

  let cwd;
  if (labels.kind === "drawtext") {
    const font = labels.fontArg;
    filters.push(
      `drawtext=fontfile=${font}:text='${esc(title)}':fontcolor=white:fontsize=${titleSize}` +
        `:box=1:boxcolor=0x000000@0.7:boxborderw=5:x=10:y=10`
    );
    if (why) {
      filters.push(
        `drawtext=fontfile=${font}:text='${esc(why)}':fontcolor=0xC9D1D9:fontsize=${whySize}` +
          `:box=1:boxcolor=0x000000@0.6:boxborderw=4:x=10:y=h-th-10`
      );
    }
    if (roiFilter) {
      filters.push(
        `drawtext=fontfile=${font}:text='CROP':fontcolor=0xF5A623:fontsize=${whySize}` +
          `:box=1:boxcolor=0x000000@0.7:boxborderw=4:x=w-tw-10:y=10`
      );
    }
  } else if (labels.kind === "ass") {
    // Relative names with ffmpeg run from the cell directory, so no path — whatever
    // FLIPBOOK_HOME contains — ever has to survive filtergraph escaping.
    const assName = `${path.basename(outPath, ".jpg")}.ass`;
    cwd = path.dirname(outPath);
    fs.writeFileSync(
      path.join(cwd, assName),
      assLabels({ cellW, cellH, title, why, crop: Boolean(roiFilter), titleSize, whySize })
    );
    filters.push(`subtitles=filename=${assName}:fontsdir=fonts`);
  }

  await ffmpeg([
    "-ss", String(Math.max(0, frame.t)),
    "-i", video,
    "-frames:v", "1",
    "-vf", filters.join(","),
    "-q:v", "4",
    "-y", outPath,
  ], { cwd });
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
  roiFilter = null,
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

  const labels = await labelBackend(cellDir);
  for (let i = 0; i < n; i++) {
    await renderCell(video, frames[i], path.join(cellDir, `cell_${String(i).padStart(3, "0")}.jpg`), {
      cellW,
      cellH,
      ordinal: i + 1,
      roiFilter,
      labels,
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
  return { path: sheetPath, cols, rows, cellW, cellH, count: n, labelled: labels.kind !== "none", labelProblem: labels.reason ?? null };
}
