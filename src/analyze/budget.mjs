/**
 * Budget constants, taken from Claude Code's own MCP accounting rather than guessed.
 *
 *   images cost a flat 1600 tokens each, regardless of dimensions
 *   the MCP output budget defaults to 25,000 tokens (MAX_MCP_OUTPUT_TOKENS)
 *   a result stays completely untruncated only while it is under 50% of that
 *
 * So the safe working ceiling is ~12,500 tokens, which is about seven images with
 * nothing else, or six images plus a few thousand characters of timeline.
 */
export const IMAGE_TOKENS = 1600;
export const CHARS_PER_TOKEN = 4;

export function outputBudget() {
  const n = Number(process.env.MAX_MCP_OUTPUT_TOKENS);
  return Number.isFinite(n) && n > 0 ? n : 25_000;
}

export function safeTokenCeiling() {
  return Math.floor(outputBudget() * 0.5);
}

export function estimateTokens({ images = 0, textChars = 0 }) {
  return images * IMAGE_TOKENS + Math.ceil(textChars / CHARS_PER_TOKEN);
}

/**
 * Split an image allowance into one contact sheet plus detail frames.
 * The sheet always wins the first slot: it is the only item that describes the whole
 * recording, and losing it costs far more understanding than losing a detail frame.
 */
export function planImages({ maxImages = 6, sheetCells = 16 } = {}) {
  const ceiling = safeTokenCeiling();
  const affordable = Math.max(1, Math.floor((ceiling - 1500) / IMAGE_TOKENS));
  const total = Math.max(1, Math.min(maxImages, affordable));
  return {
    total,
    sheet: 1,
    detail: Math.max(0, total - 1),
    sheetCells: Math.min(sheetCells, 16),
    ceiling,
  };
}

/** Trim a text block so images plus text stay inside the no-truncation zone. */
export function fitText(text, { images }) {
  const ceiling = safeTokenCeiling();
  const imageTokens = images * IMAGE_TOKENS;
  const allowedChars = Math.max(500, (ceiling - imageTokens) * CHARS_PER_TOKEN);
  if (text.length <= allowedChars) return { text, truncated: false };
  const keep = Math.floor(allowedChars) - 120;
  return {
    text:
      text.slice(0, keep) +
      `\n… timeline truncated to fit the MCP output budget. ` +
      `Use get_frames with a time range to inspect any period in full.`,
    truncated: true,
  };
}
