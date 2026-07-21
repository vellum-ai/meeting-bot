/**
 * Tests for the vellum provider's event adapter: meet-bot events piped into
 * meeting-bot's session store, and the control handlers' guard behavior when
 * the runtime is not initialized.
 */

import { afterEach, describe, expect, test } from "bun:test";

import type { MeetBotEvent } from "../../meet/contracts/index.ts";
import { clearTranscriptBuffer } from "../realtime-server.ts";
import {
  closeSession,
  getSession,
  openSession,
} from "../session-store.ts";
import {
  handleVellumJoin,
  handleVellumLeave,
  handleVellumMeetEvent,
  MEET_URL_REGEX,
} from "../vellum-meet.ts";
import { MeetingBotConfigSchema, type MeetingBotConfig } from "../config.ts";

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

const MEETING_ID = "vellum-meeting-1";

function makeConfig(): MeetingBotConfig {
  return MeetingBotConfigSchema.parse({ provider: "vellum" });
}

function opts() {
  return { logger: noopLogger, config: makeConfig() };
}

function transcriptEvent(overrides: Partial<Extract<MeetBotEvent, { type: "transcript.chunk" }>> = {}): MeetBotEvent {
  return {
    type: "transcript.chunk",
    meetingId: MEETING_ID,
    timestamp: new Date(0).toISOString(),
    isFinal: true,
    text: "hello from the meeting",
    speakerLabel: "Ada",
    speakerId: "spk-1",
    ...overrides,
  };
}

describe("handleVellumMeetEvent", () => {
  afterEach(() => {
    clearTranscriptBuffer(MEETING_ID);
    closeSession(MEETING_ID);
  });

  test("final transcript chunks land in the session transcript", () => {
    // conversationId null keeps the debounced flush inert in tests.
    openSession(MEETING_ID, "https://meet.google.com/abc-defg-hij", null, "vellum");

    handleVellumMeetEvent(MEETING_ID, transcriptEvent(), opts());

    const session = getSession(MEETING_ID);
    expect(session!.transcript).toHaveLength(1);
    expect(session!.transcript[0]!.text).toBe("hello from the meeting");
    expect(session!.transcript[0]!.speaker).toBe("Ada");
  });

  test("interim transcript chunks are not recorded", () => {
    openSession(MEETING_ID, "https://meet.google.com/abc-defg-hij", null, "vellum");

    handleVellumMeetEvent(
      MEETING_ID,
      transcriptEvent({ isFinal: false, text: "partial..." }),
      opts(),
    );

    expect(getSession(MEETING_ID)!.transcript).toHaveLength(0);
  });

  test("participant changes update the roster", () => {
    openSession(MEETING_ID, "https://meet.google.com/abc-defg-hij", null, "vellum");

    handleVellumMeetEvent(
      MEETING_ID,
      {
        type: "participant.change",
        meetingId: MEETING_ID,
        timestamp: new Date(0).toISOString(),
        joined: [
          { id: "p1", name: "Ada" },
          { id: "p2", name: "Grace" },
        ],
        left: [],
      },
      opts(),
    );
    expect(getSession(MEETING_ID)!.participants.size).toBe(2);

    handleVellumMeetEvent(
      MEETING_ID,
      {
        type: "participant.change",
        meetingId: MEETING_ID,
        timestamp: new Date(0).toISOString(),
        joined: [],
        left: [{ id: "p1", name: "Ada" }],
      },
      opts(),
    );
    const participants = getSession(MEETING_ID)!.participants;
    expect(participants.size).toBe(1);
    expect(participants.get("p2")).toBe("Grace");
  });

  test("a terminal lifecycle state closes the session", () => {
    openSession(MEETING_ID, "https://meet.google.com/abc-defg-hij", null, "vellum");

    handleVellumMeetEvent(
      MEETING_ID,
      {
        type: "lifecycle",
        meetingId: MEETING_ID,
        timestamp: new Date(0).toISOString(),
        state: "left",
      },
      opts(),
    );

    // The in-memory session is gone (getSession may re-sync from a sessions
    // file; none exists in the test environment).
    expect(getSession(MEETING_ID)).toBeUndefined();
  });

  test("speaker.change and chat.inbound are ignored", () => {
    openSession(MEETING_ID, "https://meet.google.com/abc-defg-hij", null, "vellum");

    handleVellumMeetEvent(
      MEETING_ID,
      {
        type: "speaker.change",
        meetingId: MEETING_ID,
        timestamp: new Date(0).toISOString(),
        speakerId: "spk-1",
        speakerName: "Ada",
      },
      opts(),
    );
    handleVellumMeetEvent(
      MEETING_ID,
      {
        type: "chat.inbound",
        meetingId: MEETING_ID,
        timestamp: new Date(0).toISOString(),
        fromId: "p1",
        fromName: "Ada",
        text: "hi",
      },
      opts(),
    );

    const session = getSession(MEETING_ID)!;
    expect(session.transcript).toHaveLength(0);
    expect(session.participants.size).toBe(0);
  });
});

describe("control handlers without a runtime", () => {
  test("join returns 503 when the vellum runtime is not initialized", async () => {
    const res = await handleVellumJoin(
      new Request("http://x/control/join", {
        method: "POST",
        body: JSON.stringify({ meetingUrl: "https://meet.google.com/abc-defg-hij" }),
      }),
    );
    expect(res.status).toBe(503);
  });

  test("leave returns 503 when the vellum runtime is not initialized", async () => {
    const res = await handleVellumLeave(
      new Request("http://x/control/leave", {
        method: "POST",
        body: JSON.stringify({ meetingId: "m1" }),
      }),
    );
    expect(res.status).toBe(503);
  });
});

describe("MEET_URL_REGEX", () => {
  test("accepts canonical Meet URLs and rejects others", () => {
    expect(MEET_URL_REGEX.test("https://meet.google.com/abc-defg-hij")).toBe(true);
    expect(MEET_URL_REGEX.test("https://meet.google.com/abc-defg-hij?authuser=0")).toBe(true);
    expect(MEET_URL_REGEX.test("https://zoom.us/j/123")).toBe(false);
    expect(MEET_URL_REGEX.test("http://meet.google.com/abc-defg-hij")).toBe(false);
  });
});
