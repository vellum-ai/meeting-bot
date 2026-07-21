/**
 * Meet-bot execution backend selection.
 *
 * The Meet bot needs a browser stack (Xvfb + PulseAudio + a real Chromium
 * with the controller extension). There are two ways to run that stack:
 *
 *   - `"docker"` - spawn a throwaway container per meeting via the Docker
 *     Engine API. This is the default and what every historical deployment
 *     used.
 *   - `"direct"` - run the bot as a child process of the assistant, for
 *     environments that have no Docker at all (a bare assistant process, a
 *     dev box where `docker` is not installed, a locked-down container that
 *     cannot nest containers).
 *
 * The `init` hook (`hooks/init.ts`) probes Docker availability exactly once
 * at plugin bootstrap and records the decision here. The session manager's
 * runner factory reads it lazily at join time, so a single boot-time probe
 * drives every subsequent spawn without re-probing on the hot path.
 */

import {
  DEFAULT_DOCKER_SOCKET_PATH,
  ensureSocketReachable,
} from "./docker-runner.js";

/** Which mechanism the session manager uses to run the Meet bot. */
export type MeetBotBackend = "docker" | "direct";

let resolvedBackend: MeetBotBackend | null = null;

/**
 * Record the backend the `init` hook resolved. Called once at bootstrap.
 */
export function setMeetBotBackend(backend: MeetBotBackend): void {
  resolvedBackend = backend;
}

/**
 * The resolved backend. Defaults to `"docker"` until the `init` hook
 * records a decision, so any caller that somehow runs before init keeps the
 * historical container-spawn behavior rather than silently switching modes.
 */
export function getMeetBotBackend(): MeetBotBackend {
  return resolvedBackend ?? "docker";
}

/** Reset the resolved backend. Only for tests. */
export function resetMeetBotBackendForTests(): void {
  resolvedBackend = null;
}

/**
 * Resolve the Docker Engine socket path the runner would connect to.
 * Honors a `MEET_DOCKER_SOCKET` override so operators can point the probe
 * (and the runner) at a non-default socket; otherwise uses the standard
 * `/var/run/docker.sock`.
 */
export function resolveDockerSocketPath(): string {
  return process.env.MEET_DOCKER_SOCKET?.trim() || DEFAULT_DOCKER_SOCKET_PATH;
}

/**
 * Probe whether a usable Docker Engine is reachable at `socketPath`.
 *
 * Reuses the runner's one-time `GET /_ping` reachability probe so a
 * successful probe here is memoized and the join-time spawn skips the extra
 * round-trip. Never throws - resolves `false` when the socket is missing or
 * unreachable, which is the normal case in a no-Docker environment (and the
 * exact signal that we should fall back to the direct backend).
 */
export async function detectDockerAvailable(
  socketPath: string = resolveDockerSocketPath(),
): Promise<boolean> {
  try {
    await ensureSocketReachable(socketPath);
    return true;
  } catch {
    return false;
  }
}
