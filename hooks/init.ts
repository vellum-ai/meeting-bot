/**
 * `init` hook — plugin bootstrap.
 *
 * Runs once when the daemon loads the plugin. Its job is to make the plugin
 * ready to send bots: validate the operator config, stash it for the tools,
 * and spawn the realtime WebSocket server subprocess that Recall will dial
 * back into for live transcript and participant events.
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

import {
  credentialEnvVar,
  realtimeEndpointUrl,
  resolveApiKey,
  resolveConfig,
} from "../src/config.ts";
import { resolveAssistantName } from "../src/identity.ts";
import { setAssistantName, setResolvedConfig } from "../src/plugin-state.ts";
import { startRealtimeServer } from "../src/realtime-server.ts";

const init = async (ctx: InitContext): Promise<void> => {
  const { config, warnings } = resolveConfig(ctx.config);
  for (const w of warnings) {
    ctx.logger.warn({ warning: w }, `meeting-bot config: ${w}`);
  }

  setResolvedConfig(config);

  // Resolve the assistant's display name from IDENTITY.md so bots can join
  // as the assistant rather than Recall's generic "Meeting Notetaker". A
  // missing or unparsable identity is non-fatal: the join tool simply omits
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
    await startRealtimeServer(config, ctx.logger);
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
