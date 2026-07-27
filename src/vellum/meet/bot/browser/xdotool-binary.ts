/**
 * xdotool binary resolution, shared by `xdotool-click.ts` and
 * `xdotool-type.ts`.
 *
 * The binary lives at `/usr/bin/xdotool` in the bot container, but under a
 * relocated apt root (direct mode) it lands in the relocated bin dir that
 * the runner prepends to PATH — the same situation already handled for
 * chromium in `chrome-launcher.ts`. So: PATH first, container path as the
 * fallback that keeps the Docker image free of PATH assumptions.
 */

/** Container install location; last resort when PATH has no xdotool. */
const CONTAINER_XDOTOOL = "/usr/bin/xdotool";

/**
 * Resolve xdotool from PATH, falling back to the container's install
 * location. PATH is read per call (not snapshotted) because the direct
 * runner augments `process.env.PATH` in-process after startup.
 */
export function defaultXdotoolBinary(
  path: string = process.env.PATH ?? "",
): string {
  return Bun.which("xdotool", { PATH: path }) ?? CONTAINER_XDOTOOL;
}
