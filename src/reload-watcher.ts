/**
 * File-based reload handshake between the reload skill script and the
 * daemon-resident plugin code.
 *
 * The old reload script bounced the plugin via `assistant plugins disable`
 * then `enable`, which only takes effect when the host reconciles plugin
 * sources at the next conversation-turn boundary, so the restart landed a
 * turn late. Restarting the provider runtime does not need a plugin code
 * reload at all, and the daemon-side plugin already knows how to do it
 * live (`restartProviderRuntime`, the same path the dashboard's provider
 * switch uses). Skill scripts cannot call into the daemon directly (no
 * plugin-api out of process, and CLI callers of the daemon HTTP port are
 * disallowed by convention), so the handshake goes through the data dir:
 *
 *   1. The script writes `data/reload-request.json` `{id, at}`.
 *   2. This watcher (polling; started from the init hook) sees the new id,
 *      calls the injected restart function, and writes
 *      `data/reload-result.json` `{id, ok, note, at}`.
 *   3. The script polls the result file for its id and reports the actual
 *      outcome, on the same conversation turn.
 *
 * Polling by stat/read is deliberate, mirroring the host's own plugin
 * source watcher: inotify-style watchers are unreliable across the write
 * patterns editors and scripts use.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Logger } from "./realtime-server.ts";

/** Request file the reload script writes. */
export const RELOAD_REQUEST_FILE = "reload-request.json";
/** Result file this watcher writes back. */
export const RELOAD_RESULT_FILE = "reload-result.json";

const DEFAULT_POLL_INTERVAL_MS = 750;

export interface ReloadWatcher {
  stop(): void;
}

export interface ReloadWatcherOptions {
  dataDir: string;
  /** Performs the actual restart; returns a human-readable note. */
  restart: () => Promise<string>;
  logger: Logger;
  pollIntervalMs?: number;
}

/**
 * Start polling for reload requests. Requests are deduplicated by id, and
 * a restart in flight defers new requests to the next poll tick.
 */
export function startReloadWatcher(opts: ReloadWatcherOptions): ReloadWatcher {
  const { dataDir, restart, logger } = opts;
  const requestPath = join(dataDir, RELOAD_REQUEST_FILE);
  const resultPath = join(dataDir, RELOAD_RESULT_FILE);
  let lastHandledId = "";
  let busy = false;

  // A request left over from before this watcher started (e.g. written
  // while the plugin was down) is adopted as already-handled rather than
  // replayed: its writer gave up long ago, and restarting the runtime as a
  // side effect of plugin init would double the work init just did.
  try {
    if (existsSync(requestPath)) {
      const parsed = JSON.parse(readFileSync(requestPath, "utf-8")) as {
        id?: unknown;
      };
      if (typeof parsed.id === "string") lastHandledId = parsed.id;
    }
  } catch {
    // Malformed leftovers are ignored; a fresh request will overwrite.
  }

  async function poll(): Promise<void> {
    if (busy || !existsSync(requestPath)) return;

    let id = "";
    try {
      const parsed = JSON.parse(readFileSync(requestPath, "utf-8")) as {
        id?: unknown;
      };
      if (typeof parsed.id === "string") id = parsed.id;
    } catch {
      return; // torn or malformed write; retry next tick
    }
    if (!id || id === lastHandledId) return;

    busy = true;
    lastHandledId = id;
    logger.info({ requestId: id }, "meeting-bot: reload requested via data dir");
    let ok = true;
    let note: string;
    try {
      note = await restart();
    } catch (err) {
      ok = false;
      note = `provider runtime restart failed: ${String(err).slice(0, 300)}`;
      logger.error({ requestId: id, error: note }, "meeting-bot: reload request failed");
    }
    try {
      writeFileSync(
        resultPath,
        JSON.stringify({ id, ok, note, at: Date.now() }, null, 2),
        "utf-8",
      );
      rmSync(requestPath, { force: true });
    } catch (err) {
      logger.warn(
        { error: String(err).slice(0, 200) },
        "meeting-bot: failed to write reload result",
      );
    }
    busy = false;
  }

  const timer = setInterval(() => {
    void poll();
  }, opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();

  return {
    stop(): void {
      clearInterval(timer);
    },
  };
}
