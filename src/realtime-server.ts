/**
 * Realtime receiver — the WebSocket server Recall dials back into.
 *
 * ## Why this is a server the plugin hosts (not a client it opens)
 *
 * Recall's realtime model is inverted from a typical webhook client: when a bot
 * is created with a `websocket` realtime endpoint, Recall opens an *outbound*
 * connection *to a URL the integration exposes* and streams in-call events
 * (transcript utterances, participant joins/leaves, optionally audio/video
 * buffers) over it. So the integration must be listening at a stable, public
 * `wss://` address before any bot is created.
 *
 * That lifecycle is exactly what the `init` / `shutdown` plugin hooks are for:
 * `init` starts this server once at plugin bootstrap; `shutdown` stops it on
 * teardown. The server outlives individual meetings — one listener fields the
 * realtime streams of every concurrent bot, demultiplexed by bot id inside the
 * event payloads.
 *
 * ## Connection handling
 *
 *   - Verification: when a `verificationToken` is configured, the inbound
 *     connection's `?token=` query parameter must match, else the upgrade is
 *     rejected with 401. (Recall also supports signed-header verification; the
 *     token approach is the simpler default this scaffold ships.)
 *   - Keep-alive: Recall notes that idle proxies may drop the socket, so the
 *     server pings every open connection on a fixed interval.
 *   - Dispatch: each JSON frame is parsed against the realtime envelope and
 *     routed to the session store via the normalized extractors.
 *
 * The server is a process-wide singleton: `startRealtimeServer` is idempotent
 * and `stopRealtimeServer` is safe to call when nothing is running.
 */

import type { Server, ServerWebSocket } from "bun";

import type { MeetingBotConfig } from "./config.ts";
import {
  RealtimeMessageSchema,
  extractParticipantEvent,
  extractUtterance,
} from "./realtime-events.ts";
import {
  recordParticipantEvent,
  recordUtterance,
} from "./session-store.ts";

/** Minimal logger surface (matches the host's PluginLogger shape). */
export interface Logger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
  debug(obj: Record<string, unknown>, msg?: string): void;
}

interface SocketData {
  remote: string;
}

const KEEPALIVE_INTERVAL_MS = 30_000;

interface RunningServer {
  server: Server;
  sockets: Set<ServerWebSocket<SocketData>>;
  keepAlive: ReturnType<typeof setInterval>;
  logger: Logger;
}

let running: RunningServer | null = null;

/** True when the realtime server is currently listening. */
export function isRealtimeServerRunning(): boolean {
  return running !== null;
}

/** The address the server is bound to, for diagnostics. */
export function realtimeServerAddress(): string | null {
  if (!running) return null;
  return `${running.server.hostname}:${running.server.port}`;
}

/**
 * Start the realtime WebSocket server. Idempotent: a second call while already
 * running is a no-op that logs and returns.
 */
export function startRealtimeServer(
  config: MeetingBotConfig,
  logger: Logger,
): void {
  if (running) {
    logger.warn(
      { address: realtimeServerAddress() },
      "meeting-bot: realtime server already running",
    );
    return;
  }

  const sockets = new Set<ServerWebSocket<SocketData>>();
  const expectedToken = config.verificationToken;

  const server = Bun.serve<SocketData, undefined>({
    hostname: config.listenHost,
    port: config.listenPort,
    fetch(req, srv) {
      const url = new URL(req.url);

      // A plain GET at the root doubles as a health check for tunnels/probes.
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return new Response("meeting-bot realtime receiver: ok", {
          status: 200,
        });
      }

      if (expectedToken) {
        const presented = url.searchParams.get("token");
        if (presented !== expectedToken) {
          logger.warn(
            { remote: clientAddr(req, srv) },
            "meeting-bot: rejecting realtime connection — token mismatch",
          );
          return new Response("unauthorized", { status: 401 });
        }
      }

      const ok = srv.upgrade(req, { data: { remote: clientAddr(req, srv) } });
      if (ok) return undefined;
      return new Response("websocket upgrade failed", { status: 400 });
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
        logger.info({ remote: ws.data.remote }, "meeting-bot: realtime connection open");
      },
      message(ws, raw) {
        handleFrame(raw, logger);
      },
      close(ws, code, reason) {
        sockets.delete(ws);
        logger.info(
          { remote: ws.data.remote, code, reason },
          "meeting-bot: realtime connection closed",
        );
      },
    },
  });

  // Recall keeps the connection persistent; ping periodically so an idle
  // reverse proxy does not silently drop it.
  const keepAlive = setInterval(() => {
    for (const ws of sockets) {
      try {
        ws.ping();
      } catch {
        // Socket already gone; the close handler will prune it.
      }
    }
  }, KEEPALIVE_INTERVAL_MS);
  // Do not let the keep-alive timer hold the process open on its own.
  if (typeof keepAlive.unref === "function") keepAlive.unref();

  running = { server, sockets, keepAlive, logger };
  logger.info(
    { address: `${server.hostname}:${server.port}` },
    "meeting-bot: realtime server started",
  );
}

/** Stop the realtime server and drop all connections. Safe when not running. */
export function stopRealtimeServer(): void {
  if (!running) return;
  const { server, sockets, keepAlive, logger } = running;

  clearInterval(keepAlive);
  for (const ws of sockets) {
    try {
      ws.close(1001, "server shutting down");
    } catch {
      // best-effort
    }
  }
  sockets.clear();
  server.stop(true);
  running = null;
  logger.info({}, "meeting-bot: realtime server stopped");
}

/** Parse one inbound frame and route it to the session store. */
function handleFrame(raw: string | Buffer, logger: Logger): void {
  let json: unknown;
  try {
    json = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf-8"));
  } catch {
    logger.warn({}, "meeting-bot: dropping non-JSON realtime frame");
    return;
  }

  const parsed = RealtimeMessageSchema.safeParse(json);
  if (!parsed.success) {
    logger.warn({}, "meeting-bot: dropping malformed realtime message");
    return;
  }

  const msg = parsed.data;

  if (msg.event.startsWith("transcript.")) {
    const utterance = extractUtterance(msg);
    if (utterance) recordUtterance(utterance);
    return;
  }

  if (msg.event.startsWith("participant_events.")) {
    const event = extractParticipantEvent(msg);
    if (event) recordParticipantEvent(event);
    return;
  }

  // Unrecognized (e.g. audio/video buffer events) — ignore for the scaffold.
  logger.debug({ event: msg.event }, "meeting-bot: unhandled realtime event");
}

function clientAddr(req: Request, srv: Server): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return srv.requestIP(req)?.address ?? "unknown";
}
