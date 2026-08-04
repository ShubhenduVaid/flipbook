import fs from "node:fs";
import path from "node:path";
import { IMPORTS_DIR } from "../env/paths.mjs";
import { deleteSession, dirSize, isReclaimable } from "./session.mjs";

/**
 * Deciding what to delete, kept separate from doing it.
 *
 * A day of real use produced 4.5 GB across thirteen recordings, one of them a single
 * 1.0 GB file, and two sessions stranded at "recorded" because they were stopped with
 * analyze:false to start a replacement. Nothing in the tool had ever measured or
 * reclaimed any of it.
 *
 * The policy is pure so the whole selector matrix can be tested without a filesystem;
 * the effect goes through session.deleteSession, which is the only guarded delete.
 */

/** Protect the most recent sessions from every selector except an explicit id list. */
export const DEFAULT_KEEP_RECENT = 3;

export function planPrune(sessions, selectors = {}, { now = Date.now(), protectedIds = [] } = {}) {
  const empty = { candidates: [], skipped: [], totalBytes: 0, refusal: null };

  const hasSelector =
    (selectors.ids?.length ?? 0) > 0 ||
    selectors.older_than_days != null ||
    selectors.only_unanalyzed === true ||
    selectors.include_imports === true;

  // Dry-run-by-default protects an empty call, but `{confirm: true}` on its own would
  // delete everything. Refuse for dry runs too, so the dry run teaches the right call
  // rather than showing a listing of the entire store.
  if (!hasSelector) {
    return {
      ...empty,
      refusal:
        "prune_recordings needs at least one selector. Refusing to read an empty request " +
        "as \"everything\". Use older_than_days, only_unanalyzed, ids, or include_imports.",
    };
  }

  const byId = new Map(sessions.map((s) => [s.id, s]));
  const skipped = [];
  const protectedSet = new Set(protectedIds);

  // An explicit list is an explicit instruction, so it overrides the other selectors —
  // including keep_recent, whose whole point is to protect against a broad sweep.
  if (selectors.ids?.length) {
    const candidates = [];
    for (const id of selectors.ids) {
      const meta = byId.get(id);
      if (!meta) {
        skipped.push({ id, why: "no such session" });
        continue;
      }
      if (protectedSet.has(id)) {
        skipped.push({ id, why: "recording in progress or the active session" });
        continue;
      }
      candidates.push(describe(meta, "named explicitly"));
    }
    return { candidates, skipped, totalBytes: sum(candidates), refusal: null };
  }

  const keepRecent = selectors.keep_recent ?? DEFAULT_KEEP_RECENT;
  const newestFirst = [...sessions].sort((a, b) => String(b.id).localeCompare(String(a.id)));
  const kept = new Set(newestFirst.slice(0, keepRecent).map((s) => s.id));

  const candidates = [];
  for (const meta of newestFirst) {
    if (protectedSet.has(meta.id)) {
      skipped.push({ id: meta.id, why: "recording in progress or the active session" });
      continue;
    }
    if (kept.has(meta.id)) {
      skipped.push({ id: meta.id, why: `among the ${keepRecent} most recent (keep_recent)` });
      continue;
    }

    const reasons = [];
    if (selectors.older_than_days != null) {
      const ageDays = (now - Date.parse(meta.createdAt ?? 0)) / 86_400_000;
      if (!(ageDays > selectors.older_than_days)) continue;
      reasons.push(`${ageDays.toFixed(0)} days old`);
    }
    if (selectors.only_unanalyzed === true) {
      if (!isReclaimable(meta)) continue;
      reasons.push("never analysed");
    }
    // include_imports on its own selects no sessions at all, which is the right reading
    // of "just clear the import cache".
    if (!reasons.length) continue;

    candidates.push(describe(meta, reasons.join(", ")));
  }

  return { candidates, skipped, totalBytes: sum(candidates), refusal: null };
}

function describe(meta, reason) {
  return {
    id: meta.id,
    label: meta.label ?? null,
    status: meta.status ?? "unknown",
    createdAt: meta.createdAt ?? null,
    bytes: meta.bytes ?? 0,
    reason,
  };
}

function sum(rows) {
  return rows.reduce((n, r) => n + (r.bytes || 0), 0);
}

/** Execute a plan. Every deletion goes through the guarded sessionDir chokepoint. */
export function applyPrune(plan) {
  const deleted = [];
  const failed = [];
  for (const c of plan.candidates) {
    try {
      deleted.push(deleteSession(c.id));
    } catch (err) {
      failed.push({ id: c.id, error: err.message });
    }
  }
  return { deleted, failed, bytesFreed: deleted.reduce((n, d) => n + d.bytes, 0) };
}

/** Clear the import cache — derived data, rebuilt on demand from the user's own files. */
export function pruneImports({ dryRun = true } = {}) {
  if (!fs.existsSync(IMPORTS_DIR)) return { bytes: 0, entries: 0, cleared: false };
  const entries = fs.readdirSync(IMPORTS_DIR);
  const bytes = dirSize(IMPORTS_DIR);
  if (!dryRun) {
    for (const e of entries) fs.rmSync(path.join(IMPORTS_DIR, e), { recursive: true, force: true });
  }
  return { bytes, entries: entries.length, cleared: !dryRun };
}
