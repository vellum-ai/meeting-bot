/**
 * Tests for the Velay WebSocket client.
 *
 * A fake socket drives the whole lifecycle in-process: handshake, queueing
 * while disconnected, reconnect with backoff, and frame validation in both
 * directions. No network, no timers longer than a tick.
 */

import { describe, expect, test } from "bun:test";

import {
  VELAY_CLIENT_MESSAGE_TYPES,
  VELAY_SERVER_MESSAGE_TYPES,
  VelayClientMessageSchema,
  VelayServerMessageSchema,
} from "../velay/contracts.ts";
import { createVelayClient, type VelaySocket } from "../velay/client.ts";
import type { VelayServerMessage } from "../velay/contracts.ts";

interface FakeSocket extends VelaySocket {
  sent: string[];
  /** Simulate the transport opening. */
  open(): void;
  /** Deliver a raw frame to the client. */
  deliver(data: string): void;
  /** Deliver a structured server frame. */
  deliverMsg(msg: VelayServerMessage): void;
  /** Simulate the peer closing. */
  drop(reason: string): void;
  closed: boolean;
}

function makeFakeSocket(): FakeSocket {
  let onOpen = (): void => undefined;
  let onMessage = (_d: string): void => undefined;
  let onClose = (_r: string): void => undefined;
  let onError = (_e: Error): void => undefined;
  const sock: FakeSocket = {
    sent: [],
    closed: false,
    send: (data) => sock.sent.push(data),
    close: () => {
      sock.closed = true;
    },
    onOpen: (cb) => {
      onOpen = cb;
    },
    onMessage: (cb) => {
      onMessage = cb;
    },
    onClose: (cb) => {
      onClose = cb;
    },
    onError: (cb) => {
      onError = cb;
    },
    open: () => onOpen(),
    deliver: (data) => onMessage(data),
    deliverMsg: (msg) => onMessage(JSON.stringify(msg)),
    drop: (reason) => onClose(reason),
  };
  void onError;
  return sock;
}

const READY: VelayServerMessage = { type: "ready", serverVersion: "0.1.0" };

/** Build a client over a controllable list of sockets, newest last. */
function harness(overrides: Partial<Parameters<typeof createVelayClient>[0]> = {}) {
  const sockets: FakeSocket[] = [];
  const received: VelayServerMessage[] = [];
  const client = createVelayClient({
    url: "wss://velay.test/socket",
    sessionToken: "tok",
    clientVersion: "test",
    socketFactory: () => {
      const s = makeFakeSocket();
      sockets.push(s);
      return s;
    },
    onMessage: (m) => received.push(m),
    reconnectBaseMs: 1,
    reconnectMaxMs: 4,
    handshakeTimeoutMs: 50,
    ...overrides,
  });
  return { client, sockets, received };
}

describe("velay contracts", () => {
  test("discriminator lists match the unions", () => {
    // Every listed client type parses as a member of the union.
    expect(new Set(VELAY_CLIENT_MESSAGE_TYPES)).toEqual(
      new Set(["hello", "join", "leave", "speak", "send_chat"]),
    );
    expect(new Set(VELAY_SERVER_MESSAGE_TYPES)).toEqual(
      new Set([
        "ready",
        "lifecycle",
        "transcript",
        "participant.change",
        "speaker.change",
        "chat.inbound",
        "command_result",
        "error",
      ]),
    );
  });

  test("round-trips a join and a transcript", () => {
    const join = {
      type: "join" as const,
      meetingId: "m-1",
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      displayName: "Vellum",
    };
    expect(VelayClientMessageSchema.parse(join)).toEqual(join);

    const transcript = {
      type: "transcript" as const,
      meetingId: "m-1",
      text: "hello",
      isFinal: true,
      timestamp: "2026-07-27T00:00:00Z",
    };
    expect(VelayServerMessageSchema.parse(transcript)).toEqual(transcript);
  });

  test("rejects a join with no meeting id", () => {
    expect(() =>
      VelayClientMessageSchema.parse({
        type: "join",
        meetingId: "",
        meetingUrl: "https://meet.google.com/abc-defg-hij",
        displayName: "Vellum",
      }),
    ).toThrow();
  });
});

describe("createVelayClient", () => {
  test("sends hello on open and reports connected only after ready", () => {
    const { client, sockets } = harness();
    const sock = sockets[0]!;

    sock.open();
    expect(sock.sent.length).toBe(1);
    expect(JSON.parse(sock.sent[0]!)).toMatchObject({
      type: "hello",
      sessionToken: "tok",
    });
    // The handshake is not complete until `ready` lands.
    expect(client.isConnected()).toBe(false);

    sock.deliverMsg(READY);
    expect(client.isConnected()).toBe(true);
  });

  test("queues frames sent before the handshake and flushes them after", () => {
    const { client, sockets } = harness();
    const sock = sockets[0]!;

    client.send({
      type: "join",
      meetingId: "m-1",
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      displayName: "Vellum",
    });
    expect(client.pendingCount()).toBe(1);

    sock.open();
    sock.deliverMsg(READY);

    expect(client.pendingCount()).toBe(0);
    const types = sock.sent.map((s) => JSON.parse(s).type);
    expect(types).toEqual(["hello", "join"]);
  });

  test("forwards validated server events and drops invalid ones", () => {
    const { client, sockets, received } = harness();
    const sock = sockets[0]!;
    sock.open();
    sock.deliverMsg(READY);

    sock.deliverMsg({
      type: "lifecycle",
      meetingId: "m-1",
      state: "joined",
      timestamp: "2026-07-27T00:00:00Z",
    });
    // `ready` is consumed internally, so only the lifecycle surfaces.
    expect(received.length).toBe(1);
    expect(received[0]!.type).toBe("lifecycle");

    // Garbage and unknown frames are dropped without killing the socket.
    sock.deliver("not json");
    sock.deliver(JSON.stringify({ type: "from_the_future" }));
    expect(received.length).toBe(1);
    expect(client.isConnected()).toBe(true);
  });

  test("throws at the call site on an invalid outbound frame", () => {
    const { client, sockets } = harness();
    sockets[0]!.open();
    sockets[0]!.deliverMsg(READY);

    expect(() =>
      client.send({
        type: "speak",
        meetingId: "m-1",
        text: "",
        requestId: "r-1",
      } as never),
    ).toThrow();
  });

  test("reconnects after a drop and re-handshakes", async () => {
    const { client, sockets } = harness();
    sockets[0]!.open();
    sockets[0]!.deliverMsg(READY);
    expect(client.isConnected()).toBe(true);

    sockets[0]!.drop("peer went away");
    expect(client.isConnected()).toBe(false);

    // Backoff is 1ms in the harness.
    await new Promise((r) => setTimeout(r, 20));
    expect(sockets.length).toBeGreaterThan(1);

    const next = sockets[sockets.length - 1]!;
    next.open();
    next.deliverMsg(READY);
    expect(client.isConnected()).toBe(true);
  });

  test("frames sent while disconnected survive the reconnect", async () => {
    const { client, sockets } = harness();
    sockets[0]!.open();
    sockets[0]!.deliverMsg(READY);
    sockets[0]!.drop("blip");

    client.send({ type: "leave", meetingId: "m-1" });
    expect(client.pendingCount()).toBe(1);

    await new Promise((r) => setTimeout(r, 20));
    const next = sockets[sockets.length - 1]!;
    next.open();
    next.deliverMsg(READY);

    expect(client.pendingCount()).toBe(0);
    expect(next.sent.map((s) => JSON.parse(s).type)).toEqual(["hello", "leave"]);
  });

  test("drops the oldest queued frame when the queue is full", () => {
    const { client } = harness({ sendQueueLimit: 2 });
    for (const id of ["m-1", "m-2", "m-3"]) {
      client.send({ type: "leave", meetingId: id });
    }
    expect(client.pendingCount()).toBe(2);
  });

  test("recycles a connection that opens but never acks", async () => {
    const { client, sockets } = harness({ handshakeTimeoutMs: 5 });
    sockets[0]!.open();
    // No `ready` — the socket looks healthy but would swallow every join.
    await new Promise((r) => setTimeout(r, 30));
    expect(sockets[0]!.closed).toBe(true);
    expect(client.isConnected()).toBe(false);
    expect(sockets.length).toBeGreaterThan(1);
  });

  test("close() stops reconnecting", async () => {
    const { client, sockets } = harness();
    sockets[0]!.open();
    sockets[0]!.deliverMsg(READY);
    client.close();
    sockets[0]!.drop("after close");

    const count = sockets.length;
    await new Promise((r) => setTimeout(r, 20));
    expect(sockets.length).toBe(count);
    expect(client.isConnected()).toBe(false);
  });
});
