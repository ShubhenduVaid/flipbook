---
name: validate-with-recording
description: Validate that a web application actually works by recording the browser while driving it, then judging the recording against a rubric. Use when asked to check, verify, test, or QA a web app's behaviour in a real browser — especially for anything involving loading states, animations, timing, flicker, layout shift, or transient UI like toasts, where discrete screenshots are not enough.
---

# Screen-recording QA

## Why this exists

Screenshots show states, not behaviour. Everything between two screenshots is invisible:
a spinner that never stops, a layout that shifts 200 ms after paint, a toast that
appears and vanishes, a double-submit, a flash of unstyled content, or the simple fact
that a step took eleven seconds. A before/after pair cannot distinguish "it worked" from
"it worked eventually, badly".

This skill records the browser continuously while you drive it, then converts the
recording into evidence you can actually read.

Note that `mcp__claude-in-chrome__gif_creator` does **not** solve this. It stitches
together screenshots you already took and exports them for a human to download — it
returns nothing to you, and adds no information you did not already have. Worse, the
vision API only ever reads a GIF's **first frame**, so an animated GIF is not something
you can watch. If you have one, pass it to `analyze_recording`, which decodes every
frame.

## The constraint that shapes everything

You cannot be shown a video. There is no video input, and animations are not supported.
So the tools convert a recording into a budgeted set of stills plus structured text.

The budget is real and small: images cost a flat **1600 tokens each**, and a tool result
stays untruncated only under **~12,500 tokens** — about **seven images**. Default is six:
one contact sheet plus five detail frames. Do not raise `max_images` casually; prefer
`get_frames` to drill into a specific moment.

## Two rules about the window, or you will record nothing

Both of these were found the hard way, and both produce a recording that looks valid and
contains nothing.

1. **The tab you are validating must be the active tab of its window.** Window capture
   records what the window paints, and a window paints only its active tab. Claude in
   Chrome happily drives a *background* tab — and that tab will not appear in the
   recording at all. Switch to it first.

2. **No other window may be sitting on top of the target window.** macOS marks a covered
   window occluded and the browser stops painting it, so the capture shows frozen browser
   chrome and a blank page. Two browser windows at nearly the same position are the usual
   culprit. Being behind a full-screen terminal on a *different* Space is fine; being
   underneath another window on the same Space is not.

If `start_recording` reports `candidates: 2` or more, say which window it chose and
consider passing `title_contains` or `window_id` to be certain.

## One rule about how you drive: measure in the recording, not between calls

The recording runs continuously; your tool calls do not. Between "click the button" and
"take a screenshot" sits a full MCP round trip — one to two seconds in practice. A
one-second animation is completely over before the next call begins. So a spinner, a
toast, a fade or a layout settle can be perfectly correct and still be invisible to a
click-then-look pattern, and the honest-looking conclusion is "the feature does not
work". That conclusion has been drawn, and it was wrong.

Do not try to catch a transient state live. Instead:

- `mark` immediately **before** the action, saying what you expect to happen;
- fire the action;
- keep going — do not stop to look;
- read the evidence afterwards. The timeline's `d` values show what happened between your
  calls, and the SEGMENTS block shows whether the span your mark opened moved at all.

If you must pin down one moment, use `get_frames` with `after_mark` and a small `offset`
*after* the run. That reads the recording, which has every frame, instead of re-driving
the app and hoping to be quick enough.

Related: taking Claude-in-Chrome screenshots **with width/height arguments** during a
recording overrides the browser's device metrics and can make the window stop painting or
paint shrunk into a corner while capture keeps rolling. The analysis detects this and says
so, but the simplest fix is not to pass size arguments to a screenshot mid-recording.

## Workflow

1. **`doctor`** — run once per session, or whenever something looks wrong. It catches the
   failure that matters most: a recording that is silently blank because Screen Recording
   permission was never granted.

2. **`start_recording`** with a `label`. Recording captures the browser window's own
   content, so it keeps working while the window is behind your terminal or on another
   Space, and it does not interfere with any `mcp__claude-in-chrome__*` tool. Check the
   window it reports back is the one you mean — see the two rules above.

3. **Drive the app normally.** Every Claude-in-Chrome action is timestamped into the
   recording's timeline automatically. Use `mark` for anything else worth noting —
   especially what you *expect* to happen, before it happens.

4. **`stop_recording` with a `rubric`.** State what "working correctly" means, one
   criterion per line. You get back a contact sheet, detail frames, and a timeline.

5. **Judge, then drill down.** If a cell looks wrong, call `get_frames` for that time
   range before concluding. Never guess from a thumbnail.

## Writing a good rubric

Write criteria that are observable in pixels and time.

Good:
```
A loading indicator appears within 500ms of clicking Submit.
The loading indicator disappears once results render.
The results table shows 3 rows.
No error toast appears at any point.
The layout does not shift after the results render.
```

Bad — not observable, or not checkable from a recording:
```
The app is fast.
The API returns the right data.
The UX is good.
```

## Reading the result

- **Contact sheet** — the whole recording in one image. Cells are labelled with frame
  number and timestamp; red outlines mark the largest visual changes.
- **Detail frames** — full-resolution stills of the moments that changed most, or that
  followed a recorded action. Each says why it was chosen.
- **Timeline** — every sampled moment with a change magnitude `d`, interleaved with the
  actions that caused them and any notes. Long quiet stretches are collapsed. Marks and
  segment boundaries are never dropped from it, however long the recording.
- **SEGMENTS** — the recording split at each `mark`, with the duration, mean and peak
  change of each span. A segment flagged `STATIC` is the strongest single signal this tool
  produces: between two of your own marks, nothing visibly happened.

Things worth reacting to:

- **A `STATIC` segment after one of your marks** — whatever you expected that action to
  do, the window did not visibly change while it was in effect. Before reporting an app
  bug, check the capture notes below: a window that stopped painting looks identical.
- **"No visual change detected"** — if you did something that should have had an effect,
  this is a bug, not an absence of evidence. Say so.
- **"Every sampled frame is flat"** — the recording is blank. Run `doctor`; do not report
  findings from a blank recording.
- **"the window went blank and stayed blank"** — the capture was working and then stopped.
  Different from the above: judge only the frames before that timestamp.
- **"the recorded window changed the geometry it was painting"** — usually a screenshot
  taken with size arguments overriding **device metrics** mid-recording, which makes the
  page paint shrunk or not at all while capture continues. Frames after that point are
  evidence about an emulated viewport, not about the app. Benign if you deliberately went
  fullscreen or resized — the two are indistinguishable from pixels.
- **"browser action(s) were recorded but the window barely changed"** — this is almost
  always the occlusion problem above, not a broken app. Fix the window and re-record
  before reporting anything.
- **"Only N% of the frame ever changed"** — a framing problem, not a subtle app. The note
  quotes the exact rect; re-run with that `roi` to get the subject at full size.

## Framing: `roi`

An image costs a flat 1600 tokens whatever it contains, so a small subject in a large
window wastes most of the budget. `roi` takes a fractional rect or `"auto"`, and applies
to `stop_recording`, `analyze_recording` and `get_frames`.

**A cropped frame is not the page.** If the header says `CROPPED VIEW`, everything you can
say from those images is about that rectangle only. An error banner at the top of the
page, a modal, a navigation — none of it is in the image, and its absence is not evidence
of anything. Cropped cells carry an amber border and a `CROP` badge for the same reason.

## Drilling in

- **`get_frames` with `after_mark`** — read `at`/`from`/`to` as offsets from a mark, given
  as a 1-based index or a substring of its note. `after_mark: "clicked Submit", offset:
  0.5` beats computing absolute times by hand. With no range you get the following three
  seconds.
- **`clip`** — writes a short mp4 or gif of a range, or of a span between two marks, and
  returns a link. It is **for the human who asked**, not for you: you cannot watch it and
  it holds no evidence the frames do not. Use it to hand back a few seconds of the fixed
  behaviour once you have finished judging.

## Housekeeping

Recordings are large — hundreds of megabytes per minute, plus every frame extracted since.
`list_recordings` and `doctor` report the total footprint and flag sessions whose evidence
was never looked at. `prune_recordings` reclaims them; it is a dry run unless you pass
`confirm: true`, and it refuses a request with no selectors rather than reading one as
"everything".

## Reporting

State a verdict per rubric item and cite evidence by frame number and timestamp:

> **A loading indicator appears within 500ms** — PASS. Frame 03 at t=1.25s shows the
> spinner; the click was recorded at t=1.08s, so it appeared within ~170ms.
>
> **No error toast appears** — FAIL. Frame 06 at t=5.25s shows a toast reading "Saved
> successfully"; it is gone by t=6.75s, which is why the final screenshot looks clean.

If the evidence does not settle an item, say so and call `get_frames` — do not guess.
These tools deliberately return evidence and never a verdict; the judgement is yours,
and it needs to be one someone can check.

## Analysing recordings you did not make

`analyze_recording` takes a `path` to any `.mov`, `.mp4`, `.webm`, `.m4v`, an animated
`.gif`, or a directory of stills. Use it when the user hands you a screen recording of a
bug, or a QuickTime capture of something they cannot reproduce on demand.
