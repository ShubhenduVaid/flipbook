import { z } from "zod";

/**
 * Parameter shapes shared by more than one tool.
 *
 * `roi` is accepted by stop_recording, analyze_recording and get_frames. Three copies of
 * a description this load-bearing would drift, and the sentence that matters most — that
 * a cropped image is not the page — is exactly the one that would go missing from a copy.
 */
export const roiSchema = z
  .union([
    z.literal("auto"),
    z.object({
      x: z.number().min(0).max(1).describe("Left edge as a fraction of frame width."),
      y: z.number().min(0).max(1).describe("Top edge as a fraction of frame height."),
      w: z.number().min(0.01).max(1).describe("Width as a fraction of frame width."),
      h: z.number().min(0.01).max(1).describe("Height as a fraction of frame height."),
    }),
  ])
  .optional()
  .describe(
    "Crop every returned image to one region of the frame, given as fractions of width " +
      'and height with x,y at the top-left. "auto" derives the region from the pixels ' +
      "that actually changed during the recording. Use this when the thing under test " +
      "occupies a small part of a large window — images cost the same whatever they " +
      "contain, so cropping buys resolution for free. Cropped images show ONLY that " +
      "region: do not describe the rest of the page from one, and do not treat something " +
      "missing from it as absent from the page."
  );

/**
 * Accepted by stop_recording and analyze_recording. The description has one job beyond
 * describing the parameter: stopping the clip being requested as evidence. It is for the
 * person who asked, and it shows Claude nothing the frames do not.
 */
export const clipSchema = z
  .object({
    from: z.number().min(0).optional().describe("Start, in seconds from the beginning of the recording."),
    to: z.number().min(0).optional().describe("End in seconds — relative to `mark` when `mark` is given."),
    mark: z.union([z.string(), z.number().int().min(1)]).optional()
      .describe("Start at a mark: a 1-based index, or a substring of its note."),
    to_mark: z.union([z.string(), z.number().int().min(1)]).optional()
      .describe("End at a mark instead of at `to`."),
    format: z.enum(["mp4", "gif"]).optional().describe("mp4 (default) or gif."),
    fps: z.number().min(1).max(30).optional().describe("Output framerate (default 12 for mp4, 8 for gif)."),
    width: z.number().int().min(160).max(1280).optional()
      .describe("Output width in pixels; height follows the aspect (default 720)."),
  })
  .optional()
  .describe(
    "Also write a short clip and return a link to it. This is for a human to watch and " +
      "share — after validating something, it is what you hand the person who asked. It " +
      "costs no image budget, and it shows you nothing you cannot already see in the " +
      "frames, so do not request one as evidence. Capped at 30 seconds, and never cropped " +
      "by `roi`."
  );
