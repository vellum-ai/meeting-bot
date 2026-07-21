/**
 * Ensures the browser stack the Meet bot needs in direct mode is installed.
 *
 * In Docker mode the bot runs inside a container whose Dockerfile already
 * installs chromium, Xvfb, PulseAudio, xdotool, and their runtime deps. In
 * direct mode the bot runs as a child process of the assistant, so those
 * binaries must be present on the host. This module probes for them at init
 * time and installs any that are missing via the system package manager.
 *
 * Detection is by binary presence on PATH (`which`/`command -v`), not by
 * package metadata, so it works regardless of how a binary was installed.
 * Installation uses `apt-get` (the assistant Docker image is Debian-based).
 * On non-Debian systems the probe logs a warning and returns — the operator
 * must install the deps manually.
 */

import { execSync } from "node:child_process";

import type { Logger } from "../plugin-host.js";

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
 * deps. Kept in sync with `bot/Dockerfile`.
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

/** Returns true when `binary` is found on PATH. */
function hasBinary(binary: string): boolean {
  try {
    execSync(`command -v ${binary}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Returns true when the system has `apt-get` (Debian/Ubuntu). */
function hasAptGet(): boolean {
  try {
    execSync("command -v apt-get", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check which required binaries are missing and install them if possible.
 *
 * - If everything is present: no-op.
 * - If some are missing and `apt-get` is available: installs the full
 *   package set (apt-get is idempotent — already-installed packages are
 *   skipped).
 * - If some are missing and `apt-get` is NOT available: logs a warning
 *   listing the missing binaries and returns. The operator must install
 *   them manually; the bot will fail at spawn time with a clear error.
 */
export function ensureBrowserStack(log: Logger): void {
  const missing = REQUIRED_BINARIES.filter((b) => !hasBinary(b));
  if (missing.length === 0) {
    log.info("meet-join: browser stack present (chromium, Xvfb, xdotool, pulseaudio, ffmpeg)");
    return;
  }

  log.warn("meet-join: missing browser stack binaries for direct mode", { missing });

  if (!hasAptGet()) {
    log.warn(
      "meet-join: apt-get not found — cannot auto-install. Install these packages manually: " +
        APT_PACKAGES.join(", "),
    );
    return;
  }

  log.info("meet-join: installing browser stack via apt-get (this may take a minute)...");

  try {
    execSync("apt-get update", { stdio: "inherit", timeout: 60_000 });
    execSync(
      `apt-get install -y --no-install-recommends ${APT_PACKAGES.join(" ")}`,
      { stdio: "inherit", timeout: 120_000 },
    );
    execSync("rm -rf /var/lib/apt/lists/*", { stdio: "ignore" });
    log.info("meet-join: browser stack installed successfully");
  } catch (err) {
    log.error(
      "meet-join: browser stack installation failed — the bot will not be able to join meetings in direct mode",
      { error: err instanceof Error ? err.message : String(err) },
    );
  }
}
