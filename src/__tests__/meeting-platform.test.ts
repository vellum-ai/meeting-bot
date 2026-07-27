/**
 * Tests for join-URL platform detection and the vellum-provider refusal
 * messages.
 */

import { describe, expect, test } from "bun:test";

import {
  detectMeetingPlatform,
  meetingPlatformLabel,
  vellumJoinRejection,
  vellumSupportsPlatform,
} from "../meeting-platform.ts";

describe("detectMeetingPlatform", () => {
  test("recognizes Google Meet links", () => {
    expect(detectMeetingPlatform("https://meet.google.com/abc-defg-hij")).toBe(
      "meet",
    );
    expect(
      detectMeetingPlatform("https://meet.google.com/abc-defg-hij?authuser=0"),
    ).toBe("meet");
  });

  test("recognizes Zoom links across subdomain and path forms", () => {
    for (const url of [
      "https://zoom.us/j/1234567890",
      "https://us02web.zoom.us/j/1234567890?pwd=Abc123",
      "https://acme.zoom.us/w/9876543210",
      "https://zoom.us/my/jane.doe",
      "https://zoom.com/j/1234567890",
    ]) {
      expect(detectMeetingPlatform(url)).toBe("zoom");
    }
  });

  test("recognizes Teams links in both enterprise and consumer forms", () => {
    expect(
      detectMeetingPlatform(
        "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0",
      ),
    ).toBe("teams");
    expect(detectMeetingPlatform("https://teams.live.com/meet/9876543210")).toBe(
      "teams",
    );
  });

  test("rejects non-meeting and insecure URLs", () => {
    for (const url of [
      "http://meet.google.com/abc-defg-hij",
      "https://example.com/j/123",
      "https://zoom.us/pricing",
      "not a url",
      "",
    ]) {
      expect(detectMeetingPlatform(url)).toBeNull();
    }
  });

  test("tolerates surrounding whitespace", () => {
    expect(
      detectMeetingPlatform("  https://meet.google.com/abc-defg-hij  "),
    ).toBe("meet");
  });
});

describe("vellumSupportsPlatform", () => {
  test("supports Meet only today", () => {
    expect(vellumSupportsPlatform("meet")).toBe(true);
    expect(vellumSupportsPlatform("zoom")).toBe(false);
    expect(vellumSupportsPlatform("teams")).toBe(false);
  });
});

describe("vellumJoinRejection", () => {
  test("accepts a Meet URL", () => {
    expect(vellumJoinRejection("https://meet.google.com/abc-defg-hij")).toBeNull();
  });

  test("points Zoom and Teams URLs at the recall provider", () => {
    const zoom = vellumJoinRejection("https://zoom.us/j/1234567890");
    expect(zoom).toContain("Zoom");
    expect(zoom).toContain("recall");

    const teams = vellumJoinRejection("https://teams.live.com/meet/123");
    expect(teams).toContain("Microsoft Teams");
    expect(teams).toContain("recall");
  });

  test("reports an unrecognized URL as not a meeting link", () => {
    const msg = vellumJoinRejection("https://example.com/hello");
    expect(msg).toContain("supported platform");
    // Must not misattribute an unknown URL to a provider gap.
    expect(msg).not.toContain("recall");
  });
});

describe("meetingPlatformLabel", () => {
  test("labels every platform", () => {
    expect(meetingPlatformLabel("meet")).toBe("Google Meet");
    expect(meetingPlatformLabel("zoom")).toBe("Zoom");
    expect(meetingPlatformLabel("teams")).toBe("Microsoft Teams");
  });
});
