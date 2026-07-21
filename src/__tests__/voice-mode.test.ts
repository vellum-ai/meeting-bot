/**
 * Tests for the voice-mode gate and the config flags that drive it.
 */

import { describe, expect, test } from "bun:test";

import { MeetingBotConfigSchema, type MeetingBotConfig } from "../config.ts";
import { shouldSpeakResponses } from "../realtime-server.ts";

function cfg(overrides: Partial<MeetingBotConfig> = {}): MeetingBotConfig {
  return MeetingBotConfigSchema.parse({ publicWsUrl: "wss://x", ...overrides });
}

describe("config flags", () => {
  test("useVoiceMode and listenOnly default to false", () => {
    const c = MeetingBotConfigSchema.parse({});
    expect(c.useVoiceMode).toBe(false);
    expect(c.listenOnly).toBe(false);
  });

  test("honors provided flag values", () => {
    const c = MeetingBotConfigSchema.parse({ useVoiceMode: true, listenOnly: true });
    expect(c.useVoiceMode).toBe(true);
    expect(c.listenOnly).toBe(true);
  });
});

describe("shouldSpeakResponses", () => {
  test("true only when useVoiceMode is set", () => {
    expect(shouldSpeakResponses(cfg({ useVoiceMode: true }))).toBe(true);
    expect(shouldSpeakResponses(cfg({ useVoiceMode: false }))).toBe(false);
    // Defaults to off.
    expect(shouldSpeakResponses(cfg())).toBe(false);
  });
});
