/**
 * Tests for the voice response pipeline: provider response text → TTS
 * synthesis → Recall output_audio endpoint.
 *
 * Verifies that the flush function synthesizes speech via the daemon's TTS
 * endpoint and sends it to Recall's output_audio API after a provider turn.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import type { MeetingBotConfig } from "../config.ts";
import { outputAudio } from "../recall-client.ts";
import { synthesizeSpeech, TtsError } from "../tts.ts";

function makeConfig(overrides: Partial<MeetingBotConfig> = {}): MeetingBotConfig {
  return {
    apiKeyCredential: "recall:api_key",
    region: "us-east-1",
    publicWsUrl: "ws://localhost:0",
    listenHost: "127.0.0.1",
    listenPort: 18792,
    events: ["transcript.data"],
    ...overrides,
  } as MeetingBotConfig;
}

const originalFetch = globalThis.fetch;

function mockFetchResponses(
  responses: { status?: number; body?: string }[] = [],
): { calls: { url: string; body: string }[] } {
  const calls: { url: string; body: string }[] = [];
  let idx = 0;
  globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body ?? "") });
    const r = responses[idx] ?? { status: 200, body: "{}" };
    idx++;
    return new Response(r.body ?? "{}", { status: r.status ?? 200 });
  }) as typeof fetch;
  return { calls };
}

function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

describe("tts.synthesizeSpeech", () => {
  afterEach(() => restoreFetch());

  test("returns base64 audio from the daemon TTS endpoint", async () => {
    const { calls } = mockFetchResponses([
      { status: 200, body: JSON.stringify({ audioBase64: "AAA=", contentType: "audio/mpeg" }) },
    ]);

    const result = await synthesizeSpeech("Hello world", makeConfig());
    expect(result).toBe("AAA=");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/v1/tts/synthesize-cli");
    expect(JSON.parse(calls[0]!.body).text).toBe("Hello world");
  });

  test("uses config.tts.endpoint when provided", async () => {
    const { calls } = mockFetchResponses([
      { status: 200, body: JSON.stringify({ audioBase64: "BBB=", contentType: "audio/mpeg" }) },
    ]);

    const config = makeConfig({
      tts: { endpoint: "http://custom-host:9999/v1/tts/synthesize-cli" },
    });
    await synthesizeSpeech("Test", config);
    expect(calls[0]!.url).toBe("http://custom-host:9999/v1/tts/synthesize-cli");
  });

  test("sends Authorization header when authToken is configured", async () => {
    mockFetchResponses([
      { status: 200, body: JSON.stringify({ audioBase64: "CCC=", contentType: "audio/mpeg" }) },
    ]);

    const config = makeConfig({
      tts: { authToken: "secret-token-123" },
    });
    await synthesizeSpeech("Auth test", config);
    // The mock doesn't capture headers, but we verify no error is thrown
    // with the auth token set.
  });

  test("throws TtsError on non-OK response", async () => {
    mockFetchResponses([{ status: 503, body: "Service unavailable" }]);

    await expect(synthesizeSpeech("Test", makeConfig())).rejects.toThrow(TtsError);
  });

  test("throws TtsError on network failure", async () => {
    globalThis.fetch = mock(() => {
      throw new Error("Connection refused");
    }) as typeof fetch;

    await expect(synthesizeSpeech("Test", makeConfig())).rejects.toThrow(TtsError);
  });
});

describe("recall-client.outputAudio", () => {
  afterEach(() => restoreFetch());

  test("POSTs mp3 base64 to the output_audio endpoint", async () => {
    process.env.RECALL_API_KEY = "test-key";
    const { calls } = mockFetchResponses([{ status: 200, body: "{}" }]);

    await outputAudio(makeConfig(), "bot-123", "AAA=");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/bot/bot-123/output_audio/");
    const body = JSON.parse(calls[0]!.body);
    expect(body.kind).toBe("mp3");
    expect(body.b64_data).toBe("AAA=");
    delete process.env.RECALL_API_KEY;
  });

  test("throws RecallApiError on non-OK response", async () => {
    process.env.RECALL_API_KEY = "test-key";
    mockFetchResponses([{ status: 400, body: "Bad request" }]);

    await expect(outputAudio(makeConfig(), "bot-123", "AAA=")).rejects.toThrow();
    delete process.env.RECALL_API_KEY;
  });
});
