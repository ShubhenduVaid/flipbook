import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveInput, VIDEO_EXTS, IMAGE_EXTS } from "../../src/analyze/input.mjs";

/**
 * Error paths only. The success paths shell out to ffmpeg, so they live in the
 * integration checks (`npm run test:mcp`) and stay out of CI.
 */

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "flipbook-test-"));
}

test("a GIF is treated as a decodable video, not an image", () => {
  assert.ok(VIDEO_EXTS.has(".gif"), "gif_creator output must be analysable");
  assert.ok(!IMAGE_EXTS.has(".gif"));
});

test("common recording formats are accepted", () => {
  for (const ext of [".mov", ".mp4", ".webm", ".m4v"]) {
    assert.ok(VIDEO_EXTS.has(ext), `${ext} should be supported`);
  }
});

test("a missing path fails with the path in the message", async () => {
  await assert.rejects(
    () => resolveInput("/definitely/not/here.mov"),
    /not found.*not\/here\.mov/s
  );
});

test("a single image is rejected with actionable advice", async () => {
  const dir = tmpdir();
  const file = path.join(dir, "shot.png");
  fs.writeFileSync(file, "not really a png");
  try {
    await assert.rejects(() => resolveInput(file), /single image/i);
    await assert.rejects(() => resolveInput(file), /directory|Read tool/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an unsupported extension lists what is supported", async () => {
  const dir = tmpdir();
  const file = path.join(dir, "notes.txt");
  fs.writeFileSync(file, "hello");
  try {
    await assert.rejects(() => resolveInput(file), /unsupported file type/i);
    await assert.rejects(() => resolveInput(file), /\.mov/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an empty directory is rejected rather than producing an empty analysis", async () => {
  const dir = tmpdir();
  try {
    await assert.rejects(() => resolveInput(dir), /no images found/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a file:// URL is accepted and normalised", async () => {
  const dir = tmpdir();
  try {
    // Resolution happens before decoding, so a missing file still proves the
    // file:// prefix was stripped rather than treated as part of the path.
    await assert.rejects(
      () => resolveInput(`file://${path.join(dir, "missing.mov")}`),
      /not found/
    );
    await assert.rejects(
      () => resolveInput(`file://${path.join(dir, "missing.mov")}`),
      (err) => !err.message.includes("file://")
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
