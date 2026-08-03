import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Repo/plugin root, whether run via --plugin-dir or directly from a checkout. */
export const PLUGIN_ROOT =
  process.env.FLIPBOOK_PLUGIN_ROOT || path.resolve(here, "..", "..");

/**
 * Recordings live outside the repo so a `git clean` or plugin reinstall never
 * destroys evidence, and so they are never accidentally committed.
 */
export const DATA_HOME =
  process.env.FLIPBOOK_HOME || path.join(homedir(), ".flipbook");

export const SESSIONS_DIR = path.join(DATA_HOME, "sessions");
export const NATIVE_DIR = path.join(DATA_HOME, "bin");

/**
 * Work directories for videos assembled from stills or GIFs passed by path. Pure derived
 * data — rebuildable from the user's original file — so it is always safe to delete, but
 * nothing ever did, and it grows without limit.
 */
export const IMPORTS_DIR = path.join(DATA_HOME, "imports");

/** Where the PostToolUse hook and the server agree to meet. */
export const ACTIVE_SESSION_FILE = path.join(DATA_HOME, "active-session");

export function ensureDirs() {
  for (const d of [DATA_HOME, SESSIONS_DIR, NATIVE_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

/** The exact shape newSessionId() produces: 20260803-101010-a1b2. */
export const SESSION_ID_PATTERN = /^\d{8}-\d{6}-[0-9a-f]{4}$/;

export function isValidSessionId(id) {
  return typeof id === "string" && SESSION_ID_PATTERN.test(id);
}

/**
 * Every session path is derived from here, so this is the one place that has to
 * refuse a hostile id.
 *
 * Session ids arrive as MCP tool arguments, which makes them caller-controlled. Left
 * unchecked, path.join walks straight out of the data directory: a traversing id
 * resolved to /tmp/…/events.jsonl, and `mark` would then append there. Validating at
 * the chokepoint covers every helper built on it — meta, events, video, frames —
 * instead of relying on each call site to remember.
 */
export function sessionDir(id) {
  if (!isValidSessionId(id)) {
    throw new Error(
      `invalid session id ${JSON.stringify(id)} — expected the form 20260803-101010-a1b2. ` +
        `Use list_recordings to see valid ids.`
    );
  }
  return path.join(SESSIONS_DIR, id);
}
