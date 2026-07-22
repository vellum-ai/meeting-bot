/**
 * Tests for the merged meeting history: durable history.json entries with
 * join statuses plus active sessions.json entries.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readMeetingHistory, upsertHistoryEntry } from "../meeting-history.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "meeting-bot-history-"));
}

function writeSessions(dir: string, value: unknown): void {
  writeFileSync(join(dir, "sessions.json"), JSON.stringify(value), "utf-8");
}

describe("readMeetingHistory", () => {
  test("returns an empty array when both files are missing", () => {
    expect(readMeetingHistory(tmp())).toEqual([]);
  });

  test("returns an empty array when the sessions file is malformed", () => {
    const dir = tmp();
    writeFileSync(join(dir, "sessions.json"), "not json", "utf-8");
    expect(readMeetingHistory(dir)).toEqual([]);
  });

  test("maps sessions.json entries as active and sorts newest first", () => {
    const dir = tmp();
    writeSessions(dir, [
      { botId: "old", meetingUrl: "u1", conversationId: "c1", startedAt: 100 },
      { botId: "new", meetingUrl: "u2", conversationId: null, startedAt: 300 },
      { botId: "mid", meetingUrl: "u3", conversationId: "c3", startedAt: 200 },
    ]);
    const history = readMeetingHistory(dir);
    expect(history.map((m) => m.botId)).toEqual(["new", "mid", "old"]);
    expect(history.every((m) => m.status === "active")).toBe(true);
  });

  test("tolerates missing optional fields", () => {
    const dir = tmp();
    writeSessions(dir, [{ botId: "b" }]);
    expect(readMeetingHistory(dir)).toEqual([
      {
        botId: "b",
        meetingUrl: "",
        conversationId: null,
        startedAt: 0,
        status: "active",
      },
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

  test("history.json entries win over the sessions.json copy of the same bot", () => {
    const dir = tmp();
    upsertHistoryEntry(dir, {
      botId: "m1",
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      provider: "vellum",
      status: "joined",
      startedAt: 50,
    });
    writeSessions(dir, [
      { botId: "m1", meetingUrl: "stale", startedAt: 50 },
      { botId: "recall-1", meetingUrl: "u", startedAt: 40 },
    ]);
    const history = readMeetingHistory(dir);
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ botId: "m1", status: "joined" });
    expect(history[1]).toMatchObject({ botId: "recall-1", status: "active" });
  });
});

describe("upsertHistoryEntry", () => {
  test("records a join attempt and advances it through the lifecycle", () => {
    const dir = tmp();
    upsertHistoryEntry(dir, {
      botId: "m1",
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      provider: "vellum",
      status: "joining",
      startedAt: 100,
    });

    let [entry] = readMeetingHistory(dir);
    expect(entry).toMatchObject({ botId: "m1", status: "joining" });

    // Session-opened enrichment adds the conversation id without touching
    // the status.
    upsertHistoryEntry(dir, { botId: "m1", conversationId: "c9" });
    [entry] = readMeetingHistory(dir);
    expect(entry).toMatchObject({ status: "joining", conversationId: "c9" });

    upsertHistoryEntry(dir, { botId: "m1", status: "joined" });
    [entry] = readMeetingHistory(dir);
    expect(entry).toMatchObject({
      status: "joined",
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      conversationId: "c9",
    });
  });

  test("failed attempts keep their detail", () => {
    const dir = tmp();
    upsertHistoryEntry(dir, {
      botId: "m2",
      meetingUrl: "u",
      provider: "vellum",
      status: "joining",
    });
    upsertHistoryEntry(dir, {
      botId: "m2",
      status: "failed",
      detail: "bot did not connect",
    });
    const [entry] = readMeetingHistory(dir);
    expect(entry).toMatchObject({
      botId: "m2",
      status: "failed",
      detail: "bot did not connect",
    });
  });

  test("failed and left entries survive alongside new attempts", () => {
    const dir = tmp();
    upsertHistoryEntry(dir, { botId: "a", status: "failed", startedAt: 1, detail: "x" });
    upsertHistoryEntry(dir, { botId: "b", status: "left", startedAt: 2 });
    upsertHistoryEntry(dir, { botId: "c", status: "joining", startedAt: 3 });
    expect(readMeetingHistory(dir).map((e) => e.botId)).toEqual(["c", "b", "a"]);
  });
});
