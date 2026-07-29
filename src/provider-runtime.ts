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
 *
 * None of this depends on state left behind by the `init` hook. A runtime is
 * driven from a logger and the plugin's data directory ({@link
 * ProviderRuntimeContext}), both of which a route can produce on its own, so a
 * live switch works whether or not it shares a module instance with the hook
 * that started the runtime it is replacing.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

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
import { pluginConfigPath, pluginDataDir } from "./plugin-paths.ts";
import { setResolvedConfig } from "./plugin-state.ts";
import { routeLogger } from "./route-logger.ts";
import {
  startRealtimeServer,
  stopRealtimeServer,
  type Logger,
} from "./realtime-server.ts";
import { initVellumRuntime, shutdownVellumRuntime } from "./vellum/runtime.ts";
import { existsSync, readFileSync } from "node:fs";

/**
 * What a provider runtime needs from whoever is driving it: somewhere to log,
 * and the plugin's writable data directory (PID files, resolved-config.json,
 * IDENTITY.md).
 *
 * The daemon's `InitContext` satisfies this structurally, so the `init` hook
 * passes its own. A route has no context to pass and builds one instead — see
 * {@link restartProviderRuntime}. Narrowing to these two fields is what makes
 * that possible: everything else the runtimes need is derived from the
 * plugin's own location (`plugin-paths.ts`).
 */
export interface ProviderRuntimeContext {
  logger: Logger;
  pluginStorageDir: string;
}

/**
 * The context a route drives a provider runtime with, built from the plugin's
 * own location rather than read from anywhere.
 *
 * `pluginStorageDir` is the same directory the daemon passes the `init` hook
 * (`<pluginDir>/data`), reached here through `plugin-paths.ts`, so a runtime
 * started from a route reads and writes exactly what one started from the hook
 * does — same PID files, same `resolved-config.json`.
 */
export function providerRuntimeContext(): ProviderRuntimeContext {
  return { logger: routeLogger, pluginStorageDir: pluginDataDir() };
}

/** Write resolved-config.json so the skill scripts see the current config. */
export function writeResolvedConfigFile(
  ctx: ProviderRuntimeContext,
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
  ctx: ProviderRuntimeContext,
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
 *
 * Takes only a logger: a stop never needs to know where the plugin's data
 * lives, and both runtimes fall back to reaping their recorded PID when this
 * process no longer holds the child handle (see `worker-pidfile.ts`). So a
 * teardown is worth attempting even when nothing here looks like it is
 * running — that fallback is the only thing that takes down a worker whose
 * supervisor state was lost.
 */
export async function stopProviderRuntimes(logger: Logger): Promise<void> {
  await shutdownVellumRuntime(logger);
  await stopRealtimeServer();
  await teardownInbound(logger);
}

/**
 * Re-read config.json and bounce the provider runtime: tear both runtimes
 * down, then start the one the (possibly just-changed) config selects. Used
 * by the provider route for live switches and same-provider reloads.
 *
 * Runs entirely off the plugin's own location, so it does not matter whether
 * the `init` hook ran in this module instance: the config comes from
 * `config.json`, the data directory from `plugin-paths.ts`, and the runtimes
 * find any worker this process has lost track of through their PID files.
 * Returns a human-readable note for the route response.
 */
export async function restartProviderRuntime(): Promise<string> {
  const ctx = providerRuntimeContext();

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
  await stopProviderRuntimes(ctx.logger);
  await startProviderRuntime(ctx, config);

  return `provider runtime restarted (${config.provider})`;
}
