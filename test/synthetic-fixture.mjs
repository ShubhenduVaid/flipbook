/**
 * A deterministic stand-in for test/fixtures/spinner-toast.html, drawn by ffmpeg alone.
 *
 *   node test/synthetic-fixture.mjs [out.mp4]
 *
 * The real fixture needs macOS, Chrome and Screen Recording permission to record, so the
 * analysis path was only ever exercised end to end on a developer's machine. This
 * renders the same story — blank tab, page load, spinner, confirmation panel, a toast
 * that appears in the corner and vanishes — with no browser and no font, so CI can run
 * the whole server against it on every push.
 *
 * It is deliberately a viewport-only video, like a Playwright or Cypress recording: no
 * browser chrome pins the content to the frame edges, which is exactly the shape that
 * once made a corner toast read as a capture fault.
 */
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { ffmpeg } from "../src/env/ffmpeg.mjs";

/** When each state is on screen, in seconds. Tests assert keyframes land inside these. */
export const SCHEDULE = {
  duration: 10,
  loaded: 0.5,
  spinner: [1.5, 3.5],
  panel: [3.5, 10],
  toast: [5.5, 7.0],
};

const between = (a, b) => `between(t\\,${a}\\,${b})`;

export async function makeSyntheticFixture(outPath) {
  const S = SCHEDULE;
  const [s0, s1] = S.spinner;
  const [t0, t1] = S.toast;
  const box = (x, y, w, h, colour, enable) =>
    `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=${colour}:t=fill:enable='${enable}'`;

  const filters = [
    // about:blank, then the page's dark background
    box(0, 0, 1280, 800, "0xFFFFFF", `lt(t\\,${S.loaded})`),
    // the card, short while submitting, tall once the order is confirmed
    box(380, 300, 520, 110, "0x181B22", `${between(S.loaded, S.panel[0])}`),
    box(410, 325, 200, 14, "0xE6E6E6", `gte(t\\,${S.loaded})`),
    box(380, 250, 520, 300, "0x181B22", `gte(t\\,${S.panel[0]})`),
    box(410, 275, 200, 14, "0xE6E6E6", `gte(t\\,${S.panel[0]})`),
    // spinner: two quarter-arcs alternating every 0.25s, so consecutive samples differ
    box(608, 330, 32, 32, "0x4C8DFF", `${between(s0, s1)}*lt(mod(t\\,0.5)\\,0.25)`),
    box(640, 362, 32, 32, "0x4C8DFF", `${between(s0, s1)}*gte(mod(t\\,0.5)\\,0.25)`),
    // confirmation panel with three rows
    box(410, 320, 460, 200, "0x10331F", `gte(t\\,${S.panel[0]})`),
    box(430, 340, 160, 12, "0x6EE7A0", `gte(t\\,${S.panel[0]})`),
    box(430, 385, 420, 10, "0x9AA4B2", `gte(t\\,${S.panel[0]})`),
    box(430, 425, 420, 10, "0x9AA4B2", `gte(t\\,${S.panel[0]})`),
    box(430, 465, 420, 10, "0x9AA4B2", `gte(t\\,${S.panel[0]})`),
    // the toast, top right, gone before the run ends
    box(1030, 28, 222, 58, "0x1F6FEB", between(t0, t1)),
    box(1052, 50, 150, 14, "0xFFFFFF", between(t0, t1)),
  ];

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  await ffmpeg([
    "-f", "lavfi",
    "-i", `color=c=0x0F1115:s=1280x800:r=25:d=${S.duration}`,
    "-vf", filters.join(","),
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast",
    "-y", outPath,
  ]);
  return outPath;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = path.resolve(process.argv[2] ?? ".fixture-out/synthetic/run.mp4");
  await makeSyntheticFixture(out);
  console.log(`wrote ${out}`);
}
