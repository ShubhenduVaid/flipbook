import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  isValidSessionId, sessionDir, SESSION_ID_PATTERN, DATA_HOME,
} from "../../src/env/paths.mjs";
import { readMeta, eventsPath, videoPath, framesDir } from "../../src/capture/session.mjs";

/**
 * Session ids arrive as MCP tool arguments, so they are caller-controlled. Before this
 * was enforced, eventsPath('../../../../tmp/x') resolved to /tmp/x/events.jsonl and
 * `mark` would append there — a write outside the data directory.
 */

const TRAVERSALS = [
  "../../../../tmp/pwned",
  "..",
  "../sessions",
  "foo/../../bar",
  "/etc/passwd",
  "20260803-101010-a1b2/../../escape",
  "20260803-101010-a1b2/nested",
];

test("a well-formed id is accepted", () => {
  assert.ok(isValidSessionId("20260803-101010-a1b2"));
  assert.ok(SESSION_ID_PATTERN.test("20260803-101010-a1b2"));
});

test("malformed ids are rejected", () => {
  for (const bad of [...TRAVERSALS, "", "   ", "not-an-id", "20260803-101010-A1B2", null, undefined, 42, {}]) {
    assert.equal(isValidSessionId(bad), false, `${JSON.stringify(bad)} should be rejected`);
  }
});

test("sessionDir refuses to build a path from a traversing id", () => {
  for (const bad of TRAVERSALS) {
    assert.throws(() => sessionDir(bad), /invalid session id/i, `${bad} should throw`);
  }
});

test("no session path helper can escape the data directory", () => {
  for (const helper of [eventsPath, videoPath, framesDir]) {
    for (const bad of TRAVERSALS) {
      assert.throws(() => helper(bad), /invalid session id/i);
    }
    // And a valid id always lands inside.
    const p = helper("20260803-101010-a1b2");
    assert.ok(
      path.resolve(p).startsWith(path.resolve(DATA_HOME)),
      `${p} escaped ${DATA_HOME}`
    );
  }
});

test("readMeta treats a malformed id as 'no such session' rather than throwing", () => {
  // A lookup should not explode just because someone passed a bad string; the tools
  // turn a null return into their own message.
  for (const bad of TRAVERSALS) {
    assert.equal(readMeta(bad), null);
  }
});
