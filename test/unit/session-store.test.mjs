import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Storage accounting and the one destructive path in the codebase.
 *
 * This lives in its own file because DATA_HOME is resolved when paths.mjs first loads,
 * so FLIPBOOK_HOME has to be set before any import of it — which means a dynamic import
 * after the assignment below.
 */
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "flipbook-store-"));
process.env.FLIPBOOK_HOME = HOME;

const { dirSize, sessionSize, totalFootprint, deleteSession, listSessions, isReclaimable } =
  await import("../../src/capture/session.mjs");

const SESSIONS = path.join(HOME, "sessions");

function makeSession(id, { status = "recorded", videoBytes = 1000, frameBytes = 500, extra = {} } = {}) {
  const dir = path.join(SESSIONS, id);
  fs.mkdirSync(path.join(dir, "frames", "drilldown"), { recursive: true });
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ id, status, createdAt: new Date().toISOString(), ...extra }));
  fs.writeFileSync(path.join(dir, "video.mov"), Buffer.alloc(videoBytes));
  fs.writeFileSync(path.join(dir, "frames", "contact-sheet.jpg"), Buffer.alloc(frameBytes));
  fs.writeFileSync(path.join(dir, "frames", "drilldown", "at-1_00s.jpg"), Buffer.alloc(frameBytes));
  return dir;
}

// A day of ordinary use reached 4.5 GB and nothing reported it, partly because
// meta.bytes only ever recorded the .mov while every get_frames call added another
// full-resolution still under frames/drilldown/.
test("a session's size counts its frames and drill-downs, not just the video", () => {
  makeSession("20260803-101010-a1b2", { videoBytes: 1000, frameBytes: 500 });
  const size = sessionSize("20260803-101010-a1b2");

  assert.equal(size.video, 1000);
  assert.equal(size.frames, 1000, "contact sheet plus drilldown");
  assert.ok(size.bytes >= 2000);
});

test("dirSize does not follow a symlink out of the tree", () => {
  const outside = path.join(HOME, "outside.bin");
  fs.writeFileSync(outside, Buffer.alloc(1_000_000));
  const dir = makeSession("20260803-101011-a1b3", { videoBytes: 10, frameBytes: 10 });
  fs.symlinkSync(outside, path.join(dir, "link.bin"));

  // rmSync does not follow it either, so counting the target would promise space that
  // pruning cannot actually free.
  assert.ok(dirSize(dir) < 1000, `symlink target was counted: ${dirSize(dir)}`);
});

test("totalFootprint spans every session and flags the reclaimable ones", () => {
  const f = totalFootprint();
  assert.ok(f.sessions >= 2);
  assert.ok(f.bytes > 0);
  assert.ok(f.reclaimableCount >= 1, "recorded and never analysed");
});

test("a session analysed through analyze_recording is not reclaimable", () => {
  assert.equal(isReclaimable({ status: "recorded" }), true);
  assert.equal(isReclaimable({ status: "recorded", lastAnalyzedAt: Date.now() }), false);
  assert.equal(isReclaimable({ status: "analyzed" }), false);
});

test("listSessions can report sizes without being asked to by default", () => {
  assert.equal(listSessions({ limit: 1 })[0].bytes, undefined);
  assert.ok(listSessions({ limit: 1, withSize: true })[0].bytes > 0);
});

test("deleteSession removes a session and reports what it freed", () => {
  makeSession("20260803-101012-a1b4");
  const before = totalFootprint().bytes;
  const { bytes } = deleteSession("20260803-101012-a1b4");

  assert.ok(bytes > 0);
  assert.equal(fs.existsSync(path.join(SESSIONS, "20260803-101012-a1b4")), false);
  assert.equal(totalFootprint().bytes, before - bytes);
});

// Deletion is the first destructive path in this codebase, so it gets the same
// traversal set that guards every read path.
test("deletion cannot escape the data directory", () => {
  const TRAVERSALS = [
    "../../../../tmp/pwned",
    "..",
    "../sessions",
    "foo/../../bar",
    "/etc/passwd",
    "20260803-101010-a1b2/../../escape",
    "20260803-101010-a1b2/nested",
  ];
  for (const id of TRAVERSALS) {
    assert.throws(() => deleteSession(id), /invalid session id/, `deleteSession accepted ${id}`);
  }
  assert.equal(fs.existsSync(path.join(SESSIONS, "20260803-101010-a1b2")), true, "nothing was collaterally removed");
});

test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));
