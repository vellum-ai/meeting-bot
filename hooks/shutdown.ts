/**
 * `shutdown` hook — plugin teardown.
 *
 * Fires once when the daemon unloads the plugin (process exit or unload). It
 * takes down whichever provider runtime is up, through the same
 * `stopProviderRuntimes` a live provider switch uses — so a teardown here and
 * a teardown mid-switch cannot drift apart.
 *
 * On the Recall path this does NOT ask live bots to leave their calls: a bot's
 * lifecycle is owned by Recall and survives a plugin reload. Tearing the
 * receiver down simply means realtime events stop being consumed until the
 * plugin loads again; Recall's own retry policy reconnects when the endpoint
 * is back. The Vellum Runtime does supervise its own bots, so they leave.
 */

import type { ShutdownContext } from "@vellumai/plugin-api";

import { stopProviderRuntimes } from "../src/provider-runtime.ts";
import type { Logger } from "../src/realtime-server.ts";

/**
 * ShutdownContext carries no logger, and the process is going away anyway, so
 * teardown runs silently.
 */
const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

const shutdown = async (_ctx: ShutdownContext): Promise<void> => {
  // Both provider runtimes, whichever was active: active meetings leave, the
  // subprocesses exit, the tunnel comes down. Each stop is a safe no-op when
  // that runtime never started.
  await stopProviderRuntimes(noopLogger);
};

export default shutdown;
