/**
 * Vellum provider runtime: drives the vendored meet-join subsystem (`meet/`)
 * as meeting-bot's in-house alternative to Recall.
 *
 * When `config.provider === "vellum"`, the init hook calls
 * {@link initVellumMeetRuntime} instead of starting the Recall realtime
 * receiver. This stands up (mirroring meet-join's own `plugin-runtime.ts`):
 *
 *   - the `SkillHost` bridge over `@vellumai/plugin-api`,
 *   - the bot-backend probe (Docker container per meeting, or a direct child
 *     process when no Docker engine is reachable),
 *   - the ingress listener subprocess that the bot POSTs events to (serving
 *     the route files under `meet/routes/`: deliberately NOT the plugin's
 *     top-level `routes/`, so the app/settings routes are never exposed on
 *     the ingress port), and
 *   - the meet session manager, with the optional meet-join sub-modules
 *     (consent, storage, TTS, lip-sync, barge-in, proactive chat) replaced by
 *     no-ops: meeting-bot pipes transcripts through its own session store and
 *     transcript-flush pipeline instead of meet-join's conversation bridge.
 *
 * The join/leave skill scripts command this runtime over HTTP: init writes
 * `data/vellum-control.json` with the ingress port and a minted control token,
 * and the scripts POST to `/control/join` / `/control/leave` (served from
 * `meet/routes/control/`) with that token as a bearer.
 *
 * Event flow: bot → ingress → `meet/routes/meet-internal.ts` → session event
 * router → the per-meeting bridge below → `ingestUtterance` /
 * `recordParticipantEvent`, i.e. the same store and debounced conversation
 * flush the Recall path uses.
 */

import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { InitContext } from "@vellumai/plugin-api";

import type { MeetBotEvent } from "../meet/contracts/index.ts";
import {
  detectDockerAvailable,
  getMeetBotBackend,
  resolveDockerSocketPath,
  setMeetBotBackend,
} from "../meet/daemon/meet-backend.ts";
import {
  createEventPublisher,
  subscribeToMeetingEvents,
} from "../meet/daemon/event-publisher.ts";
import {
  createMeetSessionManager,
  type MeetConversationBridgeFactoryArgs,
  type MeetSessionManagerDeps,
} from "../meet/daemon/session-manager.ts";
import { getMeetConfig } from "../meet/meet-config.ts";
import { ensureBrowserStack } from "../meet/src/ensure-browser-stack.ts";
import {
  startMeetIngressListener,
  type MeetIngressListener,
} from "../meet/src/ingress-listener.ts";
import { createPluginApiHost } from "../meet/src/plugin-api-host.ts";
import { getMeetHost, setMeetHost } from "../meet/src/tool-runtime.ts";

import type { MeetingBotConfig } from "./config.ts";
import { resolveAssistantName } from "./identity.ts";
import { pluginDataDir } from "./plugin-paths.ts";
import { ingestUtterance, clearTranscriptBuffer, type Logger } from "./realtime-server.ts";
import {
  closeSession,
  openSession,
  persistSessionEntry,
  recordParticipantEvent,
  removePersistedSession,
} from "./session-store.ts";

/** File under data/ the skill scripts read to reach the control routes. */
export const VELLUM_CONTROL_FILE = "vellum-control.json";

/** Google Meet URL shape (mirrors meet-join's `meet_join` tool validation). */
export const MEET_URL_REGEX =
  /^https:\/\/meet\.google\.com\/[a-z]{3,4}-?[a-z]{4}-?[a-z]{3,4}(?:\?.*)?$/i;

interface VellumMeetRuntime {
  ingress: MeetIngressListener;
  sessionManager: ReturnType<typeof createMeetSessionManager>;
  controlToken: string;
  config: MeetingBotConfig;
  logger: Logger;
  /** Per-meeting event unsubscribers, for teardown on leave. */
  unsubscribers: Map<string, () => void>;
}

let runtime: VellumMeetRuntime | null = null;

/** True when the vellum meet runtime is up. */
export function isVellumMeetRuntimeRunning(): boolean {
  return runtime !== null;
}

/** Directory holding the route files the ingress listener serves. */
function meetRoutesDir(): string {
  return join(new URL(".", import.meta.url).pathname, "..", "meet", "routes");
}

/**
 * Pipe one meet-bot event into meeting-bot's pipeline. This is the adapter at
 * the heart of the vellum provider: transcript chunks become normalized
 * utterances feeding the session store and the debounced conversation flush
 * (exactly like Recall's realtime events), participant changes update the
 * roster, and terminal lifecycle states tear the session down.
 *
 * Exported for direct unit testing; production traffic reaches it through
 * the per-meeting bridge below.
 */
export function handleVellumMeetEvent(
  meetingId: string,
  event: MeetBotEvent,
  opts: { logger: Logger; config: MeetingBotConfig },
): void {
  switch (event.type) {
    case "transcript.chunk": {
      ingestUtterance(
        {
          botId: meetingId,
          text: event.text,
          speakerName: event.speakerLabel,
          speakerId: event.speakerId,
          isPartial: !event.isFinal,
        },
        opts.logger,
        opts.config,
      );
      return;
    }
    case "participant.change": {
      for (const p of event.joined) {
        recordParticipantEvent({
          botId: meetingId,
          action: "join",
          participantId: p.id,
          participantName: p.name,
        });
      }
      for (const p of event.left) {
        recordParticipantEvent({
          botId: meetingId,
          action: "leave",
          participantId: p.id,
          participantName: p.name,
        });
      }
      return;
    }
    case "lifecycle": {
      opts.logger.info(
        { meetingId, state: event.state, detail: event.detail },
        "meeting-bot: vellum meet lifecycle",
      );
      if (event.state === "left" || event.state === "error") {
        clearTranscriptBuffer(meetingId);
        closeSession(meetingId);
        removePersistedSession(meetingId);
      }
      return;
    }
    default:
      // speaker.change / chat.inbound are not piped yet.
      return;
  }
}

/**
 * Per-meeting bridge from meet-bot events into meeting-bot's pipeline.
 * Installed as the session manager's conversation-bridge so registration and
 * teardown ride the existing session lifecycle.
 */
function createVellumBridge(
  args: MeetConversationBridgeFactoryArgs,
  state: VellumMeetRuntime,
): { subscribe(): void; unsubscribe(): void } {
  const { meetingId } = args;
  const handle = (event: MeetBotEvent): void =>
    handleVellumMeetEvent(meetingId, event, {
      logger: state.logger,
      config: state.config,
    });

  let unsubscribe: (() => void) | null = null;
  return {
    subscribe(): void {
      if (unsubscribe) return;
      unsubscribe = subscribeToMeetingEvents(meetingId, handle);
      state.unsubscribers.set(meetingId, unsubscribe);
    },
    unsubscribe(): void {
      unsubscribe?.();
      unsubscribe = null;
      state.unsubscribers.delete(meetingId);
    },
  };
}

/** No-op stand-ins for the meet-join sub-modules meeting-bot does not use. */
function noopSubModuleDeps(): MeetSessionManagerDeps {
  return {
    consentMonitorFactory: () => ({ start() {}, stop() {} }),
    storageWriterFactory: () => ({
      start() {},
      async startAudio() {},
      async stop() {},
    }),
    chatOpportunityDetectorFactory: () => ({
      start() {},
      dispose() {},
      getStats: () => ({
        tier1Hits: 0,
        tier2Calls: 0,
        tier2PositiveCount: 0,
        escalationsFired: 0,
        escalationsSuppressed: 0,
        voiceWakesFired: 0,
      }),
    }),
    ttsBridgeFactory: (args) => ({
      meetingId: args.meetingId,
      botBaseUrl: args.botBaseUrl,
      async speak() {
        throw new Error(
          "meeting-bot: voice output for the vellum provider is not wired yet",
        );
      },
      async cancel() {},
      async cancelAll() {},
      activeStreamCount: () => 0,
      onViseme: () => () => {},
    }),
    ttsLipsyncFactory: () => ({ stop() {} }),
    bargeInWatcherFactory: () => ({ start() {}, stop() {} }),
  };
}

/**
 * Stand up the vellum meet runtime. Idempotent; the init hook calls this when
 * `config.provider === "vellum"`.
 */
export async function initVellumMeetRuntime(
  ctx: InitContext,
  config: MeetingBotConfig,
): Promise<void> {
  if (runtime) return;

  const host = createPluginApiHost(ctx);
  setMeetHost(host);

  // Backend probe, mirroring meet-join's init hook: Docker when reachable,
  // else a direct child process (which needs the browser stack installed).
  const socketPath = resolveDockerSocketPath();
  const dockerAvailable = await detectDockerAvailable(socketPath);
  const backend = dockerAvailable ? "docker" : "direct";
  setMeetBotBackend(backend);
  ctx.logger.info(
    { backend, socketPath },
    "meeting-bot: vellum meet bot backend selected",
  );
  if (backend === "direct") {
    ensureBrowserStack(host.logger.get("meeting-bot-browser-stack"));
  }

  const ingress = await startMeetIngressListener(
    host.logger.get("meeting-bot-ingress"),
    meetRoutesDir(),
  );

  createEventPublisher(host);

  const state: VellumMeetRuntime = {
    ingress,
    sessionManager: null as unknown as ReturnType<
      typeof createMeetSessionManager
    >,
    controlToken: randomBytes(32).toString("hex"),
    config,
    logger: ctx.logger,
    unsubscribers: new Map(),
  };

  state.sessionManager = createMeetSessionManager(host, {
    resolveDaemonUrl: () => ingress.urlForBackend(getMeetBotBackend()),
    resolveAssistantDisplayName: () =>
      resolveAssistantName(ctx.pluginStorageDir),
    conversationBridgeFactory: (args) => createVellumBridge(args, state),
    ...noopSubModuleDeps(),
  });

  runtime = state;

  // Publish the control endpoint for the join/leave skill scripts. The token
  // gates the control routes, which are reachable on the ingress port.
  mkdirSync(pluginDataDir(), { recursive: true });
  writeFileSync(
    join(pluginDataDir(), VELLUM_CONTROL_FILE),
    JSON.stringify({ port: ingress.port, token: state.controlToken }, null, 2),
    { encoding: "utf-8", mode: 0o600 },
  );

  ctx.logger.info(
    { ingressPort: ingress.port, backend },
    "meeting-bot: vellum meet runtime initialized",
  );
}

/** Tear down everything {@link initVellumMeetRuntime} stood up. */
export async function shutdownVellumMeetRuntime(reason: string): Promise<void> {
  if (!runtime) return;
  const current = runtime;
  runtime = null;
  setMeetHost(null);

  try {
    await current.sessionManager.shutdownAll(reason);
  } catch (err) {
    current.logger.error(
      { error: String(err).slice(0, 300) },
      "meeting-bot: vellum meet session manager shutdown failed",
    );
  }
  for (const unsub of current.unsubscribers.values()) unsub();
  current.unsubscribers.clear();
  await current.ingress.stop();
}

// --- Control route handlers -------------------------------------------------
//
// Served from meet/routes/control/{join,leave}.ts over the ingress listener.
// The skill scripts authenticate with the minted control token.

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** Constant-time bearer-token check against the runtime's control token. */
function isAuthorized(request: Request, state: VellumMeetRuntime): boolean {
  const header = request.headers.get("authorization");
  const match = header?.match(/^\s*Bearer\s+(\S+)\s*$/i);
  if (!match?.[1]) return false;
  const presented = Buffer.from(match[1]);
  const expected = Buffer.from(state.controlToken);
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
}

/** `POST /control/join`: join a meeting via the vellum meet bot. */
export async function handleVellumJoin(request: Request): Promise<Response> {
  const state = runtime;
  if (!state) {
    return json({ error: "vellum meet runtime is not initialized" }, 503);
  }
  if (!isAuthorized(request, state)) {
    return json({ error: "unauthorized" }, 401);
  }

  let body: { meetingUrl?: unknown; conversationId?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: "request body must be valid JSON" }, 400);
  }

  const meetingUrl = typeof body.meetingUrl === "string" ? body.meetingUrl.trim() : "";
  if (!MEET_URL_REGEX.test(meetingUrl)) {
    return json(
      { error: "meetingUrl must be a Google Meet link (https://meet.google.com/xxx-yyyy-zzz)" },
      400,
    );
  }
  const conversationId =
    typeof body.conversationId === "string" && body.conversationId.length > 0
      ? body.conversationId
      : null;

  // Resolve the consent greeting the bot posts in the meeting chat, with the
  // assistant's name substituted (mirrors meet-join's join tool).
  const host = getMeetHost();
  const meetConfig = getMeetConfig(host?.platform.workspaceDir() ?? process.cwd());
  const assistantName =
    resolveAssistantName(pluginDataDir()) ?? "Vellum";
  const consentMessage = meetConfig.consentMessage
    .split("{assistantName}")
    .join(assistantName);

  const meetingId = randomUUID();
  try {
    await state.sessionManager.join({
      url: meetingUrl,
      meetingId,
      conversationId: conversationId ?? "",
      consentMessage,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json({ error: `failed to join meeting: ${message}` }, 502);
  }

  openSession(meetingId, meetingUrl, conversationId, "vellum");
  persistSessionEntry({
    botId: meetingId,
    meetingUrl,
    conversationId,
    startedAt: Date.now(),
    provider: "vellum",
  });

  return json({ meetingId, status: "joining" });
}

/** `POST /control/leave`: have a vellum meet bot leave its meeting. */
export async function handleVellumLeave(request: Request): Promise<Response> {
  const state = runtime;
  if (!state) {
    return json({ error: "vellum meet runtime is not initialized" }, 503);
  }
  if (!isAuthorized(request, state)) {
    return json({ error: "unauthorized" }, 401);
  }

  let body: { meetingId?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: "request body must be valid JSON" }, 400);
  }
  const meetingId = typeof body.meetingId === "string" ? body.meetingId : "";
  if (!meetingId) {
    return json({ error: "meetingId is required" }, 400);
  }

  try {
    await state.sessionManager.leave(meetingId, "user_request");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json({ error: `failed to leave meeting: ${message}` }, 502);
  }

  clearTranscriptBuffer(meetingId);
  closeSession(meetingId);
  removePersistedSession(meetingId);

  return json({ meetingId, status: "left" });
}
