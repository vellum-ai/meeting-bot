/**
 * Tests for Chrome user-data-dir selection.
 *
 * The existence probe is injected so both branches (free vs in-use
 * persistent profile) are exercised without touching the filesystem.
 */

import { describe, expect, test } from "bun:test";

import { resolveProfileDir } from "../browser/profile-dir.js";

const ROOT = "/tmp/chrome-profile";
const MEETING = "m-1";

describe("resolveProfileDir", () => {
  test("uses the persistent profile when it is free", () => {
    const resolved = resolveProfileDir({
      root: ROOT,
      meetingId: MEETING,
      persist: true,
      exists: () => false,
    });
    expect(resolved.kind).toBe("persistent");
    expect(resolved.dir).toBe("/tmp/chrome-profile/persistent");
  });

  test("falls back to a per-meeting profile when the lock is present", () => {
    const resolved = resolveProfileDir({
      root: ROOT,
      meetingId: MEETING,
      persist: true,
      exists: (p) => p.endsWith("SingletonLock"),
    });
    expect(resolved.kind).toBe("per-meeting");
    expect(resolved.dir).toBe("/tmp/chrome-profile-m-1");
    expect(resolved.reason).toContain("in use");
  });

  test("honours the persistence opt-out", () => {
    const resolved = resolveProfileDir({
      root: ROOT,
      meetingId: MEETING,
      persist: false,
      exists: () => false,
    });
    expect(resolved.kind).toBe("per-meeting");
    expect(resolved.dir).toBe("/tmp/chrome-profile-m-1");
    expect(resolved.reason).toContain("CHROME_PROFILE_PERSIST=0");
  });

  test("per-meeting fallback keeps sessions isolated from each other", () => {
    const a = resolveProfileDir({
      root: ROOT,
      meetingId: "m-a",
      persist: true,
      exists: (p) => p.endsWith("SingletonLock"),
    });
    const b = resolveProfileDir({
      root: ROOT,
      meetingId: "m-b",
      persist: true,
      exists: (p) => p.endsWith("SingletonLock"),
    });
    expect(a.dir).not.toBe(b.dir);
  });
});
