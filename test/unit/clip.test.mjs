import test from "node:test";
import assert from "node:assert/strict";

import { resolveClipRange, clipDescription, clipPath, CLIP_LIMITS } from "../../src/analyze/clip.mjs";

const MARKS = [
  { t: 2.0, type: "mark", note: "opened the panel" },
  { t: 4.85, type: "mark", note: "clicked Submit" },
  { t: 9.1, type: "mark", note: "toast should be gone" },
];

test("an explicit range is used as given, and clamped to the recording", () => {
  assert.deepEqual(
    { ...resolveClipRange({ from: 2, to: 5 }, { duration: 20 }) },
    { from: 2, to: 5, seconds: 3, requestedSeconds: 3, label: null, clamped: false }
  );
  assert.equal(resolveClipRange({ from: 2, to: 5 }, { duration: 4 }).to, 4);
});

test("a start with no end gets the default span", () => {
  const r = resolveClipRange({ from: 1 }, { duration: 60 });
  assert.equal(r.seconds, CLIP_LIMITS.defaultSeconds);
});

test("a mark sets the start and names the clip", () => {
  const r = resolveClipRange({ mark: "Submit" }, { events: MARKS, duration: 60 });
  assert.equal(r.from, 4.85);
  assert.equal(r.seconds, CLIP_LIMITS.defaultSeconds);
  assert.match(r.label, /mark 2 "clicked Submit"/);
});

test("mark plus to_mark spans between them", () => {
  const r = resolveClipRange({ mark: 1, to_mark: 3 }, { events: MARKS, duration: 60 });
  assert.equal(r.from, 2.0);
  assert.equal(r.to, 9.1);
  assert.match(r.label, /opened the panel[\s\S]*toast should be gone/);
});

test("to_mark before the start is refused, naming both", () => {
  assert.throws(
    () => resolveClipRange({ mark: 3, to_mark: 1 }, { events: MARKS, duration: 60 }),
    /not after the start/
  );
});

test("`to` is relative when a mark set the origin, matching get_frames", () => {
  const r = resolveClipRange({ mark: "Submit", to: 2 }, { events: MARKS, duration: 60 });
  assert.equal(r.from, 4.85);
  assert.equal(r.to, 6.85);
});

test("an over-long range is trimmed rather than refused", () => {
  const r = resolveClipRange({ from: 0, to: 74 }, { duration: 200 });
  assert.equal(r.clamped, true);
  assert.equal(r.seconds, CLIP_LIMITS.maxSeconds);
  assert.equal(r.requestedSeconds, 74, "the request is remembered so the description can say so");
});

test("an empty range is refused", () => {
  assert.throws(() => resolveClipRange({ from: 5, to: 5 }, { duration: 20 }), /range is empty/);
});

// Both paths go through resolveMark, so a mistyped mark gets the same self-correcting
// listing here as it does in get_frames.
test("an unknown mark lists every mark, exactly as get_frames does", () => {
  assert.throws(
    () => resolveClipRange({ mark: "sumbit" }, { events: MARKS, duration: 60 }),
    (err) => /No mark matches "sumbit"/.test(err.message) && /t=4\.85s/.test(err.message)
  );
});

test("the description says the clip is not evidence", () => {
  const range = resolveClipRange({ mark: "Submit" }, { events: MARKS, duration: 60 });
  const text = clipDescription(
    { from: 4.85, to: 10.85, seconds: 6, format: "mp4", width: 720, bytes: 2_100_000, oversized: false },
    range
  );
  assert.match(text, /for a human to open/);
  assert.match(text, /cannot watch it/);
  assert.match(text, /never cropped by/);
  assert.match(text, /2\.1 MB/);
});

test("the description says when it trimmed or overran", () => {
  const range = resolveClipRange({ from: 0, to: 74 }, { duration: 200 });
  const text = clipDescription(
    { from: 0, to: 30, seconds: 30, format: "gif", width: 432, bytes: 9_000_000, oversized: true },
    range
  );
  assert.match(text, /Trimmed from the 74\.0s requested/);
  assert.match(text, /Larger than intended/);
});

test("two different ranges do not collide on disk", () => {
  const a = clipPath("/out", { from: 1.25, to: 7.25, format: "mp4" });
  const b = clipPath("/out", { from: 9.0, to: 15.0, format: "mp4" });
  assert.notEqual(a, b);
  assert.match(a, /clip-1_3s-7_3s\.mp4$/);
});
