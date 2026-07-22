/**
 * Async browser-stack bootstrap for the direct (non-Docker) bot backend.
 *
 * Replaces the vendored `meet/src/ensure-browser-stack.ts`, whose execSync
 * apt-get calls blocked the worker's main() for up to three minutes and so
 * starved both the daemon's readiness timeout and the first join attempt.
 * This version runs the same probe-and-install flow asynchronously: the
 * worker kicks it off at boot (so the install happens at plugin init and on
 * provider switches), signals readiness immediately, and the join path
 * merely awaits the returned promise, never triggering an install itself.
 *
 * In Docker mode the bot container's image already carries the stack, so
 * the worker skips this entirely.
 *
 * Detection is by binary presence on PATH, not package metadata, so it
 * works regardless of how a binary was installed. Installation uses
 * apt-get (the assistant image is Debian-based); on non-Debian systems the
 * probe logs a warning and returns, leaving installation to the operator.
 * Failures never reject: the bot spawn later fails with its own clear
 * error, and a broken install must not wedge the worker.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";

import type { Logger } from "./meet/plugin-host.ts";

const execAsync = promisify(exec);

/** Every binary the direct-mode bot expects on PATH. */
const REQUIRED_BINARIES = [
  "chromium",
  "Xvfb",
  "xdotool",
  "pulseaudio",
  "pacmd",
  "ffmpeg",
] as const;

/**
 * Debian packages that satisfy {@link REQUIRED_BINARIES} plus their runtime
 * deps. Kept in sync with `meet/bot/Dockerfile`.
 */
const APT_PACKAGES = [
  "chromium",
  "xvfb",
  "xdotool",
  "pulseaudio",
  "pulseaudio-utils",
  "ffmpeg",
  "fonts-liberation",
  "libasound2",
  "libgbm1",
  "libnss3",
  "libvulkan1",
  "dbus-x11",
  "v4l2loopback-utils",
  "xdg-utils",
  "ca-certificates",
] as const;

/** Time allowed for `apt-get update`. */
const APT_UPDATE_TIMEOUT_MS = 120_000;
/** Time allowed for the package install itself. */
const APT_INSTALL_TIMEOUT_MS = 240_000;

async function hasBinary(binary: string): Promise<boolean> {
  try {
    await execAsync(`command -v ${binary}`);
    return true;
  } catch {
    return false;
  }
}

async function hasAptGet(): Promise<boolean> {
  return hasBinary("apt-get");
}

/** Outcome of the probe-and-install pass, consumed by the join gate. */
export interface BrowserStackStatus {
  /** True when every required binary is present. */
  ok: boolean;
  /** Binaries still missing after the probe (and any install attempt). */
  missing: string[];
  /** Human-readable reason when not ok. */
  detail?: string;
}

async function probeMissing(): Promise<string[]> {
  const missing: string[] = [];
  for (const binary of REQUIRED_BINARIES) {
    if (!(await hasBinary(binary))) missing.push(binary);
  }
  return missing;
}

/**
 * Probe for the direct-mode browser stack and install missing pieces when
 * apt-get is available. Resolves with the final status once the stack is
 * known-present, known unobtainable, or the install attempt finished;
 * never rejects. The worker awaits this in the join path and fails the
 * join fast with the status detail when the stack is unusable, instead of
 * spawning a bot that dies mid-setup (e.g. pulse-setup.sh exit 127 when
 * pulseaudio never made it onto PATH).
 */
export async function ensureBrowserStack(log: Logger): Promise<BrowserStackStatus> {
  const missing = await probeMissing();
  if (missing.length === 0) {
    log.info(
      "meeting-bot: browser stack present (chromium, Xvfb, xdotool, pulseaudio, ffmpeg)",
    );
    return { ok: true, missing: [] };
  }

  log.warn("meeting-bot: missing browser stack binaries for direct mode", {
    missing,
  });

  if (!(await hasAptGet())) {
    const detail =
      "apt-get not found, cannot auto-install. Install these packages manually: " +
      APT_PACKAGES.join(", ");
    log.warn(`meeting-bot: ${detail}`);
    return { ok: false, missing, detail };
  }

  log.info(
    "meeting-bot: installing browser stack via apt-get (this can take a few minutes)...",
  );

  let installError: string | null = null;
  try {
    await execAsync("apt-get update", { timeout: APT_UPDATE_TIMEOUT_MS });
    await execAsync(
      `apt-get install -y --no-install-recommends ${APT_PACKAGES.join(" ")}`,
      { timeout: APT_INSTALL_TIMEOUT_MS },
    );
    await execAsync("rm -rf /var/lib/apt/lists/*").catch(() => undefined);
  } catch (err) {
    installError = err instanceof Error ? err.message : String(err);
  }

  // Re-probe rather than trusting the install exit code: a partially
  // successful run may have delivered everything we need, and a "clean"
  // run can still leave a binary off PATH.
  const stillMissing = await probeMissing();
  if (stillMissing.length === 0) {
    log.info("meeting-bot: browser stack installed successfully");
    return { ok: true, missing: [] };
  }

  const detail =
    (installError
      ? `apt-get install failed: ${installError.slice(0, 300)}`
      : "apt-get reported success but required binaries are still missing") +
    `. PATH searched: ${process.env.PATH ?? "(unset)"}`;
  log.error(
    "meeting-bot: browser stack unavailable, the bot cannot join meetings in direct mode",
    { missing: stillMissing, detail },
  );
  return { ok: false, missing: stillMissing, detail };
}
