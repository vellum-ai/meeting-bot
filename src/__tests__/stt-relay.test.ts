/**
 * Tests for the worker-side transcription relay proxy.
 *
 * Exercises the open round trip (success, daemon error), audio encoding,
 * event dispatch including the pre-start buffer, and stop/finalize wiring.
 */

import { describe, expect, test } from "bun:test";

import { createWorkerSttRelay } from "../vellum/stt-relay.ts";
import type { SttStreamServerEvent } from "../vellum/stt-types.ts";

function makeRelay() {
  const sent: Array<Record<string, unknown>> = [];
  const logs: string[] = [];
  const relay = createWorkerSttRelay(
    (msg) => sent.push(msg),
    (msg) => logs.push(msg),
  );
  return { relay, sent, logs };
}

describe("createWorkerSttRelay", () => {
  test("ignores non-stt messages", () => {
    const { relay } = makeRelay();
    expect(relay.handleMessage({ type: "stop" })).toBe(false);
  });

  test("open resolves null on a daemon error reply and logs it", async () => {
    const { relay, sent, logs } = makeRelay();
    const opening = relay.open();
    const requestId = sent[0]!.requestId as number;
    expect(sent[0]).toMatchObject({ type: "stt.open" });

    relay.handleMessage({
      type: "stt.opened",
      requestId,
      error: "no provider configured",
    });
    expect(await opening).toBeNull();
    expect(logs[0]).toContain("no provider configured");
  });

  test("open resolves a proxy that relays audio, finalize, and stop", async () => {
    const { relay, sent } = makeRelay();
    const opening = relay.open();
    const requestId = sent[0]!.requestId as number;
    relay.handleMessage({ type: "stt.opened", requestId, sessionId: 5 });
    const proxy = await opening;
    expect(proxy).not.toBeNull();

    const events: SttStreamServerEvent[] = [];
    await proxy!.start((event) => events.push(event));

    const chunk = Buffer.from("audio-bytes");
    proxy!.sendAudio(chunk, "audio/pcm");
    expect(sent.at(-1)).toMatchObject({
      type: "stt.audio",
      sessionId: 5,
      chunk: chunk.toString("base64"),
      mimeType: "audio/pcm",
    });

    relay.handleMessage({
      type: "stt.event",
      sessionId: 5,
      event: { type: "partial", text: "hel" },
    });
    expect(events).toEqual([{ type: "partial", text: "hel" }]);

    proxy!.finalizeUtterance!();
    expect(sent.at(-1)).toMatchObject({ type: "stt.finalize", sessionId: 5 });

    proxy!.stop();
    expect(sent.at(-1)).toMatchObject({ type: "stt.stop", sessionId: 5 });

    // After stop, events for the session are dropped silently.
    relay.handleMessage({
      type: "stt.event",
      sessionId: 5,
      event: { type: "closed" },
    });
    expect(events).toHaveLength(1);
  });

  test("buffers events that arrive before start and flushes them in order", async () => {
    const { relay, sent } = makeRelay();
    const opening = relay.open();
    const requestId = sent[0]!.requestId as number;
    relay.handleMessage({ type: "stt.opened", requestId, sessionId: 2 });
    const proxy = await opening;

    relay.handleMessage({
      type: "stt.event",
      sessionId: 2,
      event: { type: "partial", text: "early" },
    });
    relay.handleMessage({
      type: "stt.event",
      sessionId: 2,
      event: { type: "final", text: "early final" },
    });

    const events: SttStreamServerEvent[] = [];
    await proxy!.start((event) => events.push(event));
    expect(events).toEqual([
      { type: "partial", text: "early" },
      { type: "final", text: "early final" },
    ]);
  });

  test("concurrent opens pair replies by requestId", async () => {
    const { relay, sent } = makeRelay();
    const first = relay.open();
    const second = relay.open();
    const firstId = sent[0]!.requestId as number;
    const secondId = sent[1]!.requestId as number;
    expect(firstId).not.toBe(secondId);

    // Answer out of order.
    relay.handleMessage({ type: "stt.opened", requestId: secondId, sessionId: 11 });
    relay.handleMessage({ type: "stt.opened", requestId: firstId, error: "nope" });

    expect(await first).toBeNull();
    expect(await second).not.toBeNull();
  });
});
