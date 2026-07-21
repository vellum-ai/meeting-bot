/**
 * Tests for the route handlers backing routes/*.ts.
 *
 * The handlers resolve the plugin's own config.json / data dir internally, so
 * these tests exercise the request-shaping and validation behavior (status
 * codes, content types, 400s) rather than value-precise persistence, which is
 * covered against temp files in app-settings.test.ts and meeting-history.test.ts.
 * The PATCH error paths return before any write, so they never touch real
 * config.json.
 */

import { describe, expect, test } from "bun:test";

import {
  handleMeetingsGet,
  handleSettingsGet,
  handleSettingsPatch,
} from "../app-routes.ts";

function patch(body: string): Request {
  return new Request("http://x/x/plugins/meeting-bot/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body,
  });
}

describe("handleMeetingsGet", () => {
  test("returns a JSON array", async () => {
    const res = handleMeetingsGet();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(Array.isArray(await res.json())).toBe(true);
  });
});

describe("handleSettingsGet", () => {
  test("returns JSON with the settings shape", async () => {
    const res = handleSettingsGet();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { useVoiceMode: unknown; provider: unknown };
    expect(typeof body.useVoiceMode).toBe("boolean");
    expect(["recall", "vellum"]).toContain(body.provider);
  });
});

describe("handleSettingsPatch validation", () => {
  test("rejects an invalid provider with 400", async () => {
    const res = await handleSettingsPatch(patch(JSON.stringify({ provider: "zoom" })));
    expect(res.status).toBe(400);
  });

  test("rejects unknown fields with 400", async () => {
    const res = await handleSettingsPatch(patch(JSON.stringify({ apiKey: "leak" })));
    expect(res.status).toBe(400);
  });

  test("rejects a non-boolean voice flag with 400", async () => {
    const res = await handleSettingsPatch(patch(JSON.stringify({ useVoiceMode: "yes" })));
    expect(res.status).toBe(400);
  });

  test("rejects a non-JSON body with 400", async () => {
    const res = await handleSettingsPatch(patch("not json"));
    expect(res.status).toBe(400);
  });
});
