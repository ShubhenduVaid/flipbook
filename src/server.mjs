#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import fs from "node:fs";
import path from "node:path";

import { runDoctor, formatDoctor } from "./env/doctor.mjs";
import { ensureDirs, DATA_HOME, PLUGIN_ROOT } from "./env/paths.mjs";
import { listSessions, totalFootprint, getActiveSession } from "./capture/session.mjs";
import { planPrune, applyPrune, pruneImports } from "./capture/prune.mjs";
import { activeRecordings } from "./capture/record.mjs";
import { registerCaptureTools } from "./tools/capture-tools.mjs";
import { registerAnalysisTools } from "./tools/analysis-tools.mjs";

// Identity comes from package.json so a release only has to bump the manifests. A
// literal here drifts silently — nothing was comparing it against anything.
const PKG = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "package.json"), "utf8"));

ensureDirs();

const server = new McpServer(
  { name: PKG.name, version: PKG.version },
  {
    instructions:
      "Records a browser window while Claude drives it, then returns visual evidence " +
      "(a labelled contact sheet, full-resolution key frames, and an action-correlated " +
      "timeline) sized to fit the MCP output budget. Claude judges the result against a " +
      "rubric; these tools return evidence, never verdicts. Run `doctor` first if " +
      "anything behaves unexpectedly.",
  }
);

server.registerTool(
  "doctor",
  {
    title: "Check recording prerequisites",
    description:
      "Preflight the recording environment: macOS version, ffmpeg and required filters, " +
      "the native ScreenCaptureKit helper, Screen Recording permission, a target Chrome " +
      "window, and free disk space. Run this first when a recording fails or looks empty.",
    inputSchema: {},
  },
  async () => {
    const result = await runDoctor();
    return {
      content: [{ type: "text", text: formatDoctor(result) }],
      structuredContent: result,
    };
  }
);

server.registerTool(
  "list_recordings",
  {
    title: "List past recordings",
    description:
      "Browse previous recording sessions with their id, label, duration, status and " +
      "video path. Use the id with analyze_recording or get_frames.",
    inputSchema: {
      limit: z.number().int().min(1).max(100).optional()
        .describe("How many recent sessions to return (default 25)."),
    },
  },
  async ({ limit }) => {
    const sessions = listSessions({ limit: limit ?? 25, withSize: true });
    if (!sessions.length) {
      return {
        content: [
          { type: "text", text: `No recordings yet. Recordings are stored under ${DATA_HOME}.` },
        ],
        structuredContent: { sessions: [], footprint: totalFootprint() },
      };
    }
    const lines = sessions.map((s) => {
      const dur = s.durationSec != null ? `${s.durationSec.toFixed(1)}s` : "—";
      // Measured on disk, not read from meta.bytes: that is only the .mov, while every
      // get_frames call adds another full-resolution still under frames/drilldown/.
      const size = `${(s.bytes / 1e6).toFixed(1)} MB`;
      const flag = s.reclaimable ? "*" : " ";
      return (
        `${s.id}  ${String(s.status).padEnd(8)}${flag} ${dur.padStart(8)}  ` +
        `${size.padStart(10)}  ${s.label || ""}`
      );
    });

    const f = totalFootprint();
    const summary = [
      `${sessions.length} of ${f.sessions} session(s) shown · ${fmtBytes(f.bytes)} total` +
        (f.reclaimableCount
          ? ` · ${fmtBytes(f.reclaimableBytes)} in ${f.reclaimableCount} never-analysed session(s) (*)`
          : ""),
    ];
    if (f.importsBytes) summary.push(`imports cache: ${fmtBytes(f.importsBytes)} in ${DATA_HOME}/imports`);
    if (f.reclaimableCount || f.importsBytes) {
      summary.push("Reclaim with prune_recordings — it is a dry run unless confirm is true.");
    }

    return {
      content: [
        {
          type: "text",
          text: [
            "id                     status      duration        size  label",
            ...lines,
            "",
            ...summary,
          ].join("\n"),
        },
      ],
      structuredContent: { sessions, footprint: f },
    };
  }
);

function fmtBytes(n) {
  return n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${(n / 1e6).toFixed(0)} MB`;
}

server.registerTool(
  "prune_recordings",
  {
    title: "Delete old recordings to reclaim disk",
    description:
      "Free disk space used by past recordings. This is a dry run by default: without " +
      "confirm:true it only reports which sessions would be removed and how many bytes " +
      "that would free, and deletes nothing. Recordings are large — window capture runs " +
      "to hundreds of megabytes a minute, plus every extracted frame and contact sheet — " +
      "so check list_recordings or doctor for the current footprint first.",
    inputSchema: {
      confirm: z.boolean().optional()
        .describe("Must be exactly true to delete anything. Omitted or false performs a dry run."),
      older_than_days: z.number().min(0).optional()
        .describe("Only consider sessions created more than this many days ago."),
      keep_recent: z.number().int().min(0).optional()
        .describe(
          "Always keep this many most-recent sessions whatever else matches (default 3). " +
            "Ignored when `ids` is given."
        ),
      only_unanalyzed: z.boolean().optional()
        .describe("Only consider sessions that were recorded or failed and whose evidence was never looked at."),
      ids: z.array(z.string()).optional()
        .describe("Exact session ids to remove, from list_recordings. Overrides the other selectors."),
      include_imports: z.boolean().optional()
        .describe(
          "Also clear the imports cache of videos assembled from stills or GIFs passed by " +
            "path. Derived data — it is rebuilt on demand from your original files."
        ),
    },
  },
  async (args) => {
    const dryRun = args.confirm !== true;
    const before = totalFootprint();

    // Never eligible: the session being written to right now, or the one the hook is
    // still appending events to.
    const protectedIds = [...activeRecordings(), getActiveSession()].filter(Boolean);
    const plan = planPrune(listSessions({ limit: 1000, withSize: true }), args, { protectedIds });

    if (plan.refusal) {
      return { isError: true, content: [{ type: "text", text: plan.refusal }] };
    }

    const imports = args.include_imports ? pruneImports({ dryRun }) : null;
    const result = dryRun ? { deleted: [], failed: [], bytesFreed: 0 } : applyPrune(plan);

    const lines = [];
    lines.push(dryRun ? "DRY RUN — nothing was deleted.\n" : "Deleted.\n");
    if (plan.candidates.length) {
      lines.push(
        `${dryRun ? "Would remove" : "Removed"} ${plan.candidates.length} session(s), ` +
          `${dryRun ? "freeing" : "freeing"} ${fmtBytes(dryRun ? plan.totalBytes : result.bytesFreed)}:`
      );
      for (const c of plan.candidates) {
        lines.push(
          `  ${c.id}  ${String(c.status).padEnd(9)} ${`${(c.bytes / 1e6).toFixed(1)} MB`.padStart(10)}  ${c.reason}`
        );
      }
    } else {
      lines.push("No session matched those selectors.");
    }
    if (imports) {
      lines.push(
        `${dryRun ? "Would clear" : "Cleared"} the imports cache: ` +
          `${fmtBytes(imports.bytes)} across ${imports.entries} entr(ies).`
      );
    }
    for (const s of plan.skipped) lines.push(`Skipped ${s.id} — ${s.why}.`);
    for (const f of result.failed) lines.push(`Could not remove ${f.id}: ${f.error}`);

    const after = dryRun
      ? before.bytes - plan.totalBytes - (imports?.bytes ?? 0)
      : totalFootprint().bytes;
    lines.push(
      `\nFootprint ${fmtBytes(before.bytes)}${dryRun ? ` — would become ${fmtBytes(after)}` : ` → ${fmtBytes(after)}`}.`
    );
    if (dryRun && plan.candidates.length) {
      // Echo the caller's own selectors, never a broader set.
      const echo = { ...args, confirm: true };
      lines.push(`To do it: prune_recordings ${JSON.stringify(echo)}`);
    }
    lines.push(
      "Note: sessions recorded before this version have no record of ever being analysed, " +
        "so they may be listed as never-analysed even if you looked at them."
    );

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      structuredContent: {
        dryRun,
        selectors: args,
        candidates: plan.candidates,
        skipped: plan.skipped,
        deleted: result.deleted,
        bytesFreed: result.bytesFreed,
        footprintBefore: before,
        imports,
      },
    };
  }
);

registerCaptureTools(server);
registerAnalysisTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
