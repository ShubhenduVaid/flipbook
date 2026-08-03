import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  SESSIONS_DIR, IMPORTS_DIR, ACTIVE_SESSION_FILE, ensureDirs, sessionDir, isValidSessionId,
} from "../env/paths.mjs";

export { isValidSessionId };

/** Sortable, human-readable, collision-resistant: 20260802-114900-a1b2. */
function newSessionId() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, "0");
  const stamp =
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${stamp}-${crypto.randomBytes(2).toString("hex")}`;
}

export function createSession(meta) {
  ensureDirs();
  const id = newSessionId();
  const dir = sessionDir(id);
  fs.mkdirSync(path.join(dir, "frames"), { recursive: true });
  const full = {
    id,
    createdAt: new Date().toISOString(),
    status: "recording",
    ...meta,
  };
  writeMeta(id, full);
  return full;
}

function metaPath(id) {
  return path.join(sessionDir(id), "meta.json");
}

function writeMeta(id, meta) {
  fs.writeFileSync(metaPath(id), JSON.stringify(meta, null, 2));
}

/**
 * Look up a session. A malformed id is "no such session", not an exception — callers
 * use a null return to produce their own message, and a lookup should not throw just
 * because someone passed a bad string.
 */
export function readMeta(id) {
  if (!isValidSessionId(id)) return null;
  const p = metaPath(id);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

export function updateMeta(id, patch) {
  const cur = readMeta(id) || { id };
  const next = { ...cur, ...patch };
  writeMeta(id, next);
  return next;
}

/** Every session id on disk, newest first. */
function allSessionIds() {
  if (!fs.existsSync(SESSIONS_DIR)) return [];
  return fs
    .readdirSync(SESSIONS_DIR)
    // Skip anything that is not a session directory; sessionDir now rejects
    // non-conforming names, and a stray file should not break the listing.
    .filter((d) => isValidSessionId(d) && fs.existsSync(metaPath(d)))
    .sort()
    .reverse();
}

export function listSessions({ limit = 25, withSize = false } = {}) {
  return allSessionIds()
    .slice(0, limit)
    .map((id) => {
      const meta = readMeta(id);
      if (!meta) return null;
      return withSize ? { ...meta, bytes: sessionSize(id).bytes, reclaimable: isReclaimable(meta) } : meta;
    })
    .filter(Boolean);
}

/**
 * Whether a session's evidence was ever actually looked at.
 *
 * Status alone is not enough: only stop_recording writes status "analyzed", while
 * analyze_recording and get_frames leave it at "recorded" — so a session analysed five
 * minutes ago would otherwise be offered up for deletion. Those tools stamp
 * lastAnalyzedAt for exactly this reason.
 */
export function isReclaimable(meta) {
  return (meta.status === "recorded" || meta.status === "failed") && meta.lastAnalyzedAt == null;
}

/**
 * Recursive byte total, never following symlinks.
 *
 * rmSync(recursive) does not follow them either, so counting a link's target would make
 * prune's dry run promise space it cannot free.
 */
export function dirSize(dir) {
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) total += dirSize(p);
      else total += fs.lstatSync(p).size;
    } catch {
      // A file vanishing mid-walk is not worth failing a listing over.
    }
  }
  return total;
}

/**
 * Bytes in one session, broken down.
 *
 * Measured, not read from meta.bytes — that records only the .mov, while frames/ and
 * frames/drilldown/ grow every time get_frames is called.
 */
export function sessionSize(id) {
  let dir;
  try {
    dir = sessionDir(id);
  } catch {
    return { bytes: 0, video: 0, frames: 0, other: 0 };
  }
  const video = fs.existsSync(videoPath(id)) ? fs.lstatSync(videoPath(id)).size : 0;
  const frames = dirSize(framesDir(id));
  const bytes = dirSize(dir);
  return { bytes, video, frames, other: Math.max(0, bytes - video - frames) };
}

/** Whole-store accounting, across every session rather than one listed page. */
export function totalFootprint() {
  let bytes = 0;
  let reclaimableBytes = 0;
  let reclaimableCount = 0;
  const ids = allSessionIds();
  for (const id of ids) {
    const size = sessionSize(id).bytes;
    bytes += size;
    const meta = readMeta(id);
    if (meta && isReclaimable(meta)) {
      reclaimableBytes += size;
      reclaimableCount++;
    }
  }
  return {
    sessions: ids.length,
    bytes,
    reclaimableBytes,
    reclaimableCount,
    importsBytes: fs.existsSync(IMPORTS_DIR) ? dirSize(IMPORTS_DIR) : 0,
  };
}

/**
 * Remove one session directory. The only destructive path in the codebase.
 *
 * Deliberately holds no policy about whether a session *should* go — that lives in
 * planPrune, which is pure and testable. This function's whole job is not escaping the
 * data directory.
 */
export function deleteSession(id) {
  // sessionDir rejects any id that is not the exact generated shape, which covers every
  // traversal. The resolve check below is belt and braces: this is the first thing in
  // the repo that deletes, and it is worth two independent guards.
  const dir = sessionDir(id);
  const root = path.resolve(SESSIONS_DIR) + path.sep;
  if (!path.resolve(dir).startsWith(root)) {
    throw new Error(`refusing to delete ${dir}: outside ${SESSIONS_DIR}`);
  }
  const bytes = dirSize(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  return { id, bytes };
}

/**
 * The active-session pointer is how the PostToolUse hook — a separate short-lived
 * process with no knowledge of the server — finds the event log to append to.
 */
export function setActiveSession(id) {
  ensureDirs();
  if (id) fs.writeFileSync(ACTIVE_SESSION_FILE, id);
  else if (fs.existsSync(ACTIVE_SESSION_FILE)) fs.rmSync(ACTIVE_SESSION_FILE);
}

export function getActiveSession() {
  if (!fs.existsSync(ACTIVE_SESSION_FILE)) return null;
  const id = fs.readFileSync(ACTIVE_SESSION_FILE, "utf8").trim();
  // The pointer is a file on disk, so treat its contents as untrusted too.
  return isValidSessionId(id) ? id : null;
}

export function eventsPath(id) {
  return path.join(sessionDir(id), "events.jsonl");
}

export function appendEvent(id, event) {
  fs.appendFileSync(eventsPath(id), JSON.stringify(event) + "\n");
}

export function readEvents(id) {
  const p = eventsPath(id);
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function videoPath(id) {
  return path.join(sessionDir(id), "video.mov");
}

export function framesDir(id) {
  return path.join(sessionDir(id), "frames");
}
