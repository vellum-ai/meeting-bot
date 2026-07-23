/**
 * `shutdown` hook — plugin teardown.
 *
 * Fires once when the daemon unloads the plugin (process exit or unload). It
 * stops the realtime WebSocket server subprocess that the `init` hook spawned,
 * closing every open Recall connection and cleaning up the child process.
 *
 * This does NOT ask live bots to leave their calls: a bot's lifecycle is owned
 * by Recall and survives a plugin reload. Tearing the receiver down simply
 * means realtime events stop being consumed until the plugin loads again;
 * Recall's own retry policy reconnects when the endpoint is back.
 */

import type { ShutdownContext } from "@vellumai/plugin-api";

import { teardownInbound } from "../src/inbound.ts";
import type { Logger } from "../src/realtime-server.ts";
import { stopRealtimeServer } from "../src/realtime-server.ts";
import { shutdownVellumRuntime } from "../src/vellum/runtime.ts";

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

const shutdown = async (_ctx: ShutdownContext): Promise<void> => {
  // Vellum Runtime teardown (safe no-op when the runtime never started):
  // active meetings leave, then the subprocess exits.
  await shutdownVellumRuntime(noopLogger);
  await stopRealtimeServer();
  // ShutdownContext does not carry a logger, so use a noop logger for
  // tunnel teardown — the tunnel process is being killed anyway.
  await teardownInbound(noopLogger);
};

export default shutdown;
