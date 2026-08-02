import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Ask Chrome which window it considers frontmost, and where it is.
 *
 * Chrome's own scripting dictionary is used rather than System Events because it
 * needs no Accessibility permission — System Events fails outright on this machine
 * with "Can't get window 1 of process Google Chrome".
 */
export async function frontmostChromeWindow() {
  const script = `tell application "Google Chrome"
  if (count of windows) is 0 then return "none"
  set b to bounds of window 1
  set t to ""
  try
    set t to title of active tab of window 1
  end try
  return ((item 1 of b) as text) & "," & ((item 2 of b) as text) & "," & ¬
    ((item 3 of b) as text) & "," & ((item 4 of b) as text) & "," & t
end tell`;
  try {
    const { stdout } = await execFileAsync("osascript", ["-e", script], { timeout: 15_000 });
    const out = stdout.trim();
    if (!out || out === "none") return null;
    const parts = out.split(",");
    const [left, top, right, bottom] = parts.slice(0, 4).map((n) => Number(n.trim()));
    if ([left, top, right, bottom].some((n) => !Number.isFinite(n))) return null;
    return {
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
      title: parts.slice(4).join(",").trim(),
    };
  } catch {
    // Chrome not running, or automation permission refused. Callers fall back.
    return null;
  }
}

export function isChrome(bundleId) {
  return bundleId === "com.google.Chrome";
}

/** Same window, allowing for rounding between the two coordinate sources. */
export function boundsMatch(a, b, tolerance = 4) {
  return (
    Math.abs(a.x - b.x) <= tolerance &&
    Math.abs(a.y - b.y) <= tolerance &&
    Math.abs(a.width - b.width) <= tolerance &&
    Math.abs(a.height - b.height) <= tolerance
  );
}
