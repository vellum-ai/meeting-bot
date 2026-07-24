/**
 * X display screenshot capture via ffmpeg's x11grab.
 *
 * The bot's failure diagnostics (page survey, chrome stderr) describe the
 * DOM; a screenshot shows the pixels — overlays eating clicks, CAPTCHAs,
 * and render states no selector survey can express. ffmpeg is already
 * part of the browser stack, so a single-frame x11grab is free evidence.
 *
 * Best-effort by design: a missing ffmpeg, a dead display, or a slow grab
 * must never turn a diagnostic step into a new failure. Returns true only
 * when the frame was actually written.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Bound the grab so a wedged ffmpeg cannot stall the error path. */
const CAPTURE_TIMEOUT_MS = 5_000;

export async function captureDisplayScreenshot(
  display: string,
  outPath: string,
  opts: { spawn?: typeof Bun.spawn } = {},
): Promise<boolean> {
  const ffmpeg = Bun.which("ffmpeg", { PATH: process.env.PATH ?? "" });
  if (ffmpeg === null) return false;

  try {
    mkdirSync(dirname(outPath), { recursive: true });
  } catch {
    return false;
  }

  const spawn = opts.spawn ?? Bun.spawn;
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = spawn(
      [
        ffmpeg,
        "-y",
        "-loglevel",
        "error",
        "-f",
        "x11grab",
        "-video_size",
        "1280x720",
        "-i",
        display,
        "-frames:v",
        "1",
        outPath,
      ],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
    );
  } catch {
    return false;
  }

  const timedOut = await Promise.race([
    proc.exited.then(() => false),
    new Promise<boolean>((resolve) =>
      setTimeout(() => resolve(true), CAPTURE_TIMEOUT_MS),
    ),
  ]);
  if (timedOut) {
    try {
      proc.kill("SIGKILL");
    } catch {
      // already gone
    }
    return false;
  }
  return proc.exitCode === 0 && existsSync(outPath);
}
