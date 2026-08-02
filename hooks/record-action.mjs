#!/usr/bin/env node
/**
 * PostToolUse hook: append every Claude-in-Chrome action to the active recording's
 * event log, so each extracted frame can be labelled with the action that caused it.
 *
 * Runs on every matching tool call, so it must be fast, silent and incapable of
 * breaking the tool call it observes: any failure exits 0 without output.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DATA_HOME = process.env.VIDEO_QA_HOME || path.join(os.homedir(), ".video-qa");
const ACTIVE = path.join(DATA_HOME, "active-session");

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/** Keep only the fields worth a timeline row; tool inputs can be very large. */
function summarizeInput(input) {
  if (!input || typeof input !== "object") return {};
  const keep = ["action", "coordinate", "text", "url", "selector", "key", "direction", "value", "ref"];
  const out = {};
  for (const k of keep) {
    if (input[k] == null) continue;
    const v = input[k];
    out[k] = typeof v === "string" ? v.slice(0, 120) : Array.isArray(v) ? v.slice(0, 4) : v;
  }
  return out;
}

try {
  // No recording in progress is the common case — do nothing, cheaply.
  if (!fs.existsSync(ACTIVE)) process.exit(0);
  const sessionId = fs.readFileSync(ACTIVE, "utf8").trim();
  if (!sessionId) process.exit(0);

  const eventsFile = path.join(DATA_HOME, "sessions", sessionId, "events.jsonl");
  if (!fs.existsSync(path.dirname(eventsFile))) process.exit(0);

  const raw = readStdin();
  if (!raw) process.exit(0);

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const toolName = payload.tool_name || payload.toolName || "";
  if (!toolName.startsWith("mcp__claude-in-chrome__")) process.exit(0);

  const response = payload.tool_response ?? payload.toolResponse;
  let ok = true;
  if (response && typeof response === "object") {
    if (response.isError === true) ok = false;
  }

  fs.appendFileSync(
    eventsFile,
    JSON.stringify({
      tsMs: Date.now(),
      type: "tool",
      tool: toolName,
      input: summarizeInput(payload.tool_input ?? payload.toolInput),
      ok,
    }) + "\n"
  );
} catch {
  // Never let observation break the thing being observed.
}
process.exit(0);
