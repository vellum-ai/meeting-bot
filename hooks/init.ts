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

import {
  CREDENTIAL_FIELD,
  CREDENTIAL_SERVICE,
  realtimeEndpointUrl,
  resolveApiKey,
  resolveConfig,
} from "../src/config.ts";
import { resolveAssistantName } from "../src/identity.ts";
import { setupInbound } from "../src/inbound.ts";
import { setAssistantName, setResolvedConfig } from "../src/plugin-state.ts";
import { startRealtimeServer } from "../src/realtime-server.ts";
import { initVellumMeetRuntime } from "../src/vellum-meet.ts";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const init = async (ctx: InitContext): Promise<void> => {
  let { config, warnings } = resolveConfig(ctx.config);
  for (const w of warnings) {
    ctx.logger.warn({ warning: w }, `meeting-bot config: ${w}`);
  }

  setResolvedConfig(config);

  // Write the resolved config to the plugin's data directory so the skill
  // scripts (join, leave) can read it. The scripts run as standalone bun
  // processes and do not have access to the InitContext.
  try {
    writeFileSync(
      join(ctx.pluginStorageDir, "resolved-config.json"),
      JSON.stringify(config, null, 2),
      "utf-8",
    );
  } catch (err) {
    ctx.logger.warn(
      { error: String(err).slice(0, 200) },
      "meeting-bot: failed to write resolved-config.json — skill scripts will not be able to read config",
    );
  }

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

  // Provider switch: the vellum provider runs the in-house meet bot (the
  // vendored meet-join subsystem under meet/); the default recall provider
  // uses Recall.ai with the realtime WebSocket receiver. Everything below the
  // branch is provider-specific; the config write and identity resolution
  // above are shared.
  if (config.provider === "vellum") {
    try {
      await initVellumMeetRuntime(ctx, config);
    } catch (err) {
      ctx.logger.error(
        { error: String(err).slice(0, 300) },
        "meeting-bot: failed to initialize the vellum meet runtime — joins will fail until this is resolved",
      );
    }
    return;
  }

  // Surface a missing API-key credential early (non-fatal): the realtime
  // receiver can still start, but join/leave will fail until the key is
  // stored in the credential store. The meeting-bot-setup skill guides
  // the user through providing it.
  try {
    await resolveApiKey();
  } catch (err) {
    ctx.logger.warn(
      {
        credential: `${CREDENTIAL_SERVICE}:${CREDENTIAL_FIELD}`,
        service: CREDENTIAL_SERVICE,
        field: CREDENTIAL_FIELD,
      },
      `meeting-bot: ${String(err)}`,
    );
  }

  try {
    await startRealtimeServer(config, ctx.logger, {
      pidFileDir: ctx.pluginStorageDir,
    });

    // If the operator did not supply a publicWsUrl, auto-provision a
    // Cloudflare Tunnel so Recall can reach the realtime server. This is
    // a temporary, insecure measure — see src/inbound.ts for details.
    if (!config.publicWsUrl) {
      ctx.logger.info(
        {},
        "meeting-bot: no publicWsUrl configured — auto-provisioning Cloudflare Tunnel",
      );
      try {
        const result = await setupInbound(config.listenPort, ctx.logger);
        config = { ...config, publicWsUrl: result.publicWsUrl };
        setResolvedConfig(config);
        // Update the resolved-config file with the tunnel URL so scripts
        // can read it.
        try {
          writeFileSync(
            join(ctx.pluginStorageDir, "resolved-config.json"),
            JSON.stringify(config, null, 2),
            "utf-8",
          );
        } catch {
          // best-effort — the first write already has everything except the URL
        }
        ctx.logger.info(
          { publicWsUrl: result.publicWsUrl },
          "meeting-bot: auto-provisioned tunnel URL",
        );
      } catch (err) {
        ctx.logger.error(
          { error: String(err).slice(0, 300) },
          "meeting-bot: failed to auto-provision tunnel — bots cannot be created without a publicWsUrl. Set one in config.json or install cloudflared.",
        );
      }
    }

    ctx.logger.info(
      {
        region: config.region,
        endpoint: config.publicWsUrl
          ? realtimeEndpointUrl(config)
          : "(tunnel not established)",
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
