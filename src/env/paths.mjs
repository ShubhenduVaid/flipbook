import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Repo/plugin root, whether run via --plugin-dir or directly from a checkout. */
export const PLUGIN_ROOT =
  process.env.VIDEO_QA_PLUGIN_ROOT || path.resolve(here, "..", "..");

/**
 * Recordings live outside the repo so a `git clean` or plugin reinstall never
 * destroys evidence, and so they are never accidentally committed.
 */
export const DATA_HOME =
  process.env.VIDEO_QA_HOME || path.join(homedir(), ".video-qa");

export const SESSIONS_DIR = path.join(DATA_HOME, "sessions");
export const NATIVE_DIR = path.join(DATA_HOME, "bin");

/** Where the PostToolUse hook and the server agree to meet. */
export const ACTIVE_SESSION_FILE = path.join(DATA_HOME, "active-session");

export function ensureDirs() {
  for (const d of [DATA_HOME, SESSIONS_DIR, NATIVE_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

export function sessionDir(id) {
  return path.join(SESSIONS_DIR, id);
}
