/**
 * Xvfb (X Virtual Framebuffer) lifecycle helpers.
 *
 * The meet-bot runs inside a Linux container without a real display; Xvfb
 * provides a headless X server that Chromium can render into. We keep
 * Chromium non-headless because Meet's bot-detection is friendlier toward
 * browsers that have a window manager and a real display, and Xvfb lets us
 * do that without a GPU.
 *
 * These helpers are intentionally small:
 *
 *   - `startXvfb(display)` spawns `Xvfb :99 -screen 0 1280x720x24` and waits
 *     until the display's Unix socket accepts a connection before resolving.
 *     A server already accepting on the display is reused via a no-op
 *     handle; a lingering lock file without a connectable server is treated
 *     as stale and cleared.
 *   - `stopXvfb(handle)` sends SIGTERM, then escalates to SIGKILL after 2s.
 *
 * Everything heavier (integration against real Xvfb + Chromium) is gated
 * behind `XVFB_TEST=1` in the test suite so CI and macOS developers don't
 * accidentally try to exec a Linux binary.
 */

import type { Subprocess } from "bun";
import { existsSync, unlinkSync } from "node:fs";
import { createConnection } from "node:net";

/** Opaque handle returned by `startXvfb`, consumed by `stopXvfb`. */
export interface XvfbHandle {
  /** The X display string we started on, e.g. `":99"`. */
  readonly display: string;
  /**
   * The Xvfb child process, or `null` if we detected an existing server via
   * the lock file and skipped spawning our own.
   */
  readonly process: Subprocess | null;
}

const LOCK_WAIT_TIMEOUT_MS = 10_000;
const LOCK_POLL_INTERVAL_MS = 100;
const SIGKILL_GRACE_MS = 2_000;

/**
 * Parse the numeric display index out of an X display string.
 *
 * Accepts `":99"`, `"99"`, or `":99.0"`-style inputs. Throws on anything we
 * can't parse cleanly rather than guessing — a bad display string will hang
 * Chromium later in a way that's much harder to debug.
 */
function parseDisplayIndex(display: string): number {
  const trimmed = display.startsWith(":") ? display.slice(1) : display;
  // Strip optional screen suffix (e.g. ":99.0" -> "99").
  const [head] = trimmed.split(".");
  const n = Number.parseInt(head ?? "", 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`startXvfb: invalid display string: ${display}`);
  }
  return n;
}

/** Path Xvfb uses for its per-display lock file. */
function lockFilePath(displayIndex: number): string {
  return `/tmp/.X${displayIndex}-lock`;
}

/** Path of the X server's Unix listening socket for a display. */
function socketFilePath(displayIndex: number): string {
  return `/tmp/.X11-unix/X${displayIndex}`;
}

/**
 * True when an X server is actually accepting connections on the display's
 * Unix socket. This is the readiness signal that matters: a lock file can
 * outlive its server (SIGKILL leaves it behind, and the recorded pid can be
 * recycled by an unrelated process), and Chrome only cares whether the
 * socket connects.
 */
function canConnectToDisplay(
  displayIndex: number,
  timeoutMs = 500,
): Promise<boolean> {
  const path = socketFilePath(displayIndex);
  if (!existsSync(path)) return Promise.resolve(false);
  return new Promise((resolve) => {
    const socket = createConnection(path);
    const done = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Start Xvfb on `display` (default `":99"`) and wait for its Unix socket to
 * accept a connection. If a server is already accepting on this display
 * (e.g. an Xvfb left over from a previous bot), it is reused and a handle
 * with `process: null` is returned; `stopXvfb` will then be a no-op.
 *
 * The lock file alone is never trusted as evidence of a running server: a
 * SIGKILLed Xvfb leaves its lock behind, the pid recorded in it can be
 * recycled by an unrelated live process, and Chrome would then launch
 * against a display nothing is serving ("Missing X server or $DISPLAY").
 * Readiness is a successful connect on `/tmp/.X11-unix/X<N>`, both for
 * reuse and after spawning.
 */
export async function startXvfb(display = ":99"): Promise<XvfbHandle> {
  const displayIndex = parseDisplayIndex(display);
  const lockPath = lockFilePath(displayIndex);
  const canonicalDisplay = `:${displayIndex}`;

  if (await canConnectToDisplay(displayIndex)) {
    return { display: canonicalDisplay, process: null };
  }

  if (existsSync(lockPath)) {
    // A lock without a connectable server is stale regardless of whether
    // its recorded pid happens to be alive (pid recycling makes the pid
    // meaningless). Xvfb refuses to start while the lock exists, so clear
    // it; the socket file may linger too, and Xvfb replaces it on bind.
    try {
      unlinkSync(lockPath);
    } catch {
      // Race with another cleanup; fine.
    }
  }

  const proc = Bun.spawn(
    ["Xvfb", canonicalDisplay, "-screen", "0", "1280x720x24"],
    {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    },
  );

  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await canConnectToDisplay(displayIndex)) {
      return { display: canonicalDisplay, process: proc };
    }
    // If Xvfb died during startup, bail out with a useful error instead of
    // spinning until the timeout.
    if (proc.exitCode !== null) {
      const stderr = proc.stderr ? await new Response(proc.stderr).text() : "";
      throw new Error(
        `startXvfb: Xvfb exited during startup (code=${proc.exitCode}): ${stderr.trim()}`,
      );
    }
    await sleep(LOCK_POLL_INTERVAL_MS);
  }

  // Timed out — try to kill what we spawned so we don't leak a process.
  try {
    proc.kill("SIGKILL");
  } catch {
    // Best effort; the process may have already exited.
  }
  throw new Error(
    `startXvfb: display ${canonicalDisplay} did not accept connections within ${LOCK_WAIT_TIMEOUT_MS}ms`,
  );
}

/**
 * Stop an Xvfb instance started by `startXvfb`. Sends SIGTERM first, then
 * SIGKILL after a short grace period if the process hasn't exited. A no-op
 * when the handle represents an externally-owned Xvfb (`process: null`).
 */
export async function stopXvfb(handle: XvfbHandle): Promise<void> {
  const proc = handle.process;
  if (!proc) return;
  if (proc.exitCode !== null) return;

  try {
    proc.kill("SIGTERM");
  } catch {
    // Ignore — process may have already exited between the exitCode check
    // and the kill call.
  }

  // Wait up to SIGKILL_GRACE_MS for a clean shutdown.
  const deadline = Date.now() + SIGKILL_GRACE_MS;
  while (Date.now() < deadline && proc.exitCode === null) {
    await sleep(50);
  }

  if (proc.exitCode === null) {
    try {
      proc.kill("SIGKILL");
    } catch {
      // Ditto — best effort.
    }
  }

  // Let `exited` settle so we don't leak the Subprocess promise.
  try {
    await proc.exited;
  } catch {
    // Ignored — we only care that the process is no longer running.
  }
}
