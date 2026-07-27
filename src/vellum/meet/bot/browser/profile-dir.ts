/**
 * Chrome user-data-dir selection.
 *
 * The bot used to mint a brand-new profile per meeting
 * (`<root>-<meetingId>`). That is the most anomalous thing about our
 * client: a browser with zero cookies, zero history, and zero prior
 * Google contact, knocking on a meeting. Real users carry a profile
 * across sessions, so a persistent dir is both more honest and a weaker
 * abuse signal.
 *
 * Concurrency is the catch: two Chromium processes cannot share one
 * user-data-dir, and the bot runs one process per meeting. Chromium marks
 * a live profile with a `SingletonLock` symlink, so we take the persistent
 * dir when it is free and fall back to a per-meeting dir when it is not.
 * A concurrent second meeting therefore behaves exactly as before rather
 * than corrupting the first one's profile.
 */

import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";

/** Name of the shared profile under the configured profile root. */
const PERSISTENT_PROFILE_NAME = "persistent";

/** Chromium's in-use marker inside a user-data-dir. */
const SINGLETON_LOCK = "SingletonLock";

/** How the resolved directory was chosen — surfaced for logging. */
export type ProfileDirKind = "persistent" | "per-meeting";

export interface ResolvedProfileDir {
  /** Absolute path to use as `--user-data-dir`. */
  dir: string;
  kind: ProfileDirKind;
  /** Human-readable reason, logged at boot. */
  reason: string;
}

export interface ResolveProfileDirOptions {
  /** Configured profile root (`CHROME_USER_DATA_ROOT`). */
  root: string;
  /** Meeting id, used for the per-meeting fallback path. */
  meetingId: string;
  /**
   * When false, always use a per-meeting profile. Set from
   * `CHROME_PROFILE_PERSIST=0` for operators who want the old behavior.
   */
  persist: boolean;
  /** Existence probe — overridable in tests. */
  exists?: (path: string) => boolean;
}

/**
 * True when a profile dir looks like it is currently owned by a live
 * Chromium. `SingletonLock` is a symlink Chromium creates on startup and
 * removes on clean exit; a stale one can survive a hard kill, which is why
 * this is a heuristic that degrades to "use a fresh dir" rather than a
 * hard error either way.
 */
function profileInUse(dir: string, exists: (path: string) => boolean): boolean {
  const lock = join(dir, SINGLETON_LOCK);
  if (!exists(lock)) return false;
  try {
    // A symlink that still resolves means Chromium wrote it; a dangling
    // one is inconclusive, so we treat both as "in use" and take the
    // fallback. Being wrong here costs a cold profile, not a failed join.
    lstatSync(lock);
    return true;
  } catch {
    return true;
  }
}

/**
 * Choose the Chrome user-data-dir for this session. Prefers a persistent
 * profile so the browser accumulates ordinary state across joins; falls
 * back to a per-meeting dir when persistence is disabled or the shared
 * profile is already in use by a concurrent session.
 */
export function resolveProfileDir(
  opts: ResolveProfileDirOptions,
): ResolvedProfileDir {
  const exists = opts.exists ?? existsSync;
  const perMeeting = `${opts.root}-${opts.meetingId}`;

  if (!opts.persist) {
    return {
      dir: perMeeting,
      kind: "per-meeting",
      reason: "CHROME_PROFILE_PERSIST=0",
    };
  }

  const persistent = join(opts.root, PERSISTENT_PROFILE_NAME);
  if (profileInUse(persistent, exists)) {
    return {
      dir: perMeeting,
      kind: "per-meeting",
      reason: "the persistent profile is in use by another session",
    };
  }

  return {
    dir: persistent,
    kind: "persistent",
    reason: "reusing the persistent profile",
  };
}
