# Flipbook

**Claude can't watch video.** Flipbook records your web app while Claude drives it and
hands back a flipbook it *can* read: a labelled contact sheet, full-resolution key frames,
and a timeline correlated with the actions that caused each change.

For Claude Code on macOS 15+. Works alongside Claude in Chrome without interfering with it.

---

## The problem

Claude in Chrome validates web apps with discrete screenshots. Everything *between* two
screenshots is invisible — spinners, layout shift, flicker, double-submits, and toasts that
appear and vanish. A before/after pair can't tell "it worked" from "it worked eventually,
badly".

This isn't hypothetical. Driving the bundled test fixture, Claude in Chrome's own
screenshot shows:

```
Order checkout
Idle.
┌─ Order confirmed ─────────────┐
│ Item              Widget Pro  │
│ Quantity                   3  │
│ Total                $147.00  │
└───────────────────────────────┘
```

Looks like a pass. But the run also showed a two-second loading spinner and a
"Saved successfully" toast — and **both are missing**, because the toast had already
disappeared by the time the screenshot was taken.

Flipbook records the same run and returns this instead — one image, the whole timeline:

![Contact sheet of the checkout flow: the resting state, three frames of the loading
spinner, then the confirmation panel with a success toast that has already vanished by the
end of the run](docs/demo-contact-sheet.jpg)

Every cell is labelled with its frame number and timestamp, red outlines mark the largest
visual changes, and the caption says why each frame was chosen. The spinner (02–04) and the
toast (05, top right) are exactly what the screenshot above missed.

That image is real output, not a mockup — regenerate it with `node scripts/make-demo.mjs`.

`gif_creator` doesn't close this gap: it stitches together screenshots Claude already took
and exports them for a human, returning nothing to the model. And the vision API reads only
a GIF's **first frame**, so an animated GIF isn't something Claude can watch either. (Hand
one to `analyze_recording` and Flipbook will decode every frame of it.)

## Install

```bash
claude plugin marketplace add ShubhenduVaid/flipbook
claude plugin install flipbook@shubhenduvaid
```

Then start Claude with `claude --chrome` and ask it to **run `doctor`**. That finishes
setup on first run: it compiles the ScreenCaptureKit recorder and restores the bundled
ffmpeg binary, which Claude Code's installer skips because it installs plugin dependencies
with `--ignore-scripts`.

The one thing `doctor` can't do for you: **grant Screen Recording** to your terminal in
System Settings → Privacy & Security → Screen & System Audio Recording, then restart it.
Without it macOS records a blank screen rather than erroring, so `doctor` checks for it
explicitly.

Requirements: macOS 15+ (window capture uses ScreenCaptureKit), Node 22+, Xcode Command
Line Tools (`xcode-select --install`), and Google Chrome.

<details>
<summary>Run from a clone instead</summary>

```bash
git clone https://github.com/ShubhenduVaid/flipbook && cd flipbook
npm install
npm run build:native   # compiles the ScreenCaptureKit recorder
npm run doctor         # preflight every prerequisite

claude --chrome --plugin-dir "$PWD"
```

`--plugin-dir` loads the plugin for one session only.
</details>

## Usage

```
/flipbook:record the checkout flow shows a spinner, then a confirmation, and no errors
```

Or just ask — the bundled skill tells Claude when to reach for this. Under the hood:

1. `start_recording` — begins capturing the browser window
2. you or Claude drive the app; every Claude-in-Chrome action is timestamped automatically
3. `stop_recording` with a **rubric** — what "working correctly" means, one criterion per line
4. Claude judges the evidence and cites frames

A rubric should be observable in pixels and time:

```
A loading indicator appears within 500ms of clicking Submit.
The loading indicator disappears once results render.
No error toast appears at any point.
The layout does not shift after the results render.
```

And the verdict cites evidence you can check:

> **No error toast appears** — FAIL. Frame 06 at t=5.25s shows a toast reading "Saved
> successfully"; it's gone by t=6.75s, which is why the final screenshot looks clean.

Flipbook returns **evidence, never a verdict**. A tool that answers "PASS" hides its
reasoning and can't be argued with.

## Three ways to record nothing

Each produces a plausible-looking recording that contains no evidence. All were found the
hard way; `doctor` warns about the first two.

1. **Recording a window whose active tab isn't the one under test.** A window paints only
   its active tab, and Claude in Chrome will happily drive a *background* tab. Switch to it
   first.
2. **Recording a window that another window covers.** macOS marks it occluded and the
   browser stops painting it, so you capture frozen browser chrome over a blank page. Two
   browser windows at nearly the same position are the usual culprit. Behind a full-screen
   terminal on a *different* Space is fine; underneath another window on the same Space is
   not.
3. **Taking a screenshot with size arguments while recording.** That overrides the
   browser's device metrics, so the page repaints into a smaller viewport — or stops
   painting — while capture keeps rolling at the old size. This one is worse than the other
   two, because the result isn't blank: it's convincing evidence of a bug that doesn't
   exist. One reported run showed an 11-second blank load that a control run rendered in
   ~1.8s. The analysis detects the geometry change and says so.

When actions were recorded but the pixels didn't move, the analysis says so rather than
letting you report a false pass. Same for a span between two marks where nothing changed,
and for a subject too small in frame to read.

## Tools

| Tool | Purpose |
|---|---|
| `doctor` | Preflight: macOS, ffmpeg + filters, native helper, permission, target window, disk, footprint |
| `start_recording` | Capture a window (`label`, `target`, `title_contains`, `window_id`, `fps`, `max_duration_s`) |
| `mark` | Annotate the timeline mid-run, and split the per-segment change stats |
| `stop_recording` | Stop, analyse, return the evidence against a `rubric` (`roi`, `clip`) |
| `analyze_recording` | Same analysis for any `.mov/.mp4/.webm/.m4v/.gif` or a directory of stills (`roi`, `clip`) |
| `get_frames` | Full-resolution drill-down at exact timestamps, over a range, or relative to a mark (`after_mark`, `offset`, `roi`) |
| `list_recordings` | Browse past sessions, with sizes and total footprint |
| `prune_recordings` | Reclaim disk — a dry run unless `confirm: true` |

`analyze_recording` accepts recordings you made yourself — hand it a QuickTime capture of a
bug you can't reproduce on demand.

### Framing: `roi`

An image costs the same whatever it contains, so a small subject in a large window spends
most of its resolution on nothing. `roi` takes a fractional rect or `"auto"` — which derives
the region from the pixels that actually changed — and applies to the three tools above.
When the subject is small and no `roi` was given, the analysis says so and quotes the exact
rect to pass.

A cropped frame is announced four ways: a `CROPPED VIEW` header line, a `[CROP …]` prefix on
every caption, an amber border and badge burnt into every cell, and a `roi` object in
`structuredContent` that is present whether or not it applied. A crop read as the whole page
is exactly the failure mode the geometry detector exists to catch, so it's worth repeating.

## Why stills instead of video

There's no video input, animations are explicitly unsupported, and the MCP spec has no
video content type (checked in both `2025-06-18` and `2026-07-28`). So a recording has to
become stills plus text.

The budget was read out of Claude Code's own accounting rather than guessed:

| | |
|---|---|
| Cost per MCP image | flat **1600 tokens** |
| MCP output budget | **25,000** tokens (`MAX_MCP_OUTPUT_TOKENS`) |
| Never-truncated zone | **50%** of budget → **~7 images** |

Default output is 6 images — one contact sheet plus five detail frames — leaving room for
the timeline under the ~12,500-token ceiling. `get_frames` provides drill-down rather than
spending more images up front. A measured run comes in at ~10,100 tokens.

Keyframe selection samples at 128×128 and scores each frame both globally and per-block,
because a 64px spinner in a 3000px-wide window moves the whole-frame average by 0.0003 —
indistinguishable from noise. Dedupe compares pixels rather than perceptual hashes, which
measured *zero* Hamming distance between an idle page and the same page showing a spinner.
When two frames are identical, the earlier one wins, so the moment a state was reached
isn't discarded in favour of an identical later frame.

## Why ScreenCaptureKit

Display capture records whatever is visually on top — which is your terminal, not the
browser. Since the whole point is recording a browser Claude drives in the background,
window capture is the only approach that works. It also removes retina scaling and crop
arithmetic, and never captures anything but the target window. ffmpeg still does all the
analysis, and display capture remains available via `target: "display"`.

## Development

```bash
npm run validate       # score the repo against docs/VALIDATION-RUBRIC.md
npm run validate -- --full   # …including the criteria that need macOS + Chrome
npm test               # 161 unit tests, no browser or permission needed
npm run lint           # Biome (via npx — deliberately not a dependency)
npm run lint:manifests # plugin/marketplace/package manifests agree
npm run test:mcp       # 36 MCP protocol checks (macOS)
npm run test:e2e       # fixture: spinner + transient toast must be captured (macOS + Chrome)
npm run test:e2e:occluded  # same, with the browser occluded
```

**[docs/VALIDATION-RUBRIC.md](docs/VALIDATION-RUBRIC.md)** is the standard this project holds
itself to — 38 numbered criteria covering the promises this README makes, naming, security,
quality and docs. `npm run validate` is its executable form and reports each criterion
individually; there is no aggregate score, because a percentage would let a security failure
be averaged away by passing style checks. **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**
explains the pipeline and what each module owns.

`npm run validate`, `npm test` and the linters run in CI on every push; the rest need macOS,
Chrome and Screen Recording permission, so they're local checks. Before a release, also run
`claude plugin validate . --strict`.

Biome is invoked through `npx` rather than added as a devDependency: Claude Code installs
plugin dependencies without `--omit=dev`, so a devDependency would ship into every user's
plugin cache. The formatter is off — the linter catches real defects, while reformatting
would churn deliberately aligned ffmpeg argument lists.

`FLIPBOOK_DEBUG_SELECT=1` traces every keyframe accept/merge decision to stderr, which is
what threshold tuning needs.

| Variable | Purpose |
|---|---|
| `FLIPBOOK_HOME` | Data directory (default `~/.flipbook`) |
| `FLIPBOOK_FFMPEG` | Use a specific ffmpeg binary |
| `FLIPBOOK_DEBUG_SELECT` | Trace keyframe selection |

```
.claude-plugin/     plugin + marketplace manifests
commands/           /flipbook:record
hooks/              PostToolUse hook correlating Claude-in-Chrome actions
native/sckrec.swift ScreenCaptureKit window recorder
skills/             when and how Claude should use this
src/env/            ffmpeg, native helper, Chrome, doctor, paths
src/capture/        session lifecycle, recorder processes, prune policy
src/analyze/        sampling, delta scoring, selection, segments, capture anomalies,
                    region of interest, sheet, budget, timeline, clips
src/tools/          MCP tool definitions and shared parameter schemas
test/unit/          CI-safe unit tests
```

Recordings are written to `~/.flipbook/sessions/` — outside your project, never
auto-uploaded anywhere.

## License

MIT © Shubhendu Vaid
