/**
 * PulseAudio setup/teardown helpers for the meet-bot container.
 *
 * The audio plumbing (null-sinks and a virtual-source) is created by
 * `pulse-setup.sh`; this module just shells out to the script at container
 * boot so the TypeScript side has a single `await setupPulseAudio()` entry
 * point to call from `main.ts`.
 *
 * The script is idempotent — calling `setupPulseAudio` multiple times in the
 * same container is a no-op after the first invocation.
 */

import { join } from "node:path";

const SCRIPT_PATH = join(import.meta.dir, "pulse-setup.sh");

/**
 * How long to keep draining the script's stderr after it exits. Output
 * written before exit arrives within this window; a pipe held open by a
 * background grandchild must not hold up boot any longer than this.
 */
const POST_EXIT_DRAIN_GRACE_MS = 250;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `pulse-setup.sh` to bring up PulseAudio and the virtual devices the
 * bot needs. Resolves on exit code 0, rejects with a descriptive error on
 * any non-zero exit.
 *
 * The test suite injects a spawn shim via the optional argument so it can
 * verify invocation without actually running PulseAudio.
 */
export async function setupPulseAudio(
  spawn: typeof Bun.spawn = Bun.spawn,
): Promise<void> {
  const proc = spawn(["bash", SCRIPT_PATH], {
    stdout: "pipe",
    stderr: "pipe",
  });

  // Collect stderr incrementally rather than reading to EOF. The script
  // backgrounds the PulseAudio daemon; a grandchild that inherits the
  // pipe holds its write end open for its own lifetime, so an EOF wait
  // would block the bot's boot forever once the daemon comes up and
  // stays up. The reader is deliberately left running (not cancelled)
  // after the grace below: cancelling closes the read end, and a later
  // write from such a grandchild would take EPIPE.
  const chunks: string[] = [];
  const decoder = new TextDecoder();
  const stderr = proc.stderr as unknown as AsyncIterable<Uint8Array> | null;
  const drained = (async () => {
    if (!stderr) return;
    try {
      for await (const chunk of stderr) {
        chunks.push(decoder.decode(chunk, { stream: true }));
      }
    } catch {
      // Stream torn down with the process; keep what was read.
    }
  })();

  const exitCode = await proc.exited;
  // Let output written before exit finish draining, then stop waiting.
  await Promise.race([drained, delay(POST_EXIT_DRAIN_GRACE_MS)]);

  if (exitCode !== 0) {
    const trimmed = chunks.join("").trim();
    const detail = trimmed.length > 0 ? `: ${trimmed}` : "";
    throw new Error(
      `pulse-setup.sh failed with exit code ${exitCode}${detail}`,
    );
  }
}

/**
 * Best-effort teardown. Called on container shutdown paths; we don't want a
 * failure here (e.g. the daemon already gone) to mask the real exit cause.
 */
export async function teardownPulseAudio(
  spawn: typeof Bun.spawn = Bun.spawn,
): Promise<void> {
  try {
    const proc = spawn(["pulseaudio", "--kill"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
  } catch {
    // Intentional: teardown is best-effort.
  }
}

/**
 * Exported for tests — the absolute path of the shell script this module
 * invokes. Not part of the public runtime surface.
 */
export const PULSE_SETUP_SCRIPT_PATH = SCRIPT_PATH;
