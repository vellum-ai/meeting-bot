/**
 * Process-wide runtime state for the meet-join plugin under the external
 * plugin loader.
 *
 * The loader discovers the plugin's surface statically — `hooks/<name>.ts`
 * and `tools/<name>.ts` default exports today, with top-level `routes/`
 * discovery coming — and the tools and routes carry their own execution
 * logic. This module is the wiring the loader cannot express
 * declaratively: the `init` hook calls {@link initializeMeetPlugin},
 * which builds the `SkillHost` bridge over `@vellumai/plugin-api`,
 * starts the plugin-owned bot ingress listener (a file-based dispatcher
 * over `routes/` — interim transport until the assistant auto-registers
 * those files), constructs the session manager, and publishes the host
 * for the tools and routes to read at execute time (via
 * `src/tool-runtime.ts`).
 *
 * State is module-global on purpose: the daemon loads one instance of the
 * plugin per process, and the session manager itself already relies on a
 * module-level singleton (`createMeetSessionManager` installs it).
 */

import type { InitContext } from "@vellumai/plugin-api";

import { getMeetBotBackend } from "../daemon/meet-backend.js";
import { createEventPublisher } from "../daemon/event-publisher.js";
import { createMeetSessionManager } from "../daemon/session-manager.js";
import type { MeetIngressListener } from "./ingress-listener.js";
import { startMeetIngressListener } from "./ingress-listener.js";
import { createPluginApiHost } from "./plugin-api-host.js";
import { setMeetHost } from "./tool-runtime.js";

interface MeetPluginRuntime {
  ingress: MeetIngressListener;
  sessionManager: ReturnType<typeof createMeetSessionManager>;
  log: InitContext["logger"];
}

let runtime: MeetPluginRuntime | null = null;

/**
 * Build the host bridge, start the ingress listener (as a subprocess), and
 * wire the session manager. Idempotent — repeat calls are no-ops so a
 * hook-level retry cannot double-bind the listener or session manager.
 *
 * Async because the ingress subprocess reports its bound port
 * asynchronously via stdout; the init hook awaits this.
 */
export async function initializeMeetPlugin(ctx: InitContext): Promise<void> {
  if (runtime) return;

  const host = createPluginApiHost(ctx);

  // Publish the host for the loader-surface tools and routes to read at
  // execute time — before the listener starts serving, since the route
  // handlers resolve the host from this slot per request.
  setMeetHost(host);

  // The ingress listener runs as its own subprocess: it binds a TCP port
  // (the URL the bot POSTs events to) and relays each HTTP request to this
  // process via JSON-lines over stdio. The daemon side handles file-based
  // routing over `routes/` and dispatches to the route handlers, where
  // `getMeetHost()` and the session event router are accessible. The
  // assistant will soon discover `routes/` and auto-register these handlers
  // on its own server; until that lands, the subprocess is the transport.
  const ingress = await startMeetIngressListener(
    host.logger.get("meet-ingress"),
  );

  // Wire the event publisher before the session manager is constructed,
  // since the session manager imports module-level thunks (publishMeetEvent,
  // subscribeToMeetingEvents) that throw unless createEventPublisher has
  // installed the singleton.
  createEventPublisher(host);

  // Construct the session manager eagerly so the tool modules that import
  // the module-level `MeetSessionManager` singleton resolve against a live
  // instance. Sub-module factories are resolved from the in-skill registry
  // inside the constructor — the session-manager module's side-effect
  // imports trigger the required `registerSubModule(...)` registrations at
  // import time.
  //
  // The bot POSTs its events to `DAEMON_URL`; until the assistant
  // auto-registers the `routes/` files on its own server, point it at
  // the plugin's own listener. Resolved per join because the backend
  // (docker vs direct child process) is selected lazily per spawn.
  const sessionManager = createMeetSessionManager(host, {
    resolveDaemonUrl: () => ingress.urlForBackend(getMeetBotBackend()),
  });

  runtime = { ingress, sessionManager, log: ctx.logger };
  ctx.logger.info(
    { ingressPort: ingress.port },
    "meet-join: plugin runtime initialized",
  );
}

/**
 * Tear down everything `initializeMeetPlugin` stood up: active meeting
 * sessions first (bots leave / containers stop), then the ingress
 * listener. The host slot is cleared first so tool calls racing shutdown
 * degrade to the clean "not initialized" error.
 */
export async function shutdownMeetPlugin(reason: string): Promise<void> {
  if (!runtime) return;
  const current = runtime;
  runtime = null;
  setMeetHost(null);

  try {
    await current.sessionManager.shutdownAll(reason);
  } catch (err) {
    current.log.error(
      { err: err instanceof Error ? err.message : String(err) },
      "meet-join: session manager shutdown failed",
    );
  }

  await current.ingress.stop();
}

/** Test-only: reset module state so suites can re-run init. */
export function resetMeetPluginRuntimeForTests(): void {
  runtime = null;
  setMeetHost(null);
}
