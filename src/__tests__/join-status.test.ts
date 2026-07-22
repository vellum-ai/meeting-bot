/**
 * Tests for the worker's join-status tracker: state transitions from the
 * join flow and from meet.* hub messages.
 */

import { describe, expect, test } from "bun:test";

import { createJoinStatusTracker } from "../vellum/join-status.ts";

describe("createJoinStatusTracker", () => {
  test("unknown meetings resolve to null", () => {
    expect(createJoinStatusTracker().get("nope")).toBeNull();
  });

  test("tracks the attempt set by the join flow", () => {
    const tracker = createJoinStatusTracker();
    tracker.set("m1", "joining");
    expect(tracker.get("m1")).toMatchObject({ meetingId: "m1", state: "joining" });
  });

  test("meet.joined advances the state", () => {
    const tracker = createJoinStatusTracker();
    tracker.set("m1", "joining");
    tracker.applyHubMessage({ type: "meet.joined", meetingId: "m1" });
    expect(tracker.get("m1")).toMatchObject({ state: "joined" });
  });

  test("meet.error records failure with detail", () => {
    const tracker = createJoinStatusTracker();
    tracker.set("m1", "joining");
    tracker.applyHubMessage({
      type: "meet.error",
      meetingId: "m1",
      detail: "container spawn failed",
    });
    expect(tracker.get("m1")).toMatchObject({
      state: "failed",
      detail: "container spawn failed",
    });
  });

  test("meet.left records the leave with its reason", () => {
    const tracker = createJoinStatusTracker();
    tracker.set("m1", "joined");
    tracker.applyHubMessage({
      type: "meet.left",
      meetingId: "m1",
      reason: "user_request",
    });
    expect(tracker.get("m1")).toMatchObject({ state: "left", detail: "user_request" });
  });

  test("ignores non-meet messages and missing meeting ids", () => {
    const tracker = createJoinStatusTracker();
    tracker.set("m1", "joining");
    tracker.applyHubMessage({ type: "meet.transcript_chunk", meetingId: "m1" });
    tracker.applyHubMessage({ type: "meet.joined" });
    expect(tracker.get("m1")).toMatchObject({ state: "joining" });
  });

  test("evicts the oldest entries beyond the cap", () => {
    const tracker = createJoinStatusTracker();
    for (let i = 0; i < 105; i++) tracker.set(`m${i}`, "joining");
    expect(tracker.get("m0")).toBeNull();
    expect(tracker.get("m104")).not.toBeNull();
  });
});
