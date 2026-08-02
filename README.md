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

Flipbook records the same run and returns this instead:

```
01  t=0.00s  blank page                     start
02  t=0.25s  "Ready. Submitting in 1s…"     peak-change
03  t=1.25s  ● spinner visible              peak-change   ← invisible to screenshots
04  t=1.75s  ● spinner still visible        after:mark
05  t=3.25s  "Order confirmed" panel        settled
06  t=5.25s  ⬛ "Saved successfully" toast   peak-change   ← gone before the flow ended
```

`gif_creator` doesn't close this gap: it stitches together screenshots Claude already took
and exports them for a human, returning nothing to the model. And the vision API reads only
a GIF's **first frame**, so an animated GIF isn't something Claude can watch either. (Hand
one to `analyze_recording` and Flipbook will decode every frame of it.)

## Install

```bash
claude plugin marketplace add ShubhenduVaid/flipbook
claude plugin install flipbook@shubhenduvaid
```

Then, once per machine:

```bash
# In the installed plugin directory, or a clone:
npm install          # ffmpeg-static + MCP SDK
npm run build:native # compiles the ScreenCaptureKit recorder (needs Xcode CLT)
npm run doctor       # preflight every prerequisite
```

**Grant Screen Recording** to your terminal in System Settings → Privacy & Security →
Screen & System Audio Recording, then restart it. Without this, macOS records a blank
screen instead of erroring — `doctor` detects it explicitly.

Requirements: macOS 15+ (window capture uses ScreenCaptureKit), Node 22+, Xcode Command
Line Tools (`xcode-select --install`), and Google Chrome.

<details>
<summary>Try it without installing</summary>

```bash
claude --chrome --plugin-dir /path/to/flipbook
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

## Two ways to record nothing

Both produce a plausible-looking recording that contains no evidence. Both were found the
hard way; `doctor` warns about each.

1. **Recording a window whose active tab isn't the one under test.** A window paints only
   its active tab, and Claude in Chrome will happily drive a *background* tab. Switch to it
   first.
2. **Recording a window that another window covers.** macOS marks it occluded and the
   browser stops painting it, so you capture frozen browser chrome over a blank page. Two
   browser windows at nearly the same position are the usual culprit. Behind a full-screen
   terminal on a *different* Space is fine; underneath another window on the same Space is
   not.

When actions were recorded but the pixels didn't move, the analysis says so rather than
letting you report a false pass.

## Tools

| Tool | Purpose |
|---|---|
| `doctor` | Preflight: macOS, ffmpeg + filters, native helper, permission, target window, disk |
| `start_recording` | Capture a window (`label`, `target`, `title_contains`, `window_id`, `fps`, `max_duration_s`) |
| `mark` | Annotate the timeline mid-run |
| `stop_recording` | Stop, analyse, return the evidence against a `rubric` |
| `analyze_recording` | Same analysis for any `.mov/.mp4/.webm/.m4v/.gif` or a directory of stills |
| `get_frames` | Full-resolution drill-down at exact timestamps or over a range |
| `list_recordings` | Browse past sessions |

`analyze_recording` accepts recordings you made yourself — hand it a QuickTime capture of a
bug you can't reproduce on demand.

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
npm test               # 47 unit tests, no browser or permission needed
npm run lint:manifests # plugin/marketplace/package manifests agree
npm run test:mcp       # 20 MCP protocol checks (macOS)
npm run test:e2e       # fixture: spinner + transient toast must be captured (macOS + Chrome)
npm run test:e2e:occluded  # same, with the browser occluded
```

`npm test` and the manifest lint run in CI on every push; the rest need macOS, Chrome and
Screen Recording permission, so they're local checks. Before a release, also run
`claude plugin validate . --strict`.

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
src/capture/        session lifecycle and recorder processes
src/analyze/        sampling, delta scoring, selection, sheet, budget, timeline
src/tools/          MCP tool definitions
test/unit/          CI-safe unit tests
```

Recordings are written to `~/.flipbook/sessions/` — outside your project, never
auto-uploaded anywhere.

## License

MIT © Shubhendu Vaid
