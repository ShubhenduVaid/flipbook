# video-qa

Records a browser window while Claude drives it, then turns the recording into evidence
Claude can actually read: a labelled contact sheet, full-resolution key frames, and a
timeline correlated with the actions that caused each change.

macOS 15+ only.

## The problem

Claude in Chrome validates web apps with discrete screenshots. Everything between two
screenshots is invisible — spinners, layout shift, flicker, double-submits, and toasts
that appear and vanish. A before/after pair cannot tell "it worked" from "it worked
eventually, badly".

This is not hypothetical. Driving the bundled fixture, Claude in Chrome's own screenshot
shows a page reading `Idle.` above a confirmation panel. The spinner and the success
toast are both absent — the toast had already disappeared. The same run recorded here
surfaces both.

`gif_creator` does not close the gap: it stitches together screenshots Claude already
took and exports them for a human, returning nothing to the model. And the vision API
reads only a GIF's **first frame**, so an animated GIF is not something Claude can watch.

## Why it returns stills instead of video

There is no video input, and animations are explicitly unsupported. The MCP spec has no
video content type either (checked in both `2025-06-18` and `2026-07-28`). So a recording
has to become stills plus text.

The budget was read out of Claude Code's own binary rather than guessed:

| | |
|---|---|
| Cost per MCP image | flat **1600 tokens** |
| MCP output budget | **25,000** tokens (`MAX_MCP_OUTPUT_TOKENS`) |
| Never-truncated zone | **50%** of budget → **~7 images** |

Default output is 6 images — one contact sheet plus five detail frames — leaving room for
the timeline under the ~12,500-token ceiling. `get_frames` provides drill-down instead of
spending more images up front.

## Install

```bash
npm install
npm run build:native   # compiles the ScreenCaptureKit helper (needs Xcode CLT)
npm run doctor         # preflight
```

Then load it as a plugin:

```bash
claude --plugin-dir /path/to/video-mcp
```

Grant **Screen Recording** to your terminal in System Settings → Privacy & Security the
first time. Without it, recordings are silently blank — `doctor` detects this.

## Tools

| Tool | Purpose |
|---|---|
| `doctor` | Preflight: macOS, ffmpeg + filters, native helper, permission, target window, disk |
| `start_recording` | Begin capturing a window (`label`, `target`, `title_contains`, `window_id`, `fps`, `max_duration_s`) |
| `mark` | Annotate the timeline mid-run |
| `stop_recording` | Stop, analyse, return contact sheet + detail frames + timeline against a `rubric` |
| `analyze_recording` | Same analysis for any `.mov/.mp4/.webm/.m4v/.gif` or a directory of stills |
| `get_frames` | Full-resolution drill-down at exact timestamps or over a range |
| `list_recordings` | Browse past sessions |

Every tool returns **evidence, never a verdict**. A tool that answers "PASS" hides its
reasoning and cannot be argued with.

## Why ScreenCaptureKit, not ffmpeg screen capture

The original design used `ffmpeg -f avfoundation` plus a cropped display capture. It
works — but display capture records whatever is *visually on top*, which is the terminal,
not the browser. Since the entire point is Claude driving the browser in the background,
window capture is the only approach that can work. It also removes the retina scaling and
crop arithmetic, and never captures anything but the target window.

ffmpeg is still used for all analysis, and display capture remains as a fallback via
`target: "display"`.

## Two ways to record nothing

Both produce a plausible-looking recording that contains no evidence:

1. **Recording a window whose active tab is not the one under test.** A window paints only
   its active tab, and Claude in Chrome can drive a background tab.
2. **Recording a window that another window covers.** macOS marks it occluded and the
   browser stops painting it. Behind a full-screen app on a *different* Space is fine;
   underneath another window on the same Space is not.

`doctor` warns about both, and the analysis flags the second when actions were recorded
but the pixels did not move.

## Layout

```
.claude-plugin/plugin.json   plugin manifest
.mcp.json                    MCP server registration
commands/record.md           /record slash command
hooks/                       PostToolUse hook correlating Claude-in-Chrome actions
native/sckrec.swift          ScreenCaptureKit window recorder
skills/screen-recording-qa/  when and how to use this
src/env/                     ffmpeg, native helper, Chrome, doctor, paths
src/capture/                 session lifecycle and recorder processes
src/analyze/                 sampling, delta scoring, selection, sheet, budget, timeline
src/tools/                   MCP tool definitions
test/                        fixture, protocol checks, live-run harness
```

Recordings are written to `~/.video-qa/sessions/` — outside the repo, never auto-uploaded.

## Tests

```bash
node test/mcp-check.mjs                    # protocol round-trip, 20 assertions
node test/fixture-run.mjs --front          # spinner + transient toast must be captured
node test/fixture-run.mjs                  # same, with the browser occluded
VIDEO_QA_DEBUG_SELECT=1 node test/...      # trace keyframe accept/merge decisions
```
