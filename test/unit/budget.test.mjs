import test from "node:test";
import assert from "node:assert/strict";

import {
  IMAGE_TOKENS, outputBudget, safeTokenCeiling, estimateTokens, planImages, fitText,
} from "../../src/analyze/budget.mjs";

/**
 * These constants were read out of Claude Code's own MCP accounting rather than
 * guessed, and the entire output shape follows from them. If they drift, the tool
 * silently starts returning results that get truncated mid-evidence.
 */

test("the documented budget constants hold", () => {
  assert.equal(IMAGE_TOKENS, 1600);
  assert.equal(outputBudget(), 25_000);
  assert.equal(safeTokenCeiling(), 12_500);
});

test("MAX_MCP_OUTPUT_TOKENS overrides the default budget", () => {
  const prev = process.env.MAX_MCP_OUTPUT_TOKENS;
  process.env.MAX_MCP_OUTPUT_TOKENS = "50000";
  try {
    assert.equal(outputBudget(), 50_000);
    assert.equal(safeTokenCeiling(), 25_000);
  } finally {
    if (prev === undefined) delete process.env.MAX_MCP_OUTPUT_TOKENS;
    else process.env.MAX_MCP_OUTPUT_TOKENS = prev;
  }
});

test("an invalid override falls back to the default", () => {
  const prev = process.env.MAX_MCP_OUTPUT_TOKENS;
  process.env.MAX_MCP_OUTPUT_TOKENS = "not-a-number";
  try {
    assert.equal(outputBudget(), 25_000);
  } finally {
    if (prev === undefined) delete process.env.MAX_MCP_OUTPUT_TOKENS;
    else process.env.MAX_MCP_OUTPUT_TOKENS = prev;
  }
});

test("estimateTokens charges a flat rate per image plus chars/4", () => {
  assert.equal(estimateTokens({ images: 0, textChars: 0 }), 0);
  assert.equal(estimateTokens({ images: 3, textChars: 400 }), 3 * 1600 + 100);
});

test("planImages reserves the first slot for the contact sheet", () => {
  const plan = planImages({ maxImages: 6 });
  assert.equal(plan.sheet, 1);
  assert.equal(plan.detail, 5);
  assert.equal(plan.total, 6);
});

test("planImages never exceeds what the ceiling can afford", () => {
  for (const maxImages of [1, 4, 6, 7, 20]) {
    const plan = planImages({ maxImages });
    assert.ok(plan.total >= 1, "always at least one image");
    assert.ok(
      plan.total * IMAGE_TOKENS < safeTokenCeiling(),
      `${plan.total} images must fit under ${safeTokenCeiling()} tokens`
    );
    assert.ok(plan.total <= maxImages, "never returns more than requested");
  }
});

test("planImages caps the contact sheet at 16 cells", () => {
  assert.equal(planImages({ maxImages: 6, sheetCells: 64 }).sheetCells, 16);
  assert.equal(planImages({ maxImages: 6, sheetCells: 9 }).sheetCells, 9);
});

test("fitText leaves a payload that already fits untouched", () => {
  const text = "a short timeline";
  const { text: out, truncated } = fitText(text, { images: 6 });
  assert.equal(out, text);
  assert.equal(truncated, false);
});

test("fitText truncates so images plus text stay inside the ceiling", () => {
  const huge = "x".repeat(200_000);
  const { text, truncated } = fitText(huge, { images: 6 });

  assert.equal(truncated, true);
  const total = estimateTokens({ images: 6, textChars: text.length });
  assert.ok(
    total <= safeTokenCeiling(),
    `truncated payload still over ceiling: ${total} > ${safeTokenCeiling()}`
  );
  assert.match(text, /get_frames/, "truncation must tell the reader how to see more");
});

test("fitText keeps a usable minimum even when images consume the budget", () => {
  const { text } = fitText("y".repeat(50_000), { images: 7 });
  assert.ok(text.length >= 400, "never truncate the timeline down to nothing");
});
