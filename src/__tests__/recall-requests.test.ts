/**
 * Tests for the shared Recall request builders used by both the daemon-side
 * join flow and the skill scripts' client.
 */

import { describe, expect, test } from "bun:test";

import {
  buildCreateBotBody,
  REALTIME_EVENTS,
  recallAuthHeaders,
} from "../recall-requests.ts";

describe("buildCreateBotBody", () => {
  test("wires the realtime endpoint with the full event set", () => {
    const body = buildCreateBotBody({
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      endpointUrl: "wss://tunnel.example/",
    });
    expect(body.meeting_url).toBe("https://meet.google.com/abc-defg-hij");
    const recording = body.recording_config as {
      realtime_endpoints: Array<{ type: string; url: string; events: unknown }>;
      transcript?: unknown;
    };
    expect(recording.realtime_endpoints).toHaveLength(1);
    expect(recording.realtime_endpoints[0]).toEqual({
      type: "websocket",
      url: "wss://tunnel.example/",
      events: REALTIME_EVENTS,
    });
    // No transcript block unless the streaming provider is configured.
    expect(recording.transcript).toBeUndefined();
    // The silent MP3 unlock is always attached.
    expect(body.automatic_audio_output).toBeDefined();
    // No bot name unless one was passed.
    expect(body.bot_name).toBeUndefined();
  });

  test("attaches the transcript block only for recallai_streaming", () => {
    const withStreaming = buildCreateBotBody({
      meetingUrl: "https://x",
      endpointUrl: "wss://y/",
      transcript: { provider: "recallai_streaming", languageCode: "en", mode: "prioritize_low_latency" },
    });
    expect(
      (withStreaming.recording_config as { transcript?: unknown }).transcript,
    ).toEqual({
      provider: {
        recallai_streaming: { mode: "prioritize_low_latency", language_code: "en" },
      },
    });

    const withOther = buildCreateBotBody({
      meetingUrl: "https://x",
      endpointUrl: "wss://y/",
      transcript: { provider: "none", languageCode: "en", mode: "m" },
    });
    expect(
      (withOther.recording_config as { transcript?: unknown }).transcript,
    ).toBeUndefined();
  });

  test("passes the bot name through when provided", () => {
    const body = buildCreateBotBody({
      meetingUrl: "https://x",
      endpointUrl: "wss://y/",
      botName: "Ada",
    });
    expect(body.bot_name).toBe("Ada");
  });
});

describe("recallAuthHeaders", () => {
  test("carries the API key as the Authorization header", () => {
    expect(recallAuthHeaders("k-123")).toEqual({
      Authorization: "k-123",
      Accept: "application/json",
      "Content-Type": "application/json",
    });
  });
});
