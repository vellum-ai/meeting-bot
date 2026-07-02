/**
 * `init` hook — plugin bootstrap.
 *
 * Runs once when the daemon loads the plugin. Its job is to make the plugin
 * ready to send bots: validate the operator config, stash it for the tools,
 * and stand up the realtime WebSocket server that Recall will dial back into
 * for live transcript and participant events.
 *
 * The realtime server is a long-lived, per-plugin listener (not per-meeting):
 * one socket endpoint fields every concurrent bot's stream. Standing it up here
 * — rather than lazily on first join — means it is reachable at the stable
 * public URL before any bot is created, which is what Recall requires.
 *
 * Init is intentionally non-fatal on a server bind failure: it logs and returns
 * so the plugin still loads (tools will report the receiver is down). A missing
 * or invalid config, however, throws — the plugin cannot function without an
 * API key and a callback URL.
 */

import type { InitContext } from "@vellumai/plugin-api";

import {
  credentialEnvVar,
  realtimeEndpointUrl,
  resolveApiKey,
  resolveConfig,
} from "../src/config.ts";
import { setResolvedConfig } from "../src/plugin-state.ts";
import { startRealtimeServer } from "../src/realtime-server.ts";

const init = async (ctx: InitContext): Promise<void> => {
  const { config, warnings } = resolveConfig(ctx.config);
  for (const w of warnings) {
    ctx.logger.warn({ warning: w }, `meeting-bot config: ${w}`);
  }

  setResolvedConfig(config);

  // Surface a missing API-key credential early (non-fatal): the realtime
  // receiver can still start, but join/leave will fail until the secret is
  // provisioned into the environment from the credential store.
  try {
    resolveApiKey(config);
  } catch (err) {
    ctx.logger.warn(
      {
        credential: config.apiKeyCredential,
        envVar: credentialEnvVar(config.apiKeyCredential),
      },
      `meeting-bot: ${String(err)}`,
    );
  }

  try {
    startRealtimeServer(config, ctx.logger);
    ctx.logger.info(
      {
        region: config.region,
        endpoint: realtimeEndpointUrl(config),
        events: config.events,
      },
      "meeting-bot: initialized — realtime receiver is listening for Recall connections",
    );
  } catch (err) {
    ctx.logger.error(
      { error: String(err).slice(0, 300), listenPort: config.listenPort },
      "meeting-bot: failed to start realtime server — bots can still be created but realtime events will not be received until this is resolved",
    );
  }
};

export default init;
