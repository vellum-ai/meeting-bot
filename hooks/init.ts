/**
 * `init` hook — plugin bootstrap.
 *
 * Runs once when the daemon loads the plugin. Its job is to make the plugin
 * ready to send bots: validate the operator config, write the resolved config
 * for skill scripts to read, and spawn the realtime WebSocket server subprocess
 * that Recall will dial back into for live transcript and participant events.
 *
 * The realtime server runs in its own OS process so that a flood of realtime
 * frames cannot block the daemon's event loop. It is spawned here, in `init`,
 * rather than lazily on first join, so it is reachable at the stable public URL
 * before any bot is created, which is what Recall requires.
 *
 * Init is intentionally non-fatal on a server spawn failure: it logs and
 * returns so the plugin still loads (tools will report the receiver is down).
 * A missing or invalid config, however, throws — the plugin cannot function
 * without an API key and a callback URL.
 */

import type { InitContext } from "@vellumai/plugin-api";

import { resolveConfig } from "../src/config.ts";
import { resolveAssistantName } from "../src/identity.ts";
import {
  setAssistantName,
  setInitContext,
  setResolvedConfig,
} from "../src/plugin-state.ts";
import {
  restartProviderRuntime,
  startProviderRuntime,
  writeResolvedConfigFile,
} from "../src/provider-runtime.ts";
import { startReloadWatcher, type ReloadWatcher } from "../src/reload-watcher.ts";
import { pluginDataDir } from "../src/plugin-paths.ts";

let reloadWatcher: ReloadWatcher | null = null;

/** Stop the reload watcher (called from the shutdown hook). */
export function stopReloadWatcher(): void {
  reloadWatcher?.stop();
  reloadWatcher = null;
}

const init = async (ctx: InitContext): Promise<void> => {
  const { config, warnings } = resolveConfig(ctx.config);
  for (const w of warnings) {
    ctx.logger.warn({ warning: w }, `meeting-bot config: ${w}`);
  }

  setResolvedConfig(config);
  // Stash the context so the provider route can tear down and spin up
  // provider runtimes live (see src/provider-runtime.ts).
  setInitContext(ctx);

  // Write the resolved config to the plugin's data directory so the skill
  // scripts (join, leave) can read it. The scripts run as standalone bun
  // processes and do not have access to the InitContext.
  writeResolvedConfigFile(ctx, config);

  // Resolve the assistant's display name from IDENTITY.md so bots can join
  // as the assistant rather than Recall's generic "Meeting Notetaker". A
  // missing or unparsable identity is non-fatal: the join script simply omits
  // the name and Recall falls back to its workspace default.
  const name = resolveAssistantName(ctx.pluginStorageDir);
  if (name) {
    setAssistantName(name);
    ctx.logger.info(
      { assistantName: name },
      "meeting-bot: resolved assistant name from IDENTITY.md for bot display name",
    );
  } else {
    ctx.logger.debug(
      {},
      "meeting-bot: no assistant name found in IDENTITY.md — bots will use the Recall workspace default name",
    );
  }

  // Start the runtime the configured provider selects: the Vellum Runtime
  // subprocess for "vellum", or the Recall realtime receiver (plus tunnel)
  // for the default "recall". Shared with the provider route so a live
  // provider switch runs exactly the same code (src/provider-runtime.ts).
  await startProviderRuntime(ctx, config);

  // Serve reload requests from the reload skill script: it writes a request
  // file into data/ and this watcher restarts the provider runtime live and
  // writes the outcome back, so a reload completes on the conversation turn
  // that asked for it (see src/reload-watcher.ts).
  stopReloadWatcher();
  reloadWatcher = startReloadWatcher({
    dataDir: pluginDataDir(),
    restart: restartProviderRuntime,
    logger: ctx.logger,
  });
};

export default init;
