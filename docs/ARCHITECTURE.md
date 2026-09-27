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

A burst of change nominates three frames: its **peak**, the frame it **settled** into,
and — when the burst is longer than its peak — its **onset**. The onset exists because a
burst is one contiguous run above the change threshold, so a loading animation that leads
straight into its result is a single run whose peak is the result arriving. Without the
onset, the loading state — the transient this tool exists to show — was never nominated.
A CSS spinner happens to rotate below the threshold, which is why the macOS fixture never
showed it; a synthetic fixture with a heavier indicator did. The onset is weighted below
the other two, so it only spends budget they leave over.

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

## Region of interest

`scale=128:128` does not preserve aspect, and that is load-bearing rather than sloppy:
sample pixel (i, j) maps linearly onto fraction (i/128, j/128) of the source frame whatever
the window's shape, so a bounding box measured in sample space **already is** a fractional
rect. No aspect correction anywhere.

The region is the bounding box of pixels that changed across the run. A pixel counts if it
changed in two frame pairs, which keeps compression noise out — or in one pair, if most of
its neighbours changed too. Without the second rule, every state that is reached once and
then holds (a confirmation panel appears in exactly one pair) fell outside the box, and
the crop cut the bottom rows off the result it was meant to frame. Noise is speckle; a
panel is a block. Frame pairs where most of the frame moved are ignored — a navigation repaints everything and has nothing to say
about where to crop. Cropping is refused when the box spans most of the frame, because it
would lose context without gaining resolution.

Crop must precede scale in all three consumers — the sampler, the still extractor and the
contact-sheet cells — and all three take the same filter string, for the same
anti-divergence reason `longEdgeScale` exists. The cell aspect has to follow the crop too,
or every cell gets pillarboxed around a correctly cropped image.

Sampling stays a **single full-frame decode**. The capture-integrity detectors below must
see the whole window, and `"auto"` needs it to find its region at all, so a crop is
re-scored in memory from the same buffers, stretched back to the sampling size. That keeps
every downstream default (`dHash`, `peakBlockDiff`, `samePicture`) valid — a natural-sized
sub-rect would read past the end of the buffer and silently return NaN deltas, disabling
dedupe. The gain is sensitivity: both change scores normalise by buffer length, so a
spinner at 0.3% of the full frame becomes ~8% of the cropped one. It improves **which
frames get picked, not how they look** — the stills are always extracted from the source at
full resolution.

## Segments, and why "static" is not a new number

The recording is split at each mark, and each span reports its duration, mean and peak
change. `static` means `peakDelta < transitionDelta` — the same threshold `findTransitions`
uses to decide the UI is changing at all — so it is precisely the statement "`findTransitions`
would find nothing here", and a unit test asserts that equivalence rather than pinning a
tuned constant. The settled threshold (0.012) was the obvious alternative and gets a real
reported case wrong: a pan that peaked at 0.020 while the camera never moved.

A static *first* segment is never reported. A page sits still before you touch it.

## Detecting a capture that stopped being about the app

A screenshot taken with size arguments overrides device metrics, resizing the rendered
viewport underneath the unchanged window — so capture keeps rolling at the old size over a
page that paints shrunk, or not at all. The output is not blank; it is convincing evidence
of a bug that does not exist, which is the worst thing an evidence tool can produce.

Two content-based detectors, since nothing here speaks CDP and `S3` forbids it:

- **Geometry change.** The bounding box of non-border content moving abruptly and staying
  moved, or uniform border appearing where there was none. Gated so a navigation, a modal,
  a dark theme, a one-frame flicker and permanently letterboxed content all stay silent,
  and skipped entirely when there was no painted content to begin with — a featureless
  frame has no geometry to change. Three more gates exist for **viewport-only videos**
  (Playwright, Cypress, a cropped capture), where no browser chrome pins the content box
  to the frame edges and a dark centred page has a small box that any overlay moves:
  a box that only *grew* is content appearing, and an override never adds painted area;
  a box that shrank while everything inside it stayed pixel-identical is content leaving;
  and a box returning to a geometry the recording already showed is an overlay being
  dismissed, whereas an override produces geometry never seen before. Before these, a
  corner toast on the fixture was reported as two capture faults, with advice to ignore
  every frame after it — the tool told the model to discard its best evidence.
- **Onset of flatness.** The existing blank check only fires when *every* frame is
  featureless, so it was blind to a recording that starts fine and goes blank halfway. The
  transition is the event, not the state.

A fullscreen video player is genuinely indistinguishable from a viewport override, so the
note offers that reading rather than asserting a cause.

## Labels on the contact sheet

A grid of unlabelled thumbnails lets the model see *that* something changed but not
*when*, so every cell has its frame number and timestamp burned in. ffmpeg builds differ
in how they can draw text: `drawtext` needs freetype **and** harfbuzz since FFmpeg 6.1,
and the static Linux build ffmpeg-static ships has libass but no `drawtext`. So the sheet
uses `drawtext` when the build has it, otherwise writes a one-cell ASS subtitle file and
draws it with the `subtitles` filter, with the chosen font copied alone into a `fontsdir`
so libass cannot pick another face. The font is `FLIPBOOK_FONT`, else the first of a list
of macOS, Linux and Windows fonts, else whatever `fc-match` offers. If none of that works
the cells go unlabelled and the caption says so and how to count them — it never claims
labels it did not draw. `doctor` reports which path this machine takes.

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
| `doctor.mjs` | Every preflight check, the two blank-recording traps, and which job — record, analyse, or neither — this machine can do |

### `src/capture/` — getting pixels

| File | Owns |
|---|---|
| `session.mjs` | Session lifecycle: create, read, update, list, the active-session pointer, the event log, storage accounting, and the one guarded delete |
| `record.mjs` | Both recorder backends, in-flight process tracking, graceful stop |
| `prune.mjs` | What a prune would remove, as a pure function of session metadata, kept apart from removing it |

### `src/analyze/` — turning pixels into evidence

| File | Owns |
|---|---|
| `frames.mjs` | Sampling to greyscale, extracting stills, long-edge downscaling to a byte budget |
| `delta.mjs` | Greyscale resize, dHash, MAD, changed area, per-block peak, frame scoring |
| `select.mjs` | Transitions, settled frames, action correlation, dedupe, the notes that call out a blank or unchanged recording |
| `segments.mjs` | Splitting the run at each mark and reporting whether each span moved |
| `anomaly.mjs` | Detecting a capture that stopped being about the app: geometry changes and the onset of blankness |
| `roi.mjs` | Where the change is, whether cropping to it helps, and the one crop filter every consumer uses |
| `sheet.mjs` | The labelled contact sheet, and finding a font and a text filter to label it with |
| `timeline.mjs` | Merging samples, actions, marks and segment boundaries into ordered rows; the priority ladder that decides what survives truncation; resolving a mark to a time |
| `budget.mjs` | The token arithmetic and the text allocation |
| `input.mjs` | Accepting a video, an animated GIF, or a directory of stills |
| `clip.mjs` | A short mp4 or gif for a human — the one output that is not evidence |
| `analyze.mjs` | Orchestration: pipeline in, MCP content blocks out |

### `src/tools/` and `src/server.mjs`

| File | Owns |
|---|---|
| `server.mjs` | Server identity (read from `package.json`), `doctor`, `list_recordings`, `prune_recordings`, transport |
| `tools/capture-tools.mjs` | `start_recording`, `mark`, `stop_recording` |
| `tools/analysis-tools.mjs` | `analyze_recording`, `get_frames`, and resolving a session or a path to a source |
| `tools/schemas.mjs` | Parameter shapes used by more than one tool, so the sentence that matters cannot go missing from a copy |

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

- Recording is macOS 15+ only, and the target window must be the **active tab** of a window
  that nothing else covers. Both are detected by `doctor` and explained in the README.
  Analysis runs anywhere Node and ffmpeg do; off macOS `doctor` reports "analysis only" and
  `start_recording` refuses before creating a session.
- Analysis is single-pass and in-memory; a recording of several hours would need streaming.
- The contact sheet can spend several cells on one animation, because a rotating spinner
  genuinely differs frame to frame. Telling an oscillating region from a state change would
  free those cells.
- **Warning at `mark` time that the previous segment was static is deferred, not
  forgotten.** It cannot be built on the current recorder. `sckrec` writes through
  `AVAssetWriter`, which emits the `moov` atom only when the writer is finalised at stop —
  the same fact recorded above, where an unfinalised file is described as unplayable.
  Mid-recording there is no `moov`, so ffmpeg cannot decode a single frame and there is
  nothing to sample. Delivering it would need fragmented output (a rewrite of the writer
  setup in `native/sckrec.swift`, plus a segment-aware decode path) or a second parallel
  encoder writing a throwaway stream. Both cost far more than the feature returns, given
  that `stop_recording` reports the same fact seconds later.
- A cropped frame is a genuine hazard: it is real evidence about a rectangle that reads as
  evidence about a page. Four independent signals mitigate it rather than one, but a caller
  determined to misread a crop still can.
- The geometry detector cannot distinguish a deliberate fullscreen or window resize from a
  device-metrics override.

## Distribution

One codebase ships five ways, and `scripts/lint-manifests.mjs` holds their manifests to
one name and version:

| Channel | Manifest | Built by |
|---|---|---|
| Claude Code plugin (self-hosted marketplace) | `.claude-plugin/plugin.json`, `marketplace.json` | the git tag; the marketplace reads `main` |
| npm, `@shubhenduvaid/flipbook` (`npx`, Cursor, VS Code, any MCP client) | `package.json` (`bin`, `files`, `mcpName`) | release workflow, trusted publishing |
| MCP Registry, `io.github.ShubhenduVaid/flipbook` | `server.json` | release workflow, GitHub OIDC |
| Claude Desktop extension (`.mcpb`) | `mcpb/manifest.json` | `scripts/pack-mcpb.mjs` on macOS, attached to the GitHub release |
| Directories that index the above | `glama.json` | — |

The npm name is scoped because the bare `flipbook` belongs to someone else there; the
server strips the scope from its own identity, so every client still sees `flipbook`.
The `.mcpb` carries its own `node_modules`, including an ffmpeg binary for the platform it
was built on, so the packer stamps exactly that platform into the bundle's compatibility.

## Tests

`test/unit/` runs on pure functions over synthetic pixel buffers — no ffmpeg, no browser, no
screen permission — so it runs in CI. `test/mcp-check.mjs` drives the real server over stdio against a synthetic
fixture that ffmpeg draws from boxes (`test/synthetic-fixture.mjs`: blank tab, spinner,
confirmation panel, corner toast), so it needs no browser, no font and no permission, and
runs in CI on Linux, Windows and macOS. It asserts the spinner, panel and toast are all
selected, and that the toast is not mistaken for a capture fault. Everything needing a
real screen lives in `test/fixture-run.mjs` (the HTML fixture, frontmost and occluded) and
`test/live-run.mjs` (non-interference), and is run locally. `scripts/validate.mjs` scores the whole repo against
[the validation rubric](VALIDATION-RUBRIC.md).

Linting is Biome, invoked through `npx` and deliberately **not** a dependency: Claude Code
installs plugin dependencies without `--omit=dev`, so a devDependency would ship into every
user's plugin cache. The formatter is off — the linter catches real defects, while
reformatting would churn deliberately aligned ffmpeg argument lists.
