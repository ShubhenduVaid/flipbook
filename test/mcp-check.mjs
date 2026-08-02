/**
 * Drive the server over a real stdio MCP session, the way Claude Code does.
 *
 *   node test/mcp-check.mjs
 *
 * Checks tool discovery, doctor, list_recordings, and a full analyze_recording round
 * trip — including that images come back as native image content blocks rather than
 * base64 stringified into text, which is the assumption the whole design rests on.
 */
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, "..", "src", "server.mjs");
const fixtureVideo = path.join(here, "..", ".fixture-out", "front", "run.mov");

let failures = 0;
const check = (ok, label, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const transport = new StdioClientTransport({ command: "node", args: [serverPath] });
const client = new Client({ name: "video-qa-check", version: "0.1.0" });
await client.connect(transport);
console.log("connected to server\n");

// --- tool discovery ---------------------------------------------------------
const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
console.log("tools:", names.join(", "), "\n");
const expected = [
  "analyze_recording", "doctor", "get_frames", "list_recordings",
  "mark", "start_recording", "stop_recording",
];
check(expected.every((n) => names.includes(n)), "all 7 tools registered");
check(
  tools.every((t) => t.description && t.description.length > 40),
  "every tool has a substantive description"
);

// --- doctor -----------------------------------------------------------------
const doc = await client.callTool({ name: "doctor", arguments: {} });
const docText = doc.content.find((c) => c.type === "text")?.text ?? "";
check(!doc.isError, "doctor runs");
check(/screen recording permission/i.test(docText), "doctor reports permission state");
check(doc.structuredContent?.ready === true, "doctor says ready", doc.structuredContent?.summary);

// --- list_recordings --------------------------------------------------------
const list = await client.callTool({ name: "list_recordings", arguments: { limit: 5 } });
check(!list.isError, "list_recordings runs");

// --- analyze_recording ------------------------------------------------------
if (!fs.existsSync(fixtureVideo)) {
  console.log(`\n  SKIP analyze_recording — no fixture at ${fixtureVideo}`);
  console.log("  run: node test/fixture-run.mjs --front");
} else {
  const res = await client.callTool({
    name: "analyze_recording",
    arguments: {
      path: fixtureVideo,
      rubric: "A spinner appears.\nA confirmation panel appears.\nA toast appears and disappears.",
      max_images: 6,
    },
  });
  check(!res.isError, "analyze_recording runs", res.isError ? res.content[0]?.text : "");

  const images = res.content.filter((c) => c.type === "image");
  const texts = res.content.filter((c) => c.type === "text");
  const links = res.content.filter((c) => c.type === "resource_link");

  check(images.length >= 2, `returns image blocks (${images.length})`);
  check(images.length <= 7, `stays within the 7-image ceiling (${images.length})`);
  check(
    images.every((i) => i.mimeType === "image/jpeg" && typeof i.data === "string" && i.data.length > 1000),
    "images are real base64 image blocks, not stringified text"
  );
  check(links.length === 1, "returns a resource_link to the recording");
  check(
    texts.some((t) => /VALIDATION RUBRIC/.test(t.text)),
    "rubric is echoed back for judging"
  );
  check(texts.some((t) => /TIMELINE/.test(t.text)), "timeline is present");

  const sc = res.structuredContent;
  check(sc?.estimatedTokens <= sc?.tokenCeiling,
    `estimated tokens within ceiling (${sc?.estimatedTokens}/${sc?.tokenCeiling})`);

  // The budget claim, measured against Claude Code's own accounting.
  const textChars = texts.reduce((n, t) => n + t.text.length, 0);
  const measured = images.length * 1600 + Math.ceil(textChars / 4);
  check(measured <= 12_500, `measured payload under no-truncation ceiling (${measured} tokens)`);

  // --- get_frames drill-down ------------------------------------------------
  const gf = await client.callTool({
    name: "get_frames",
    arguments: { path: fixtureVideo, from: 1, to: 3, max_images: 2 },
  });
  check(!gf.isError, "get_frames runs", gf.isError ? gf.content[0]?.text : "");
  check(gf.content.filter((c) => c.type === "image").length >= 1, "get_frames returns images");

  const gfAt = await client.callTool({
    name: "get_frames",
    arguments: { path: fixtureVideo, at: [1.25, 5.25], max_images: 2 },
  });
  check(
    gfAt.content.filter((c) => c.type === "image").length === 2,
    "get_frames honours exact timestamps"
  );
}

// --- error handling ---------------------------------------------------------
const bad = await client.callTool({ name: "analyze_recording", arguments: { path: "/nope/missing.mov" } });
check(bad.isError === true, "missing file returns a clean error, not a crash");

const noArgs = await client.callTool({ name: "get_frames", arguments: {} });
check(noArgs.isError === true, "get_frames without a source errors cleanly");

await client.close();
console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
