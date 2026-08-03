import test from "node:test";
import assert from "node:assert/strict";

import { findTransitions, selectKeyframes, DEFAULTS } from "../../src/analyze/select.mjs";
import { scoredFromDeltas, blankFrame, withRect, texturedFrame } from "./helpers.mjs";


test("findTransitions locates the peak and the frame where it settles", () => {
  //            0     1      2      3     4     5     6
  const deltas = [0, 0.30, 0.10, 0.004, 0.003, 0.002, 0.001];
  const scored = scoredFromDeltas(deltas);
  const transitions = findTransitions(scored);

  assert.equal(transitions.length, 1);
  assert.equal(transitions[0].peakIdx, 1, "peak is the largest change");
  assert.ok(
    transitions[0].settledIdx >= 3,
    "settled frame comes after the change has stopped, not mid-animation"
  );
});

test("a quiet recording yields no transitions", () => {
  const scored = scoredFromDeltas([0, 0.001, 0.002, 0.001, 0.0005]);
  assert.equal(findTransitions(scored).length, 0);
});

test("selectKeyframes always pins the first frame", () => {
  const scored = scoredFromDeltas([0, 0.2, 0.005, 0.005, 0.3, 0.004]);
  const { frames } = selectKeyframes(scored, { maxFrames: 8 });
  assert.ok(frames.some((f) => f.reasons.includes("start")));
  assert.equal(frames[0].t, 0, "frames come back in time order");
});

test("selectKeyframes respects the frame budget", () => {
  const deltas = Array.from({ length: 60 }, (_, i) => (i % 3 === 0 ? 0.3 : 0.002));
  const scored = scoredFromDeltas(deltas, { frames: deltas.map((_, i) => texturedFrame(i + 1)) });
  const { frames } = selectKeyframes(scored, { maxFrames: 6 });
  assert.ok(frames.length <= 6, `expected <=6 frames, got ${frames.length}`);
});

/**
 * The regression this exists for: a result panel that appears at 3.75s is pixel-identical
 * to the final frame at 8s. Keeping the later one threw away the only interesting fact —
 * when the state was actually reached.
 */
test("when two frames show the same picture, the earlier one is kept", () => {
  const page = blankFrame(20);
  const panel = withRect(page, { x: 20, y: 40, w: 60, h: 30, value: 200 });

  // idle, change, panel appears and then persists unchanged to the end
  const pixels = [page, page, panel, panel, panel, panel];
  const deltas = [0, 0.002, 0.30, 0.002, 0.001, 0.001];
  const scored = scoredFromDeltas(deltas, { frames: pixels });

  const { frames } = selectKeyframes(scored, { maxFrames: 8 });
  const panelFrames = frames.filter((f) => f.index >= 2);

  assert.equal(panelFrames.length, 1, "the identical panel frames collapse to one");
  assert.equal(
    panelFrames[0].index,
    2,
    "and it is the moment the panel appeared, not the final frame"
  );
  assert.ok(
    panelFrames[0].reasons.includes("end"),
    "the surviving frame inherits 'end', recording that the state persisted"
  );
});

test("distinct states are not collapsed into each other", () => {
  const page = blankFrame(20);
  const spinner = withRect(page, { x: 60, y: 60, w: 8, h: 8, value: 240 });
  const panel = withRect(page, { x: 20, y: 40, w: 60, h: 30, value: 200 });

  const pixels = [page, spinner, spinner, panel, panel];
  const deltas = [0, 0.20, 0.002, 0.25, 0.001];
  const scored = scoredFromDeltas(deltas, { frames: pixels });

  const { frames } = selectKeyframes(scored, { maxFrames: 8 });
  const times = frames.map((f) => f.index);
  assert.ok(times.includes(1) || times.includes(2), "the spinner state survives");
  assert.ok(times.includes(3) || times.includes(4), "the panel state survives");
});

test("recorded actions pull in the frame that follows them", () => {
  const deltas = Array.from({ length: 20 }, () => 0.001);
  const scored = scoredFromDeltas(deltas, { frames: deltas.map((_, i) => texturedFrame(i + 1)) });
  const events = [{ t: 1.0, type: "tool", tool: "mcp__claude-in-chrome__computer" }];

  const { frames } = selectKeyframes(scored, { events, maxFrames: 8 });
  const followUp = frames.find((f) => f.reasons.some((r) => r.startsWith("after:")));
  assert.ok(followUp, "a frame should be selected shortly after each action");
  assert.ok(
    followUp.t >= 1.0 && followUp.t <= 1.0 + DEFAULTS.settleLagSec + 0.3,
    `follow-up frame at ${followUp.t}s should sit just after the action`
  );
});

test("a recording where nothing changes is reported as a finding", () => {
  const scored = scoredFromDeltas([0, 0.001, 0.001, 0.002, 0.001]);
  const { notes } = selectKeyframes(scored, { maxFrames: 6 });
  assert.ok(
    notes.some((n) => /No visual change detected/i.test(n)),
    "silence must be surfaced, not left as an absence of evidence"
  );
});

test("an entirely featureless recording is flagged as blank", () => {
  const flat = Array.from({ length: 6 }, () => blankFrame(0));
  const scored = scoredFromDeltas([0, 0, 0, 0, 0, 0], { frames: flat });
  const { notes } = selectKeyframes(scored, { maxFrames: 6 });
  assert.ok(
    notes.some((n) => /flat, featureless/i.test(n)),
    "a blank recording must not be reported as passing evidence"
  );
});

test("selectKeyframes handles an empty recording without throwing", () => {
  const { frames, notes } = selectKeyframes([], { maxFrames: 6 });
  assert.equal(frames.length, 0);
  assert.ok(notes.length > 0);
});
