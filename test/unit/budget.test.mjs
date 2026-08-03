import test from "node:test";
import assert from "node:assert/strict";

import {
  IMAGE_TOKENS, outputBudget, safeTokenCeiling, estimateTokens, planImages, allocateText, clampText,
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

test("clampText leaves a block that already fits untouched", () => {
  const text = "a short timeline";
  const { text: out, truncated } = clampText(text, 1000, "trimmed");
  assert.equal(out, text);
  assert.equal(truncated, false);
});

test("clampText cuts to the budget and says so in-band", () => {
  const { text, truncated } = clampText("x".repeat(5000), 500, "use get_frames for more");
  assert.equal(truncated, true);
  assert.ok(text.length <= 500, `clamped to ${text.length}, budget was 500`);
  assert.match(text, /get_frames/, "a cut must tell the reader how to see the rest");
});

/**
 * The allocation has to cover the whole response, not just the two big blocks. A real
 * measured payload went over the advertised ceiling because per-image captions and the
 * resource-link description were never counted.
 */
test("allocateText accounts for the fixed text the response also carries", () => {
  const withoutFixed = allocateText({ images: 6, fixedChars: 0 });
  const withFixed = allocateText({ images: 6, fixedChars: 2000 });
  assert.ok(
    withFixed.total < withoutFixed.total,
    "captions must reduce what is left for header and timeline"
  );
});

test("allocateText keeps images plus all text inside the ceiling", () => {
  for (const images of [1, 4, 6, 7]) {
    const fixedChars = 800;
    const { header, timeline } = allocateText({ images, fixedChars });
    const total = estimateTokens({ images, textChars: header + timeline + fixedChars });
    assert.ok(
      total <= safeTokenCeiling() || images * 1600 >= safeTokenCeiling(),
      `${images} images + text = ${total} tokens, ceiling ${safeTokenCeiling()}`
    );
  }
});

/**
 * The regression that removed the timeline entirely: a caller-supplied rubric of
 * arbitrary length must never be able to starve the one channel describing moments no
 * image was spent on.
 */
test("the timeline always gets a floor, however large the header wants to be", () => {
  for (const images of [1, 6, 7]) {
    const { timeline } = allocateText({ images, fixedChars: 100_000 });
    assert.ok(timeline >= 800, `timeline allowance collapsed to ${timeline}`);
  }
});
