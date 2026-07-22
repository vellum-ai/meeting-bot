/**
 * Tests for the feature-detected plugin-api STT shim.
 *
 * The installed @vellumai/plugin-api (0.10.10) predates the
 * openTranscriptionSession export (vellum-assistant PR #38722, shipping in
 * 0.10.12), so the shim must report the capability missing and degrade to
 * null instead of throwing. On a 0.10.12+ host the same calls pass through
 * to the real API; this suite pins the degradation contract that CI and
 * local dev rely on until then.
 */

import { describe, expect, test } from "bun:test";

import { hostSupportsTranscription, openTranscriptionSession } from "../vellum/stt-api.ts";

describe("stt-api feature detection", () => {
  test("reports no transcription support on a pre-0.10.12 package", () => {
    expect(hostSupportsTranscription()).toBe(false);
  });

  test("openTranscriptionSession degrades to null instead of throwing", async () => {
    expect(await openTranscriptionSession()).toBeNull();
  });
});
