/**
 * Vellum Runtime worker entry point.
 *
 * Runs as a standalone Bun process spawned by the daemon-side supervisor
 * (`src/vellum/runtime.ts`); shows up as `vellum-worker` in `assistant ps`.
 * Everything heavyweight in the Vellum Runtime lives here, out of the
 * daemon's event loop, and all of it in this one process: the meet session
 * manager (which spawns and supervises one bot per meeting), the in-process
 * bot-event ingress (`src/vellum/ingress.ts`), and the loopback control
 * server the join/leave skill scripts call.
 *
 * ## Protocol (stdout → daemon, one JSON object per line)
 *
 *   {"type":"ready","controlPort":N,"ingressPort":N}
 *       Emitted once the control server and ingress listener are up.
 *
 *   {"type":"event","meetingId":"...","event":{...MeetBotEvent}}
 *       A meet-bot event for an active meeting. The daemon adapts these into
 *       the session store and the transcript-flush pipeline.
 *
 *   {"type":"session","action":"opened"|"closed","meetingId":"...", ...}
 *       Session lifecycle bookkeeping: the daemon mirrors these into its
 *       in-memory session store and data/sessions.json.
 *
 *   {"type":"log","level":"...","msg":"...","meta":...}
 *       Forwarded to the plugin logger.
 *
 * ## Protocol (stdin ← daemon)
 *
 *   "stop\n": graceful shutdown (bots leave, listeners close, exit 0).
 *   stdin close (daemon died): same shutdown path, so a plugin reload can
 *   never leak an orphaned runtime.
 *
 * ## Control server
 *
 * Binds 127.0.0.1 on `config.listenPort` (the same knob the Recall realtime
 * receiver uses; only one provider runtime runs at a time, so there is no
 * clash). The skill scripts read the port from resolved-config.json, so
 * both sides always agree on it. Internal-only (loopback plus the
 * daemon-supervised lifecycle), so requests are not token-authenticated:
 *
 *   POST /join  {"meetingUrl": "...", "conversationId": "..."|null}
 *   POST /leave {"meetingId": "..."}
 *
 * The bot-event ingress (`meet-internal`) keeps its per-meeting bearer
 * tokens: it binds beyond loopback so Docker bots can reach it.
 */

import { randomUUID } from "node:crypto";

import type { MeetBotEvent } from "./meet/contracts/index.ts";
import {
  detectDockerAvailable,
  getMeetBotBackend,
  resolveDockerSocketPath,
  setMeetBotBackend,
} from "./meet/daemon/meet-backend.ts";
import { createEventPublisher, subscribeToMeetingEvents } from "./meet/daemon/event-publisher.ts";
import {
  createMeetSessionManager,
  type MeetSessionManagerDeps,
} from "./meet/daemon/session-manager.ts";
import { getMeetConfig } from "./meet/meet-config.ts";
import { ensureBrowserStack } from "./meet/src/ensure-browser-stack.ts";
import { setMeetHost } from "./meet/src/tool-runtime.ts";
import type { DaemonRuntimeMode } from "./meet/plugin-host.ts";
import { startMeetIngress } from "./ingress.ts";
import { createWorkerHost, type SendToParent } from "./worker-host.ts";

import type { MeetingBotConfig } from "../config.ts";

/** Google Meet URL shape (mirrors meet-join's `meet_join` tool validation). */
export const MEET_URL_REGEX =
  /^https:\/\/meet\.google\.com\/[a-z]{3,4}-?[a-z]{4}-?[a-z]{3,4}(?:\?.*)?$/i;

/** Spawn argument the supervisor passes as base64 JSON in argv[2]. */
export interface VellumWorkerArgs {
  config: MeetingBotConfig;
  workspaceDir: string;
  assistantName: string | null;
  runtimeMode: DaemonRuntimeMode;
}

function send(obj: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

/** No-op stand-ins for the meet-join sub-modules the Vellum Runtime does not use. */
export function noopSubModuleDeps(): MeetSessionManagerDeps {
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
        throw new Error("meeting-bot: voice output for the vellum provider is not wired yet");
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function main(): Promise<void> {
  const encoded = process.argv[2];
  if (!encoded) {
    send({ type: "log", level: "error", msg: "missing worker argument" });
    process.exit(1);
  }
  const args = JSON.parse(
    Buffer.from(encoded, "base64").toString("utf-8"),
  ) as VellumWorkerArgs;

  const sendToParent: SendToParent = send;
  const host = createWorkerHost({
    workspaceDir: args.workspaceDir,
    assistantName: args.assistantName,
    runtimeMode: args.runtimeMode,
    send: sendToParent,
  });
  setMeetHost(host);
  const log = host.logger.get("vellum-runtime");

  // Bot backend probe, mirroring meet-join's init hook: a Docker container
  // per meeting when an engine is reachable, else a direct child process.
  const socketPath = resolveDockerSocketPath();
  const dockerAvailable = await detectDockerAvailable(socketPath);
  const backend = dockerAvailable ? "docker" : "direct";
  setMeetBotBackend(backend);
  log.info(`meet bot backend selected: ${backend}`, { socketPath });
  if (backend === "direct") {
    ensureBrowserStack(host.logger.get("browser-stack"));
  }

  // Bot-event ingress, serving the route files under meet/routes (only the
  // meet-internal bot ingress lives there). Runs in-process: no extra OS
  // process, so `assistant ps` shows a single vellum-worker.
  const routesDir = new URL("./meet/routes", import.meta.url).pathname;
  const ingress = startMeetIngress(host.logger.get("ingress"), routesDir);

  createEventPublisher(host);

  const sessionManager = createMeetSessionManager(host, {
    resolveDaemonUrl: () => ingress.urlForBackend(getMeetBotBackend()),
    resolveAssistantDisplayName: () => args.assistantName,
    // Relay every meeting event to the daemon, which owns the session store
    // and the transcript-flush pipeline.
    conversationBridgeFactory: ({ meetingId }) => {
      let unsubscribe: (() => void) | null = null;
      return {
        subscribe(): void {
          if (unsubscribe) return;
          unsubscribe = subscribeToMeetingEvents(meetingId, (event: MeetBotEvent) => {
            send({ type: "event", meetingId, event });
          });
        },
        unsubscribe(): void {
          unsubscribe?.();
          unsubscribe = null;
        },
      };
    },
    ...noopSubModuleDeps(),
  });

  // Loopback control server for the join/leave skill scripts. Binds the
  // configured listenPort so the scripts can derive the port from
  // resolved-config.json instead of a separately published file.
  const control = Bun.serve({
    hostname: "127.0.0.1",
    port: args.config.listenPort,
    fetch: async (req) => {
      const path = new URL(req.url).pathname.replace(/\/+$/, "");
      if (req.method !== "POST") {
        return jsonResponse({ error: "method not allowed" }, 405);
      }

      let body: Record<string, unknown>;
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        return jsonResponse({ error: "request body must be valid JSON" }, 400);
      }

      if (path === "/join") {
        const meetingUrl =
          typeof body.meetingUrl === "string" ? body.meetingUrl.trim() : "";
        if (!MEET_URL_REGEX.test(meetingUrl)) {
          return jsonResponse(
            { error: "meetingUrl must be a Google Meet link (https://meet.google.com/xxx-yyyy-zzz)" },
            400,
          );
        }
        const conversationId =
          typeof body.conversationId === "string" && body.conversationId.length > 0
            ? body.conversationId
            : null;

        const meetConfig = getMeetConfig(args.workspaceDir);
        const consentMessage = meetConfig.consentMessage
          .split("{assistantName}")
          .join(args.assistantName ?? "Vellum");

        const meetingId = randomUUID();
        try {
          await sessionManager.join({
            url: meetingUrl,
            meetingId,
            conversationId: conversationId ?? "",
            consentMessage,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return jsonResponse({ error: `failed to join meeting: ${message}` }, 502);
        }

        send({
          type: "session",
          action: "opened",
          meetingId,
          meetingUrl,
          conversationId,
          startedAt: Date.now(),
        });
        return jsonResponse({ meetingId, status: "joining" });
      }

      if (path === "/leave") {
        const meetingId = typeof body.meetingId === "string" ? body.meetingId : "";
        if (!meetingId) return jsonResponse({ error: "meetingId is required" }, 400);
        try {
          await sessionManager.leave(meetingId, "user_request");
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return jsonResponse({ error: `failed to leave meeting: ${message}` }, 502);
        }
        send({ type: "session", action: "closed", meetingId });
        return jsonResponse({ meetingId, status: "left" });
      }

      return jsonResponse({ error: "not found" }, 404);
    },
  });

  send({ type: "ready", controlPort: control.port, ingressPort: ingress.port });

  let shuttingDown = false;
  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await sessionManager.shutdownAll("vellum runtime shutdown");
    } catch (err) {
      log.error("session manager shutdown failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    control.stop(true);
    await ingress.stop();
    process.exit(0);
  }

  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk: string) => {
    for (const line of chunk.split("\n")) {
      if (line.trim() === "stop") void shutdown();
    }
  });
  process.stdin.on("close", () => {
    void shutdown();
  });
}

if (import.meta.main) {
  main().catch((err) => {
    send({ type: "log", level: "error", msg: `fatal: ${String(err)}` });
    process.exit(1);
  });
}
