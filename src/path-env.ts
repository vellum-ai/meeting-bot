/**
 * PATH augmentation for spawned runtimes.
 *
 * The daemon's own process env can carry a stripped-down PATH (the
 * assistant's interactive shell builds its PATH from a login profile the
 * daemon never sources), so processes it spawns inherit a PATH missing
 * directories like /data/system/bin, where the assistant image installs
 * its system tools (chromium, Xvfb, pulseaudio, ...). `which chromium`
 * then works from the user's shell but fails inside the vellum worker and
 * every bot process it spawns.
 *
 * The fix is applied twice, belt and braces: the supervisor hands the
 * worker an augmented PATH at spawn, and the worker re-augments its own
 * `process.env.PATH` at boot (covering any other spawn route). Downstream
 * inheritance is then automatic: the browser-stack probes use the
 * process env, and the direct bot runner copies the worker's env into the
 * bot's.
 *
 * Only directories that actually exist are appended, and existing PATH
 * entries always keep priority.
 */

import { existsSync } from "node:fs";
import { delimiter } from "node:path";

/**
 * Directories that commonly hold the binaries the runtime needs but are
 * absent from a non-login-shell PATH. `/data/system/bin` is where the
 * Vellum assistant image installs its system tooling.
 */
const WELL_KNOWN_BIN_DIRS = [
  "/data/system/bin",
  "/usr/local/sbin",
  "/usr/local/bin",
  "/usr/sbin",
  "/usr/bin",
  "/sbin",
  "/bin",
] as const;

/**
 * Return `current` with any missing well-known bin directories that exist
 * on disk appended (never prepended: whatever the operator put first stays
 * first). `candidates` is injectable for tests.
 */
export function augmentedPath(
  current: string | undefined,
  candidates: readonly string[] = WELL_KNOWN_BIN_DIRS,
): string {
  const parts = (current ?? "").split(delimiter).filter((p) => p.length > 0);
  const present = new Set(parts);
  for (const dir of candidates) {
    if (!present.has(dir) && existsSync(dir)) {
      parts.push(dir);
      present.add(dir);
    }
  }
  return parts.join(delimiter);
}

/**
 * Augment this process's own PATH in place. Returns the directories that
 * were added (empty when the PATH was already complete), so callers can
 * log the outcome.
 */
export function augmentProcessPath(): string[] {
  const before = process.env.PATH ?? "";
  const after = augmentedPath(before);
  if (after === before) return [];
  const beforeSet = new Set(before.split(delimiter));
  process.env.PATH = after;
  return after.split(delimiter).filter((p) => !beforeSet.has(p));
}
