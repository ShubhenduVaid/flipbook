# Architecture

## The constraint everything follows from

Claude cannot watch video. There is no video input, animated GIFs are read as their first
frame only, and the MCP specification has no video content type (checked in both
`2025-06-18` and `2026-07-28`). So a recording has to be converted into **stills plus
text**, and the conversion has a hard budget:

| | |
|---|---|
| Cost per MCP image | flat **1600 tokens**, whatever its dimensions |
| MCP output budget | **25,000** tokens (`MAX_MCP_OUTPUT_TOKENS`) |
| Never-truncated zone | **50%** of that → a working ceiling of **12,500** |

Roughly seven images, or six plus a few thousand characters of text. Every design choice
below is downstream of that number: which moments are worth an image, how many, and what
has to be said in text instead.

The second constraint is what makes the tool possible at all. Claude drives the browser in
the background while you read the terminal, so the recorder must capture a **window's own
content**, not the composited screen.

## Pipeline

```
start_recording ─► sckrec (ScreenCaptureKit) ─► video.mov
                        │
   Claude drives the browser; the PostToolUse hook
   appends each action to events.jsonl
                        │
stop_recording ─► sample ─► score ─► select ─► render ─► budget ─► MCP response
                    │        │        │         │          │
                 128×128   global   settled   contact    header +
                  greys   + local   frames     sheet     timeline
                          per-block  wins    + details    + link
```

1. **Sample.** One ffmpeg pass decodes the whole recording into 128×128 greyscale frames at
   4 fps. Everything downstream works on these — a ten-minute recording is ~39 MB of memory
   instead of thousands of JPEGs.
2. **Score.** Each frame is compared with its predecessor two ways, and the larger wins.
3. **Select.** Choose the moments worth spending an image on.
4. **Render.** Extract those frames at full resolution and tile a labelled contact sheet.
5. **Budget.** Fit everything — images, captions, header, timeline — inside the ceiling.

## Why two scores, and why 128×128

Whole-frame differencing misses exactly what this tool exists to catch. Measured on the
bundled fixture: at 64×64 a 64-pixel spinner inside a 3000-pixel-wide window moved the
frame average by **0.0003** — indistinguishable from noise.

So sampling is 128×128, and each frame gets:

- a **global** score (mean absolute difference + changed area) — navigation, layout shift;
- a **local** score (largest per-block difference over a 16×16 grid) — a spinner, a toast,
  a modal, which saturate one block while barely moving the average.

`delta = max(global, local)`.

Deduplication compares **pixels**, not perceptual hashes. A dHash of a mostly-dark page is
near-constant: the measured Hamming distance between an idle page and the same page showing
a spinner was **0**, so hash-based dedupe discarded precisely the frames worth keeping.

When two frames do show the same thing, the **earlier** one wins and inherits the later
one's reasons. A result panel at 3.75s is pixel-identical to the final frame at 8s; keeping
the later one throws away the only interesting fact, which is when the state was reached.

## Budgeting the response

The response carries more text than the two obvious blocks: a caption per image and the
resource-link description. Budgeting only the header and timeline let a real payload exceed
the ceiling it advertises, and a caller-supplied rubric over ~11,000 characters removed the
timeline from the response **entirely** — the densest evidence channel, gone silently.

So `allocateText` takes the fixed text as an input and gives the timeline a guaranteed
floor. A rubric of any length now trims the *header* — an echo of what the caller already
sent — while the timeline survives. Both blocks say in-band when they were cut.

## Two backends

| | Window capture (default) | Display capture (fallback) |
|---|---|---|
| How | `sckrec`, ScreenCaptureKit | ffmpeg + avfoundation |
| Captures | one window's own content | the composited screen |
| Occluded window | works | records whatever is on top |
| Retina / crop maths | none needed | required |
| Needs | macOS 15+ | any macOS |

Window capture is the default because display capture records the terminal rather than the
browser in the exact situation the tool is built for. It also removes retina scaling and
crop arithmetic, and never captures anything but the target window.

`sckrec` must run its AppKit main loop via `NSApplication.run()`. ScreenCaptureKit puts the
purple capture indicator in the menu bar, and building it instantiates an `NSWindow`, which
AppKit requires on a real main thread — under `dispatchMain()` it throws mid-capture and
leaves an unfinalised file with no `moov` atom.

## Modules

### `src/env/` — the machine

| File | Owns |
|---|---|
| `paths.mjs` | `FLIPBOOK_HOME`, plugin root, session directories, and the session-id validation every path derives from |
| `ffmpeg.mjs` | Resolving ffmpeg, repairing the bundled binary, running it, probing duration and size, listing avfoundation devices |
| `native.mjs` | Compiling `sckrec` on demand, listing windows, choosing which window a request means |
| `chrome.mjs` | Asking Chrome which window it considers frontmost, via its own scripting dictionary |
| `doctor.mjs` | Every preflight check, and the two blank-recording traps |

### `src/capture/` — getting pixels

| File | Owns |
|---|---|
| `session.mjs` | Session lifecycle: create, read, update, list, the active-session pointer, the event log |
| `record.mjs` | Both recorder backends, in-flight process tracking, graceful stop |

### `src/analyze/` — turning pixels into evidence

| File | Owns |
|---|---|
| `frames.mjs` | Sampling to greyscale, extracting stills, long-edge downscaling to a byte budget |
| `delta.mjs` | Greyscale resize, dHash, MAD, changed area, per-block peak, frame scoring |
| `select.mjs` | Transitions, settled frames, action correlation, dedupe, the notes that call out a blank or unchanged recording |
| `sheet.mjs` | The labelled contact sheet |
| `timeline.mjs` | Merging samples, actions and keyframes into ordered rows; collapsing quiet stretches |
| `budget.mjs` | The token arithmetic and the text allocation |
| `input.mjs` | Accepting a video, an animated GIF, or a directory of stills |
| `analyze.mjs` | Orchestration: pipeline in, MCP content blocks out |

### `src/tools/` and `src/server.mjs`

| File | Owns |
|---|---|
| `server.mjs` | Server identity (read from `package.json`), `doctor`, `list_recordings`, transport |
| `tools/capture-tools.mjs` | `start_recording`, `mark`, `stop_recording` |
| `tools/analysis-tools.mjs` | `analyze_recording`, `get_frames`, and resolving a session or a path to a source |

## Design rules

**Evidence, never verdicts.** No tool returns pass or fail. A tool that answers "PASS" hides
its reasoning and cannot be argued with; the model judges against the rubric and cites
frames, which a human can check.

**Silence is a finding.** If actions were recorded and nothing moved, the analysis says so
rather than returning an empty-looking success. That is usually the occlusion trap, not a
working app.

**One source of truth.** Name and version come from `package.json`; the manifest linter
fails the build if the three manifests disagree.

**Nothing leaves the machine.** No network calls anywhere in `src/`. Recordings are written
under `FLIPBOOK_HOME` and never uploaded.

## Known limits

- macOS 15+ only, and the target window must be the **active tab** of a window that nothing
  else covers. Both are detected by `doctor` and explained in the README.
- Analysis is single-pass and in-memory; a recording of several hours would need streaming.
- The contact sheet can spend several cells on one animation, because a rotating spinner
  genuinely differs frame to frame. Telling an oscillating region from a state change would
  free those cells.

## Tests

`test/unit/` runs on pure functions over synthetic pixel buffers — no ffmpeg, no browser, no
screen permission — so it runs in CI. Everything needing a real recording lives in
`test/mcp-check.mjs` (protocol round-trip), `test/fixture-run.mjs` (the spinner-and-toast
fixture, frontmost and occluded) and `test/live-run.mjs` (non-interference), and is run
locally. `scripts/validate.mjs` scores the whole repo against
[the validation rubric](VALIDATION-RUBRIC.md).

Linting is Biome, invoked through `npx` and deliberately **not** a dependency: Claude Code
installs plugin dependencies without `--omit=dev`, so a devDependency would ship into every
user's plugin cache. The formatter is off — the linter catches real defects, while
reformatting would churn deliberately aligned ffmpeg argument lists.
