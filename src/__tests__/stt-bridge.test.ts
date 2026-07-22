/**
 * Tests for the daemon-side transcription relay bridge.
 *
 * Exercises the stt.* wire protocol against a fake session opener: open
 * (success and no-session), audio decode and forwarding, event relay back
 * to the worker, finalize, stop, and stopAll cleanup.
 */

import { describe, expect, test } from "bun:test";

import { createDaemonSttBridge } from "../vellum/stt-bridge.ts";
import type {
  SttStreamServerEvent,
  StreamingTranscriber,
} from "../vellum/stt-types.ts";
import type { Logger } from "../realtime-server.ts";

const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/** Let the async open path (openSession + start) settle. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface FakeSession extends StreamingTranscriber {
  audio: Array<{ buffer: Buffer; mimeType: string }>;
  finalized: number;
  stopped: number;
  emit: (event: SttStreamServerEvent) => void;
}

function makeFakeSession(): FakeSession {
  let onEvent: ((event: SttStreamServerEvent) => void) | null = null;
  const session: FakeSession = {
    audio: [],
    finalized: 0,
    stopped: 0,
    emit(event) {
      onEvent?.(event);
    },
    start(cb) {
      onEvent = cb;
      return Promise.resolve();
    },
    sendAudio(buffer, mimeType) {
      session.audio.push({ buffer, mimeType });
    },
    stop() {
      session.stopped += 1;
    },
    finalizeUtterance() {
      session.finalized += 1;
    },
  };
  return session;
}

function makeBridge(session: StreamingTranscriber | null) {
  const written: Array<Record<string, unknown>> = [];
  const bridge = createDaemonSttBridge({
    openSession: async () => session,
    writeToWorker: (msg) => written.push(msg),
    logger: noopLogger,
  });
  return { bridge, written };
}

describe("createDaemonSttBridge", () => {
  test("ignores non-stt messages", () => {
    const { bridge } = makeBridge(null);
    expect(bridge.handleMessage({ type: "ready" })).toBe(false);
    expect(bridge.handleMessage({ type: "event" })).toBe(false);
  });

  test("replies with an error when no session can be opened", async () => {
    const { bridge, written } = makeBridge(null);
    expect(bridge.handleMessage({ type: "stt.open", requestId: 7 })).toBe(true);
    await settle();
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ type: "stt.opened", requestId: 7 });
    expect(String(written[0]!.error)).toContain("no streaming transcription session");
    expect(bridge.sessionCount()).toBe(0);
  });

  test("opens a session and relays audio, events, finalize, and stop", async () => {
    const session = makeFakeSession();
    const { bridge, written } = makeBridge(session);

    bridge.handleMessage({ type: "stt.open", requestId: 1 });
    await settle();
    expect(written[0]).toMatchObject({ type: "stt.opened", requestId: 1 });
    const sessionId = written[0]!.sessionId as number;
    expect(sessionId).toBeGreaterThan(0);
    expect(bridge.sessionCount()).toBe(1);

    // Audio: base64 decodes back to the original bytes.
    const chunk = Buffer.from([1, 2, 3, 250]);
    bridge.handleMessage({
      type: "stt.audio",
      sessionId,
      chunk: chunk.toString("base64"),
      mimeType: "audio/pcm",
    });
    expect(session.audio).toHaveLength(1);
    expect(session.audio[0]!.buffer.equals(chunk)).toBe(true);
    expect(session.audio[0]!.mimeType).toBe("audio/pcm");

    // Provider events flow back to the worker tagged with the session id.
    session.emit({ type: "final", text: "hello" });
    const eventMsg = written.find((m) => m.type === "stt.event");
    expect(eventMsg).toMatchObject({
      sessionId,
      event: { type: "final", text: "hello" },
    });

    bridge.handleMessage({ type: "stt.finalize", sessionId });
    expect(session.finalized).toBe(1);

    bridge.handleMessage({ type: "stt.stop", sessionId });
    expect(session.stopped).toBe(1);
    expect(bridge.sessionCount()).toBe(0);
  });

  test("drops audio for unknown sessions without throwing", () => {
    const { bridge } = makeBridge(null);
    expect(
      bridge.handleMessage({
        type: "stt.audio",
        sessionId: 99,
        chunk: "AAAA",
        mimeType: "audio/pcm",
      }),
    ).toBe(true);
  });

  test("stopAll closes every live session", async () => {
    const session = makeFakeSession();
    const { bridge } = makeBridge(session);
    bridge.handleMessage({ type: "stt.open", requestId: 1 });
    await settle();
    expect(bridge.sessionCount()).toBe(1);
    bridge.stopAll();
    expect(session.stopped).toBe(1);
    expect(bridge.sessionCount()).toBe(0);
  });
});
