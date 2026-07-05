/**
 * Realtime WebSocket server subprocess entry point.
 *
 * This runs as a standalone Bun process spawned by the plugin's `init` hook.
 * It owns the `Bun.serve()` WebSocket listener that Recall dials back into,
 * and relays every realtime event it receives to the parent (daemon) process
 * as JSON-lines over stdout. The parent dispatches those lines into the
 * in-memory session store that tools read.
 *
 * Splitting the server into its own process:
 *   - isolates the WebSocket listener from the daemon's event loop (a flood
 *     of realtime frames cannot block LLM calls or tool execution),
 *   - gives the server its own crash/restart boundary, and
 *   - makes it visible in the assistant's process tree.
 *
 * Protocol (stdout → parent, one JSON object per line):
 *
 *   {"type":"ready","address":"127.0.0.1:8790"}
 *       Emitted once after the server is listening. The parent treats this as
 *       the readiness signal.
 *
 *   {"type":"connection","remote":"<ip>","action":"open"|"close"}
 *       Connection lifecycle changes.
 *
 *   {"type":"event","event":"<kind>","data":{...}}
 *       A parsed realtime frame from Recall. The parent routes these to the
 *       session store.
 *
 *   {"type":"log","level":"info"|"warn"|"error","msg":"..."}
 *       Structured log line; the parent forwards to its logger.
 *
 * Protocol (stdin ← parent):
 *
 *   "stop\n"
 *       Graceful shutdown request. The subprocess closes all sockets and
 *       exits 0.
 */

import type { Server, ServerWebSocket } from "bun";

import type { MeetingBotConfig } from "./config.ts";
import { RealtimeMessageSchema } from "./realtime-events.ts";

interface SocketData {
  remote: string;
}

const KEEPALIVE_INTERVAL_MS = 30_000;

function send(obj: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function log(level: string, msg: string): void {
  send({ type: "log", level, msg });
}

function parseConfigFromArgv(): MeetingBotConfig {
  // The config is passed as a base64-encoded JSON string in argv[2] to avoid
  // env-var size limits and keep the command line readable.
  const encoded = process.argv[2];
  if (!encoded) {
    log("error", "missing config argument (expected base64 JSON in argv[2])");
    process.exit(1);
  }
  try {
    const json = Buffer.from(encoded, "base64").toString("utf-8");
    return JSON.parse(json) as MeetingBotConfig;
  } catch (err) {
    log("error", `failed to parse config: ${String(err)}`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const config = parseConfigFromArgv();
  const expectedToken = config.verificationToken;
  const sockets = new Set<ServerWebSocket<SocketData>>();

  const server = Bun.serve<SocketData, undefined>({
    hostname: config.listenHost,
    port: config.listenPort,
    fetch(req, srv) {
      const url = new URL(req.url);

      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return new Response("meeting-bot realtime receiver: ok", {
          status: 200,
        });
      }

      if (expectedToken) {
        const presented = url.searchParams.get("token");
        if (presented !== expectedToken) {
          log("warn", `rejecting realtime connection — token mismatch from ${clientAddr(req, srv)}`);
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
        send({ type: "connection", remote: ws.data.remote, action: "open" });
      },
      message(_ws, raw) {
        handleFrame(raw);
      },
      close(ws, code, _reason) {
        sockets.delete(ws);
        send({ type: "connection", remote: ws.data.remote, action: "close", code });
      },
    },
  });

  const keepAlive = setInterval(() => {
    for (const ws of sockets) {
      try {
        ws.ping();
      } catch {
        // Socket gone; close handler will prune it.
      }
    }
  }, KEEPALIVE_INTERVAL_MS);
  if (typeof keepAlive.unref === "function") keepAlive.unref();

  const address = `${server.hostname}:${server.port}`;
  send({ type: "ready", address });

  // Listen for the parent's stop signal on stdin.
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk: string) => {
    const lines = chunk.split("\n");
    for (const line of lines) {
      if (line.trim() === "stop") {
        shutdown();
        return;
      }
    }
  });

  // If stdin closes (parent died), shut down.
  process.stdin.on("close", () => {
    shutdown();
  });

  function shutdown(): void {
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
    log("info", "realtime subprocess stopped");
    process.exit(0);
  }
}

function handleFrame(raw: string | Buffer): void {
  let json: unknown;
  try {
    json = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf-8"));
  } catch {
    log("warn", "dropping non-JSON realtime frame");
    return;
  }

  const parsed = RealtimeMessageSchema.safeParse(json);
  if (!parsed.success) {
    log("warn", "dropping malformed realtime message");
    return;
  }

  const msg = parsed.data;
  send({ type: "event", event: msg.event, data: msg.data });
}

function clientAddr(req: Request, srv: Server): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return srv.requestIP(req)?.address ?? "unknown";
}

main().catch((err) => {
  log("error", `fatal: ${String(err)}`);
  process.exit(1);
});
