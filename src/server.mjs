#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { runDoctor, formatDoctor } from "./env/doctor.mjs";
import { ensureDirs, DATA_HOME } from "./env/paths.mjs";
import { listSessions } from "./capture/session.mjs";
import { registerCaptureTools } from "./tools/capture-tools.mjs";
import { registerAnalysisTools } from "./tools/analysis-tools.mjs";

ensureDirs();

const server = new McpServer(
  { name: "video-qa", version: "0.1.0" },
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
    const sessions = listSessions({ limit: limit ?? 25 });
    if (!sessions.length) {
      return {
        content: [
          { type: "text", text: `No recordings yet. Recordings are stored under ${DATA_HOME}.` },
        ],
        structuredContent: { sessions: [] },
      };
    }
    const lines = sessions.map((s) => {
      const dur = s.durationSec != null ? `${s.durationSec.toFixed(1)}s` : "—";
      return `${s.id}  ${String(s.status).padEnd(9)}  ${dur.padStart(7)}  ${s.label || ""}`;
    });
    return {
      content: [
        {
          type: "text",
          text: ["id                     status     duration  label", ...lines].join("\n"),
        },
      ],
      structuredContent: { sessions },
    };
  }
);

registerCaptureTools(server);
registerAnalysisTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
