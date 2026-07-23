/**
 * Worker PID-file bookkeeping and stale-worker reaping, shared by both
 * provider runtimes (the Recall realtime receiver and the Vellum Runtime
 * worker).
 *
 * The daemon records each worker's PID in a file under the plugin data
 * dir. Normally the supervisor's in-memory child handle is all that is
 * needed; the PID file is the backstop for every path where that handle is
 * lost while the worker lives: a daemon module reloaded without a clean
 * shutdown, an init that crashed between spawn and ready, a host-side hook
 * timeout. In those cases the next init (and the shutdown hook) reap the
 * recorded PID so an orphan can never survive a disable or block a
 * restart's port bind.
 *
 * A PID is only ever signalled after verifying via `/proc/<pid>/cmdline`
 * that it still runs our worker script: a recycled PID owned by an
 * unrelated process is left alone (the file is just deleted).
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

import type { Logger } from "./realtime-server.ts";

/** Time to wait after SIGTERM before escalating to SIGKILL. */
const TERM_GRACE_MS = 5_000;
/** Time to wait after SIGKILL for the process to disappear. */
const KILL_GRACE_MS = 3_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True if a process with `pid` currently exists (signal 0 probe). */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Verify a PID belongs to our worker before killing it. Reads the process
 * command line from `/proc` (Linux); when it cannot be read, returns
 * false: better to leave a stale process alone than kill the wrong one.
 */
function isOurWorker(pid: number, cmdlineMarker: string): boolean {
  try {
    // /proc cmdline is NUL-separated; a substring match on the script path
    // is enough to distinguish our worker from any recycled PID.
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf-8");
    return cmdline.includes(cmdlineMarker);
  } catch {
    return false;
  }
}

/** Record a worker PID, best-effort. */
export function writeWorkerPidFile(pidFilePath: string, pid: number): void {
  try {
    writeFileSync(pidFilePath, String(pid), "utf-8");
  } catch {
    // Non-fatal: reaping degrades gracefully without the file.
  }
}

/** Remove the PID file, ignoring errors (it may already be gone). */
export function removeWorkerPidFile(pidFilePath: string | null): void {
  if (!pidFilePath) return;
  try {
    if (existsSync(pidFilePath)) unlinkSync(pidFilePath);
  } catch {
    // best-effort
  }
}

/**
 * Reap the worker recorded in `pidFilePath` if it is still alive and
 * verifiably ours (its cmdline contains `cmdlineMarker`). Escalates
 * SIGTERM then SIGKILL and waits for the process to exit so its listen
 * port is released before the caller spawns a replacement. Always clears
 * the PID file when done.
 */
export async function reapStaleWorker(
  pidFilePath: string,
  cmdlineMarker: string,
  logger: Logger,
): Promise<void> {
  let pid: number;
  try {
    if (!existsSync(pidFilePath)) return;
    pid = Number.parseInt(readFileSync(pidFilePath, "utf-8").trim(), 10);
  } catch {
    return;
  }

  if (!Number.isInteger(pid) || pid <= 0) {
    removeWorkerPidFile(pidFilePath);
    return;
  }

  // Only signal a process we can positively identify as our worker.
  if (!isProcessAlive(pid) || !isOurWorker(pid, cmdlineMarker)) {
    removeWorkerPidFile(pidFilePath);
    return;
  }

  logger.warn(
    { pid, cmdlineMarker },
    "meeting-bot: reaping stale worker from a previous load",
  );

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // already gone
  }

  const termDeadline = Date.now() + TERM_GRACE_MS;
  while (Date.now() < termDeadline && isProcessAlive(pid)) {
    await delay(100);
  }

  if (isProcessAlive(pid)) {
    logger.warn(
      { pid },
      "meeting-bot: stale worker did not exit on SIGTERM, sending SIGKILL",
    );
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
    const killDeadline = Date.now() + KILL_GRACE_MS;
    while (Date.now() < killDeadline && isProcessAlive(pid)) {
      await delay(100);
    }
  }

  removeWorkerPidFile(pidFilePath);
}
