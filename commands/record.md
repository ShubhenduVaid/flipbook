---
description: Record the browser while validating a flow, then judge it against a rubric
argument-hint: <what to validate, e.g. "checkout shows a spinner then a confirmation">
allowed-tools: mcp__plugin_flipbook_rec__doctor, mcp__plugin_flipbook_rec__start_recording, mcp__plugin_flipbook_rec__stop_recording, mcp__plugin_flipbook_rec__mark, mcp__plugin_flipbook_rec__get_frames, mcp__plugin_flipbook_rec__analyze_recording
---

Validate this in a real browser by recording it: **$ARGUMENTS**

Follow the `validate-with-recording` skill. Specifically:

1. Run `doctor` first if you have not already this session.
2. Turn the request above into an explicit rubric — observable criteria, one per line,
   each checkable from pixels and timing. Show the rubric before recording.
3. `start_recording` with a short label.
4. Drive the flow with the Claude-in-Chrome tools. `mark` what you expect before each
   step that should produce a visible change.
5. `stop_recording` with the rubric.
6. Report a verdict per rubric item, citing frame numbers and timestamps. Use
   `get_frames` to confirm anything ambiguous before calling it a pass or a fail.

If no browser flow is implied by the request, ask what to validate rather than guessing.
