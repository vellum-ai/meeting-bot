/**
 * Tests for reading meeting history from sessions.json.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readMeetingHistory } from "../meeting-history.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "meeting-bot-history-"));
}

function writeSessions(dir: string, value: unknown): void {
  writeFileSync(join(dir, "sessions.json"), JSON.stringify(value), "utf-8");
}

describe("readMeetingHistory", () => {
  test("returns an empty array when the file is missing", () => {
    expect(readMeetingHistory(tmp())).toEqual([]);
  });

  test("returns an empty array when the file is malformed", () => {
    const dir = tmp();
    writeFileSync(join(dir, "sessions.json"), "not json", "utf-8");
    expect(readMeetingHistory(dir)).toEqual([]);
  });

  test("maps entries and sorts newest first", () => {
    const dir = tmp();
    writeSessions(dir, [
      { botId: "old", meetingUrl: "u1", conversationId: "c1", startedAt: 100 },
      { botId: "new", meetingUrl: "u2", conversationId: null, startedAt: 300 },
      { botId: "mid", meetingUrl: "u3", conversationId: "c3", startedAt: 200 },
    ]);
    expect(readMeetingHistory(dir).map((m) => m.botId)).toEqual([
      "new",
      "mid",
      "old",
    ]);
  });

  test("tolerates missing optional fields", () => {
    const dir = tmp();
    writeSessions(dir, [{ botId: "b" }]);
    expect(readMeetingHistory(dir)).toEqual([
      { botId: "b", meetingUrl: "", conversationId: null, startedAt: 0 },
    ]);
  });

  test("skips entries without a botId", () => {
    const dir = tmp();
    writeSessions(dir, [{ meetingUrl: "u" }, { botId: "keep", startedAt: 5 }]);
    expect(readMeetingHistory(dir).map((m) => m.botId)).toEqual(["keep"]);
  });

  test("returns an empty array when the JSON is not an array", () => {
    const dir = tmp();
    writeSessions(dir, { botId: "x" });
    expect(readMeetingHistory(dir)).toEqual([]);
  });
});
