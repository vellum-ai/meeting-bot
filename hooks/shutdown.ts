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

import { stopRealtimeServer } from "../src/realtime-server.ts";

const shutdown = async (_ctx: ShutdownContext): Promise<void> => {
  await stopRealtimeServer();
};

export default shutdown;
