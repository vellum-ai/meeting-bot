/**
 * Tests for the behavior config flags.
 *
 * Both are currently defined but not yet consumed:
 *   - `useVoiceMode` will select the host's createLiveVoiceConnection API for
 *     voice responses once that API is available.
 *   - `outputAudio` will gate whether the bot speaks in the meeting at all.
 */

import { describe, expect, test } from "bun:test";

import { MeetingBotConfigSchema } from "../config.ts";

describe("config flags", () => {
  test("useVoiceMode and outputAudio default to false", () => {
    const c = MeetingBotConfigSchema.parse({});
    expect(c.useVoiceMode).toBe(false);
    expect(c.outputAudio).toBe(false);
  });

  test("honors provided flag values", () => {
    const c = MeetingBotConfigSchema.parse({
      useVoiceMode: true,
      outputAudio: true,
    });
    expect(c.useVoiceMode).toBe(true);
    expect(c.outputAudio).toBe(true);
  });
});
