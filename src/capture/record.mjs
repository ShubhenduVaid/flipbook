import { spawn } from "node:child_process";
import fs from "node:fs";
import { ensureNative, findWindow, listWindows } from "../env/native.mjs";
import { resolveFfmpeg, listAvfDevices } from "../env/ffmpeg.mjs";

/**
 * In-flight recorders, keyed by session id. The MCP server is long-lived so this
 * is enough; if the server dies the child sees stdin EOF and finalises the file
 * on its own, which is why every backend stops on EOF rather than needing a kill.
 */
const active = new Map();

export function activeRecordings() {
  return [...active.keys()];
}

export function isRecording(id) {
  return active.has(id);
}

/** Start ScreenCaptureKit window capture. Resolves once the window is chosen. */
async function startWindowCapture({ id, outPath, bundleId, windowId, titleContains, fps, maxDurationSec }) {
  const bin = await ensureNative();
  const args = ["--out", outPath, "--fps", String(fps)];
  if (windowId != null) args.push("--window-id", String(windowId));
  else args.push("--bundle", bundleId);
  if (titleContains) args.push("--title-contains", titleContains);
  if (maxDurationSec) args.push("--seconds", String(maxDurationSec));

  const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });

  let stderrBuf = "";
  let windowInfo = null;
  let started = false;
  let finished = null;
  let errorMsg = null;

  const ready = new Promise((resolve, reject) => {
    const onData = (chunk) => {
      stderrBuf += chunk.toString();
      let idx;
      while ((idx = stderrBuf.indexOf("\n")) !== -1) {
        const line = stderrBuf.slice(0, idx).trim();
        stderrBuf = stderrBuf.slice(idx + 1);
        if (!line) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.event === "window") windowInfo = ev;
        if (ev.event === "started") {
          started = true;
          resolve({ windowInfo });
        }
        if (ev.event === "finished") finished = ev;
        if (ev.event === "error") {
          errorMsg = ev.message;
          if (!started) reject(new Error(ev.message));
        }
      }
    };
    child.stderr.on("data", onData);
    child.on("exit", (code) => {
      if (!started) {
        reject(new Error(errorMsg || `sckrec exited with code ${code} before starting`));
      }
    });
    setTimeout(() => {
      if (!started) reject(new Error("sckrec did not start within 15s"));
    }, 15_000);
  });

  const { windowInfo: info } = await ready;

  const rec = {
    id,
    backend: "window",
    child,
    outPath,
    window: info,
    startedAt: Date.now(),
    exited: new Promise((resolve) => child.on("exit", (code) => resolve(code))),
    get finishEvent() {
      return finished;
    },
    get lastError() {
      return errorMsg;
    },
  };
  active.set(id, rec);
  return rec;
}

/**
 * ffmpeg + avfoundation display capture. Kept as a fallback for pre-macOS-15 hosts
 * and for deliberately recording the whole screen. It records the composited
 * display, so anything on top of the target window ends up in the recording.
 */
async function startDisplayCapture({ id, outPath, fps, maxDurationSec, cropRect, screenIndex }) {
  const bin = resolveFfmpeg();
  let index = screenIndex;
  if (index == null) {
    const { screens } = await listAvfDevices();
    if (!screens.length) throw new Error("no avfoundation screen device found");
    index = screens[0].index;
  }

  const args = [
    "-hide_banner",
    "-loglevel", "warning",
    "-f", "avfoundation",
    "-capture_cursor", "1",
    // An explicit input framerate is mandatory: without it avfoundation reports
    // 1000k fps and ffmpeg duplicates frames until the disk fills.
    "-framerate", String(fps),
  ];
  if (maxDurationSec) args.push("-t", String(maxDurationSec));
  args.push("-i", `${index}:none`);
  if (cropRect) {
    const { w, h, x, y } = cropRect;
    args.push("-vf", `crop=${w}:${h}:${x}:${y}`);
  }
  args.push(
    "-fps_mode", "vfr",
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-crf", "28",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    "-y", outPath
  );

  const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (c) => {
    stderr += c.toString();
    if (stderr.length > 64_000) stderr = stderr.slice(-32_000);
  });

  const rec = {
    id,
    backend: "display",
    child,
    outPath,
    window: null,
    startedAt: Date.now(),
    exited: new Promise((resolve) => child.on("exit", (code) => resolve(code))),
    get lastError() {
      return stderr.split("\n").filter(Boolean).slice(-5).join("\n");
    },
  };
  active.set(id, rec);

  // ffmpeg has no "started" event; give it a moment to fail loudly on a bad device.
  await new Promise((r) => setTimeout(r, 600));
  if (child.exitCode !== null) {
    active.delete(id);
    throw new Error(`ffmpeg exited immediately:\n${rec.lastError}`);
  }
  return rec;
}

export async function startRecording(opts) {
  const {
    id,
    outPath,
    target = "chrome",
    bundleId = "com.google.Chrome",
    windowId,
    titleContains,
    fps = 30,
    maxDurationSec = 600,
  } = opts;

  if (target === "display") {
    return startDisplayCapture({ id, outPath, fps, maxDurationSec, screenIndex: opts.screenIndex });
  }
  // Fail early with a useful message rather than after a recording produces nothing.
  const { window: win, how, candidates } = await findWindow({ bundleId, windowId, titleContains });
  if (!win) {
    if (how === "title_no_match") {
      const all = await listWindows();
      const titles = all
        .filter((w) => w.bundleId === bundleId && w.width > 200)
        .map((w) => `  "${w.title}"`)
        .join("\n");
      throw new Error(
        `No window's title contains "${titleContains}".\n` +
          `Window titles come from each window's ACTIVE tab, so a background tab will ` +
          `never match — switch to the tab you want to record first.\n` +
          `Available windows:\n${titles || "  (none)"}`
      );
    }
    throw new Error(
      `No window found for ${windowId != null ? `window id ${windowId}` : bundleId}` +
        ". Open the app with a visible window, or run doctor to see what is available."
    );
  }
  // Pin the exact window id so the capture cannot drift to a different window
  // between resolution and recording.
  const rec = await startWindowCapture({
    id,
    outPath,
    bundleId,
    windowId: win.windowId,
    titleContains: null,
    fps,
    maxDurationSec,
  });
  rec.selection = { how, candidates };
  return rec;
}

/**
 * Graceful stop. Both backends finalise their container on a clean shutdown signal;
 * SIGKILL would leave an unplayable file, so it is only ever a last resort.
 */
export async function stopRecording(id, { timeoutMs = 20_000 } = {}) {
  const rec = active.get(id);
  if (!rec) return null;

  try {
    if (rec.backend === "window") rec.child.stdin.write("q\n");
    else rec.child.stdin.write("q");
    rec.child.stdin.end();
  } catch {
    /* already gone */
  }

  const timedOut = Symbol("timeout");
  const result = await Promise.race([
    rec.exited,
    new Promise((r) => setTimeout(() => r(timedOut), timeoutMs)),
  ]);

  if (result === timedOut) {
    rec.child.kill("SIGINT");
    await Promise.race([rec.exited, new Promise((r) => setTimeout(r, 8000))]);
  }
  if (rec.child.exitCode === null && rec.child.signalCode === null) {
    rec.child.kill("SIGKILL");
  }

  active.delete(id);

  const stat = fs.existsSync(rec.outPath) ? fs.statSync(rec.outPath) : null;
  return {
    backend: rec.backend,
    outPath: rec.outPath,
    bytes: stat ? stat.size : 0,
    window: rec.window,
    wallClockSec: (Date.now() - rec.startedAt) / 1000,
    error: stat && stat.size > 0 ? null : rec.lastError || "recording produced no data",
  };
}

export function getRecording(id) {
  return active.get(id) || null;
}
