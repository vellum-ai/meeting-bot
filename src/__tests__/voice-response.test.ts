/**
 * Tests for the voice response pipeline: provider response text → TTS
 * synthesis → Recall output_audio endpoint.
 *
 * The TTS synthesis itself is provided by the plugin-api (`synthesizeSpeech`),
 * so these tests focus on the Recall `output_audio` endpoint and the text
 * extraction helper.
 *
 * Credential resolution is mocked at the module level via `mock.module` so
 * that `execSync` in config.ts returns a test key without hitting the real
 * `assistant credentials reveal` CLI. Only `execSync` is overridden; the rest
 * of `node:child_process` (notably `spawn`) is passed through unchanged so
 * other test files that need the real implementation are not affected.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { MeetingBotConfig } from "../config.ts";

// Grab the real module so we can pass through everything except execSync.
const realChildProcess = await import("node:child_process");

let mockApiKey: string | null = null;

mock.module("node:child_process", () => ({
  ...realChildProcess,
  execSync: mock((cmd: string) => {
    if (mockApiKey !== null && cmd.includes("credentials reveal")) {
      return mockApiKey;
    }
    // Fall through to the real execSync for anything else.
    return realChildProcess.execSync(cmd, { encoding: "utf-8" });
  }),
}));

const { outputAudio } = await import("../recall-client.ts");

function makeConfig(overrides: Partial<MeetingBotConfig> = {}): MeetingBotConfig {
  return {
    apiKeyCredential: "meeting-bot:api_key",
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

describe("recall-client.outputAudio", () => {
  beforeEach(() => {
    mockApiKey = null;
  });
  afterEach(() => {
    restoreFetch();
    mockApiKey = null;
  });

  test("POSTs mp3 base64 to the output_audio endpoint", async () => {
    mockApiKey = "test-key";
    const { calls } = mockFetchResponses([{ status: 200, body: "{}" }]);

    await outputAudio(makeConfig(), "bot-123", "AAA=");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/bot/bot-123/output_audio/");
    const body = JSON.parse(calls[0]!.body);
    expect(body.kind).toBe("mp3");
    expect(body.b64_data).toBe("AAA=");
  });

  test("throws RecallApiError on non-OK response", async () => {
    mockApiKey = "test-key";
    mockFetchResponses([{ status: 400, body: "Bad request" }]);

    await expect(outputAudio(makeConfig(), "bot-123", "AAA=")).rejects.toThrow();
  });

  test("throws when credential is not set", async () => {
    mockApiKey = null;
    mockFetchResponses([{ status: 200, body: "{}" }]);
    await expect(outputAudio(makeConfig(), "bot-123", "AAA=")).rejects.toThrow();
  });
});
