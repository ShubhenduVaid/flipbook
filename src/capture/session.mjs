import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { SESSIONS_DIR, ACTIVE_SESSION_FILE, ensureDirs, sessionDir } from "../env/paths.mjs";

/** Sortable, human-readable, collision-resistant: 20260802-114900-a1b2. */
export function newSessionId() {
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

export function metaPath(id) {
  return path.join(sessionDir(id), "meta.json");
}

export function writeMeta(id, meta) {
  fs.writeFileSync(metaPath(id), JSON.stringify(meta, null, 2));
}

export function readMeta(id) {
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

export function listSessions({ limit = 25 } = {}) {
  if (!fs.existsSync(SESSIONS_DIR)) return [];
  return fs
    .readdirSync(SESSIONS_DIR)
    .filter((d) => fs.existsSync(metaPath(d)))
    .sort()
    .reverse()
    .slice(0, limit)
    .map((id) => readMeta(id))
    .filter(Boolean);
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
  return id || null;
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
