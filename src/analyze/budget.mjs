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
const CHARS_PER_TOKEN = 4;

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

/**
 * Split the remaining character allowance between the two variable-length text blocks.
 *
 * `fixedChars` must include everything else the response carries — per-image captions
 * and the resource-link description — because those are text too. Budgeting only the
 * header and timeline is what pushed a real measured payload over the ceiling it
 * advertises: six images plus captions plus a long rubric came to more than 12,500
 * tokens while every individual piece looked fine.
 *
 * The timeline gets a guaranteed floor. It is the only channel that describes moments
 * no image was spent on, and a caller-supplied rubric of arbitrary length must not be
 * able to starve it — previously a rubric over ~11,000 characters removed the timeline
 * from the response entirely.
 */
export function allocateText({ images, fixedChars = 0 }) {
  const ceiling = safeTokenCeiling();
  const available = (ceiling - images * IMAGE_TOKENS) * CHARS_PER_TOKEN - fixedChars;
  const total = Math.max(1200, available);
  const timeline = Math.max(800, Math.floor(total * 0.4));
  const header = Math.max(400, total - timeline);
  return { total, header, timeline };
}

/** Clamp one block to a character budget, saying so in-band when it had to cut. */
export function clampText(text, maxChars, note) {
  if (text.length <= maxChars) return { text, truncated: false };
  const suffix = `\n… ${note}`;
  const keep = Math.max(0, maxChars - suffix.length);
  return { text: text.slice(0, keep) + suffix, truncated: true };
}
