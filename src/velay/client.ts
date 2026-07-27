/**
 * WebSocket client for Velay — the outbound half of the reshaped `vellum`
 * provider.
 *
 * Note the direction change this represents. The `recall` provider is
 * *inbound*: Recall dials a public `wss://` URL the plugin exposes, which
 * is why that path needs a tunnel and a verification token. Velay is
 * *outbound*: the plugin dials Velay. No public surface, no tunnel, no
 * inbound auth — a materially smaller deployment story, and the main
 * reason this reshape is attractive beyond the platform-policy dead ends.
 *
 * ## Status
 *
 * The protocol (`contracts.ts`) is provisional and Velay's endpoint is not
 * yet live, so this client is deliberately **not wired into the join
 * path**. It exists so the shape can be reviewed, tested, and iterated on
 * against a real endpoint the moment one exists. `createVelayClient` takes
 * its socket factory as a dependency, so the tests drive it end to end
 * without a network.
 *
 * ## What it does own
 *
 * Connection lifecycle: dial, handshake, validated send/receive, and
 * exponential-backoff reconnect. Queued sends survive a reconnect so a
 * join issued during a blip is not silently dropped. Meeting state is NOT
 * owned here — the caller re-issues joins after a reconnect, because only
 * it knows which meetings should still be live.
 */

import {
  VelayClientMessageSchema,
  VelayServerMessageSchema,
  type VelayClientMessage,
  type VelayServerMessage,
} from "./contracts.ts";

/** Default wait for the `ready` handshake before treating a dial as failed. */
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
/** Default starting reconnect backoff. */
export const DEFAULT_RECONNECT_BASE_MS = 500;
/** Default reconnect backoff ceiling. */
export const DEFAULT_RECONNECT_MAX_MS = 30_000;
/** Max frames buffered while disconnected before the oldest are dropped. */
export const DEFAULT_SEND_QUEUE_LIMIT = 100;

/**
 * The slice of a WebSocket this client uses. Structural so tests inject a
 * fake and so the implementation is not tied to a particular ws library.
 */
export interface VelaySocket {
  send(data: string): void;
  close(): void;
  onOpen(cb: () => void): void;
  onMessage(cb: (data: string) => void): void;
  onClose(cb: (reason: string) => void): void;
  onError(cb: (err: Error) => void): void;
}

/** Factory that dials `url` and returns a socket. */
export type VelaySocketFactory = (url: string) => VelaySocket;

export interface VelayClientOptions {
  /** `wss://` endpoint to dial. */
  url: string;
  /** Opaque credential sent in the `hello` frame. */
  sessionToken: string;
  /** Plugin version reported to Velay. */
  clientVersion: string;
  socketFactory: VelaySocketFactory;
  /** Invoked for every validated server message. */
  onMessage: (msg: VelayServerMessage) => void;
  /** Connection came up and completed its handshake. */
  onConnected?: () => void;
  /** Connection dropped; a reconnect is scheduled unless the client is closed. */
  onDisconnected?: (reason: string) => void;
  logger?: { info: (m: string) => void; error: (m: string) => void };
  handshakeTimeoutMs?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  sendQueueLimit?: number;
}

export interface VelayClient {
  /**
   * Queue a frame. Sent immediately when connected and the handshake has
   * completed; otherwise buffered and flushed on the next successful
   * connect. Throws synchronously on an invalid frame so protocol bugs
   * surface at the call site.
   */
  send(msg: VelayClientMessage): void;
  /** True once `ready` has been received on the current connection. */
  isConnected(): boolean;
  /** Number of frames waiting for a connection. */
  pendingCount(): number;
  /** Close and stop reconnecting. Idempotent. */
  close(): void;
}

const NOOP_LOGGER = { info: () => undefined, error: () => undefined };

export function createVelayClient(opts: VelayClientOptions): VelayClient {
  const logger = opts.logger ?? NOOP_LOGGER;
  const handshakeTimeoutMs =
    opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  const baseMs = opts.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS;
  const maxMs = opts.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;
  const queueLimit = opts.sendQueueLimit ?? DEFAULT_SEND_QUEUE_LIMIT;

  let socket: VelaySocket | null = null;
  let ready = false;
  let closed = false;
  let backoff = baseMs;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  const queue: VelayClientMessage[] = [];

  function clearHandshakeTimer(): void {
    if (handshakeTimer !== null) {
      clearTimeout(handshakeTimer);
      handshakeTimer = null;
    }
  }

  function teardown(reason: string): void {
    clearHandshakeTimer();
    const wasReady = ready;
    ready = false;
    if (socket) {
      try {
        socket.close();
      } catch {
        // Already gone.
      }
      socket = null;
    }
    if (wasReady) opts.onDisconnected?.(reason);
    scheduleReconnect();
  }

  function scheduleReconnect(): void {
    if (closed || reconnectTimer !== null) return;
    const delay = backoff;
    backoff = Math.min(backoff * 2, maxMs);
    logger.info(`velay: reconnecting in ${delay}ms`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!closed) connect();
    }, delay);
  }

  /** Write a frame straight to the socket, bypassing the queue. */
  function writeNow(msg: VelayClientMessage): boolean {
    if (socket === null) return false;
    try {
      socket.send(JSON.stringify(msg));
      return true;
    } catch (err) {
      logger.error(
        `velay: send failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  function flushQueue(): void {
    while (queue.length > 0) {
      const next = queue[0]!;
      if (!writeNow(next)) return;
      queue.shift();
    }
  }

  function connect(): void {
    if (closed) return;
    let sock: VelaySocket;
    try {
      sock = opts.socketFactory(opts.url);
    } catch (err) {
      logger.error(
        `velay: dial failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      scheduleReconnect();
      return;
    }
    socket = sock;

    sock.onOpen(() => {
      // The handshake rides the same validated path as everything else.
      writeNow({
        type: "hello",
        sessionToken: opts.sessionToken,
        clientVersion: opts.clientVersion,
      });
      // A socket that opens but never acks is worse than one that fails to
      // open — it looks healthy while dropping every join on the floor.
      handshakeTimer = setTimeout(() => {
        logger.error(
          `velay: no ready handshake within ${handshakeTimeoutMs}ms; recycling the connection`,
        );
        teardown("handshake timeout");
      }, handshakeTimeoutMs);
    });

    sock.onMessage((data) => {
      let raw: unknown;
      try {
        raw = JSON.parse(data);
      } catch {
        logger.error("velay: dropped non-JSON frame");
        return;
      }
      const parsed = VelayServerMessageSchema.safeParse(raw);
      if (!parsed.success) {
        // Drop rather than tear down: an unknown frame is far more likely
        // to be Velay ahead of us on the protocol than a broken socket.
        logger.error(`velay: dropped invalid frame: ${parsed.error.message}`);
        return;
      }
      const msg = parsed.data;
      if (msg.type === "ready") {
        clearHandshakeTimer();
        ready = true;
        backoff = baseMs;
        logger.info(`velay: connected (server ${msg.serverVersion})`);
        opts.onConnected?.();
        flushQueue();
        return;
      }
      opts.onMessage(msg);
    });

    sock.onClose((reason) => {
      logger.info(`velay: connection closed: ${reason}`);
      teardown(reason);
    });

    sock.onError((err) => {
      logger.error(`velay: socket error: ${err.message}`);
      teardown(err.message);
    });
  }

  connect();

  return {
    send(msg: VelayClientMessage): void {
      // Validate first so a malformed frame throws at the call site rather
      // than being queued and failing invisibly later.
      VelayClientMessageSchema.parse(msg);
      if (ready && writeNow(msg)) return;
      if (queue.length >= queueLimit) {
        const dropped = queue.shift();
        logger.error(
          `velay: send queue full (${queueLimit}); dropped a queued ${dropped?.type ?? "frame"}`,
        );
      }
      queue.push(msg);
    },
    isConnected: () => ready,
    pendingCount: () => queue.length,
    close(): void {
      if (closed) return;
      closed = true;
      clearHandshakeTimer();
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      ready = false;
      if (socket) {
        try {
          socket.close();
        } catch {
          // Already gone.
        }
        socket = null;
      }
    },
  };
}
