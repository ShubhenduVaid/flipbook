import test from "node:test";
import assert from "node:assert/strict";

import { planPrune, DEFAULT_KEEP_RECENT } from "../../src/capture/prune.mjs";

const NOW = Date.parse("2026-08-03T12:00:00Z");
const daysAgo = (n) => new Date(NOW - n * 86_400_000).toISOString();

/** Ids sort chronologically, which is what keep_recent relies on. */
const SESSIONS = [
  { id: "20260803-110000-aaaa", status: "recorded", createdAt: daysAgo(0.1), bytes: 100e6 },
  { id: "20260802-110000-bbbb", status: "analyzed", createdAt: daysAgo(1), bytes: 200e6 },
  { id: "20260801-110000-cccc", status: "recorded", createdAt: daysAgo(2), bytes: 300e6 },
  { id: "20260728-110000-dddd", status: "recorded", createdAt: daysAgo(6), bytes: 400e6 },
  { id: "20260727-110000-eeee", status: "analyzed", createdAt: daysAgo(7), bytes: 500e6 },
  { id: "20260720-110000-ffff", status: "recorded", createdAt: daysAgo(14), bytes: 600e6, lastAnalyzedAt: NOW },
];

const ids = (plan) => plan.candidates.map((c) => c.id);

test("an empty request is refused rather than read as everything", () => {
  const plan = planPrune(SESSIONS, {}, { now: NOW });
  assert.ok(plan.refusal);
  assert.deepEqual(plan.candidates, []);
});

// Dry-run-by-default protects {}, but confirm on its own must not become a selector.
test("confirm alone is still refused", () => {
  const plan = planPrune(SESSIONS, { confirm: true }, { now: NOW });
  assert.ok(plan.refusal, "a confirmation is not a selection");
  assert.deepEqual(plan.candidates, []);
});

test("older_than_days selects by age against an injected clock", () => {
  const plan = planPrune(SESSIONS, { older_than_days: 5 }, { now: NOW });
  assert.deepEqual(ids(plan), [
    "20260728-110000-dddd",
    "20260727-110000-eeee",
    "20260720-110000-ffff",
  ]);
});

test("keep_recent defaults to three and outranks the other selectors", () => {
  const plan = planPrune(SESSIONS, { older_than_days: 0 }, { now: NOW });
  assert.equal(DEFAULT_KEEP_RECENT, 3);
  for (const kept of ["20260803-110000-aaaa", "20260802-110000-bbbb", "20260801-110000-cccc"]) {
    assert.ok(!ids(plan).includes(kept), `${kept} is among the newest three`);
    assert.ok(plan.skipped.some((s) => s.id === kept && /keep_recent/.test(s.why)));
  }
});

test("keep_recent can be lowered", () => {
  const plan = planPrune(SESSIONS, { older_than_days: 0, keep_recent: 0 }, { now: NOW });
  assert.equal(plan.candidates.length, SESSIONS.length);
});

// The regression that makes this feature safe: analyze_recording never set status
// "analyzed", so a session whose evidence was read five minutes ago still reads
// "recorded" and would have been offered up for deletion.
test("only_unanalyzed spares anything that was actually looked at", () => {
  const plan = planPrune(SESSIONS, { only_unanalyzed: true, keep_recent: 0 }, { now: NOW });

  assert.ok(ids(plan).includes("20260728-110000-dddd"), "recorded and never read");
  assert.ok(!ids(plan).includes("20260727-110000-eeee"), "status analyzed");
  assert.ok(!ids(plan).includes("20260720-110000-ffff"), "has lastAnalyzedAt despite reading 'recorded'");
});

test("selectors other than ids combine with AND", () => {
  const plan = planPrune(
    SESSIONS,
    { only_unanalyzed: true, older_than_days: 5, keep_recent: 0 },
    { now: NOW }
  );
  assert.deepEqual(ids(plan), ["20260728-110000-dddd"]);
});

test("an explicit id list overrides the selectors, including keep_recent", () => {
  const plan = planPrune(
    SESSIONS,
    { ids: ["20260803-110000-aaaa"], older_than_days: 90 },
    { now: NOW }
  );
  assert.deepEqual(ids(plan), ["20260803-110000-aaaa"], "an explicit list is an explicit instruction");
});

test("an unknown id is reported rather than silently ignored", () => {
  const plan = planPrune(SESSIONS, { ids: ["20260101-000000-9999"] }, { now: NOW });
  assert.deepEqual(ids(plan), []);
  assert.match(plan.skipped[0].why, /no such session/);
});

test("a session being recorded right now is never a candidate", () => {
  const target = "20260728-110000-dddd";
  const plan = planPrune(
    SESSIONS,
    { older_than_days: 5 },
    { now: NOW, protectedIds: [target] }
  );
  assert.ok(!ids(plan).includes(target));
  assert.ok(plan.skipped.some((s) => s.id === target && /in progress|active/.test(s.why)));

  const named = planPrune(SESSIONS, { ids: [target] }, { now: NOW, protectedIds: [target] });
  assert.deepEqual(ids(named), [], "not even when named explicitly");
});

test("include_imports on its own selects no sessions", () => {
  const plan = planPrune(SESSIONS, { include_imports: true }, { now: NOW });
  assert.equal(plan.refusal, null, "it is a selector, so the request is not empty");
  assert.deepEqual(ids(plan), []);
});

test("totalBytes is the sum of what would go", () => {
  const plan = planPrune(SESSIONS, { older_than_days: 5 }, { now: NOW });
  assert.equal(plan.totalBytes, 400e6 + 500e6 + 600e6);
});

test("a plan reports what it would do and never carries deletions of its own", () => {
  const plan = planPrune(SESSIONS, { older_than_days: 5 }, { now: NOW });
  assert.equal(plan.deleted, undefined, "planning and deleting are separate steps");
  assert.ok(plan.candidates.every((c) => typeof c.reason === "string" && c.reason.length));
});
