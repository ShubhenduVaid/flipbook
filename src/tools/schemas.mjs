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
