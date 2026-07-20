/**
 * Tests for botStatusCode, the helper the join script uses to read a coarse
 * status from a Recall bot payload across API-shape variants when polling to
 * confirm a bot actually joined.
 */

import { describe, expect, test } from "bun:test";

import {
  botStatusCode,
  type RecallBot,
} from "../../skills/meeting-bot/scripts/meeting-bot-client.ts";

describe("botStatusCode", () => {
  test("reads a top-level status_code", () => {
    expect(botStatusCode({ id: "b", status_code: "in_call_recording" })).toBe(
      "in_call_recording",
    );
  });

  test("reads the latest entry of a status_changes array", () => {
    const bot = {
      id: "b",
      status_changes: [{ code: "joining_call" }, { code: "in_call_recording" }],
    } as unknown as RecallBot;
    expect(botStatusCode(bot)).toBe("in_call_recording");
  });

  test("reads a nested status.code object", () => {
    const bot = { id: "b", status: { code: "in_waiting_room" } } as unknown as RecallBot;
    expect(botStatusCode(bot)).toBe("in_waiting_room");
  });

  test("returns null when no status is present", () => {
    expect(botStatusCode({ id: "b" })).toBeNull();
  });

  test("prefers a non-empty top-level status_code over status_changes", () => {
    const bot = {
      id: "b",
      status_code: "fatal",
      status_changes: [{ code: "joining_call" }],
    } as unknown as RecallBot;
    expect(botStatusCode(bot)).toBe("fatal");
  });
});
