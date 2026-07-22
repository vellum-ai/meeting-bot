/**
 * Provider runtime lifecycle, shared by the init hook and the provider route.
 *
 * The plugin runs exactly one provider runtime at a time:
 *
 *   - recall: the realtime WebSocket receiver subprocess (plus the
 *     auto-provisioned tunnel when no publicWsUrl is configured), and
 *   - vellum: the Vellum Runtime subprocess.
 *
 * `startProviderRuntime` spins up whichever the config selects and
 * `stopProviderRuntimes` tears both down (each stop is a safe no-op when that
 * runtime is not running). `restartProviderRuntime` re-reads config.json and
 * bounces the runtime; the provider route calls it so a provider change (or a
 * same-provider reload) takes effect immediately instead of waiting for the
 * next plugin load.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { InitContext } from "@vellumai/plugin-api";

import {
  CREDENTIAL_FIELD,
  CREDENTIAL_SERVICE,
  REALTIME_EVENTS,
  realtimeEndpointUrl,
  resolveApiKey,
  resolveConfig,
  type MeetingBotConfig,
} from "./config.ts";
import { setupInbound, teardownInbound } from "./inbound.ts";
import { pluginConfigPath } from "./plugin-paths.ts";
import { getInitContext, setResolvedConfig } from "./plugin-state.ts";
import { startRealtimeServer, stopRealtimeServer } from "./realtime-server.ts";
import { initVellumRuntime, shutdownVellumRuntime } from "./vellum/runtime.ts";
import { existsSync, readFileSync } from "node:fs";

/** Write resolved-config.json so the skill scripts see the current config. */
export function writeResolvedConfigFile(
  ctx: InitContext,
  config: MeetingBotConfig,
): void {
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
}

/**
 * Start the runtime for the configured provider. Non-fatal on failure (logs
 * and returns) so a broken runtime never takes the plugin down with it.
 */
export async function startProviderRuntime(
  ctx: InitContext,
  config: MeetingBotConfig,
): Promise<void> {
  if (config.provider === "vellum") {
    try {
      await initVellumRuntime(ctx, config);
    } catch (err) {
      ctx.logger.error(
        { error: String(err).slice(0, 300) },
        "meeting-bot: failed to initialize the Vellum Runtime: joins will fail until this is resolved",
      );
    }
    return;
  }

  // Surface a missing API-key credential early (non-fatal): the realtime
  // receiver can still start, but join/leave will fail until the key is
  // stored in the credential store.
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
        writeResolvedConfigFile(ctx, config);
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
        events: REALTIME_EVENTS,
      },
      "meeting-bot: initialized — realtime receiver is listening for Recall connections",
    );
  } catch (err) {
    ctx.logger.error(
      { error: String(err).slice(0, 300), listenPort: config.listenPort },
      "meeting-bot: failed to start realtime server — bots can still be created but realtime events will not be received until this is resolved",
    );
  }
}

/**
 * Stop every provider runtime. Each stop is a safe no-op when that runtime is
 * not running, so this is callable regardless of which provider is active.
 */
export async function stopProviderRuntimes(ctx: InitContext): Promise<void> {
  await shutdownVellumRuntime();
  await stopRealtimeServer();
  await teardownInbound(ctx.logger);
}

/**
 * Re-read config.json and bounce the provider runtime: tear both runtimes
 * down, then start the one the (possibly just-changed) config selects. Used
 * by the provider route for live switches and same-provider reloads.
 *
 * Returns a human-readable note for the route response. When the plugin has
 * not initialized (no stashed InitContext, e.g. in unit tests), the config
 * write still stands and the note says the runtime was not touched.
 */
export async function restartProviderRuntime(): Promise<string> {
  const ctx = getInitContext();
  if (!ctx) {
    return "provider saved; runtime not restarted (plugin not initialized)";
  }

  const path = pluginConfigPath();
  let raw: unknown = {};
  if (existsSync(path)) {
    try {
      raw = JSON.parse(readFileSync(path, "utf-8"));
    } catch {
      // resolveConfig defaults an empty object; the provider was just
      // written by the route, so a parse failure here is effectively
      // impossible outside manual edits.
    }
  }
  const { config } = resolveConfig(raw);

  setResolvedConfig(config);
  writeResolvedConfigFile(ctx, config);

  ctx.logger.info(
    { provider: config.provider },
    "meeting-bot: restarting provider runtime",
  );
  await stopProviderRuntimes(ctx);
  await startProviderRuntime(ctx, config);

  return `provider runtime restarted (${config.provider})`;
}
