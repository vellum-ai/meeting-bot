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

/**
 * Probe for the direct-mode browser stack and install missing pieces when
 * apt-get is available. Resolves when the stack is known-present, known
 * unobtainable, or the install attempt finished (either way); never
 * rejects. Callers that need the stack (the join path) await the promise;
 * callers that do not (readiness) simply never await it.
 */
export async function ensureBrowserStack(log: Logger): Promise<void> {
  const missing: string[] = [];
  for (const binary of REQUIRED_BINARIES) {
    if (!(await hasBinary(binary))) missing.push(binary);
  }
  if (missing.length === 0) {
    log.info(
      "meeting-bot: browser stack present (chromium, Xvfb, xdotool, pulseaudio, ffmpeg)",
    );
    return;
  }

  log.warn("meeting-bot: missing browser stack binaries for direct mode", {
    missing,
  });

  if (!(await hasAptGet())) {
    log.warn(
      "meeting-bot: apt-get not found, cannot auto-install. Install these packages manually: " +
        APT_PACKAGES.join(", "),
    );
    return;
  }

  log.info(
    "meeting-bot: installing browser stack via apt-get (this can take a few minutes)...",
  );

  try {
    await execAsync("apt-get update", { timeout: APT_UPDATE_TIMEOUT_MS });
    await execAsync(
      `apt-get install -y --no-install-recommends ${APT_PACKAGES.join(" ")}`,
      { timeout: APT_INSTALL_TIMEOUT_MS },
    );
    await execAsync("rm -rf /var/lib/apt/lists/*").catch(() => undefined);
    log.info("meeting-bot: browser stack installed successfully");
  } catch (err) {
    log.error(
      "meeting-bot: browser stack installation failed, the bot will not be able to join meetings in direct mode",
      { error: err instanceof Error ? err.message : String(err) },
    );
  }
}
