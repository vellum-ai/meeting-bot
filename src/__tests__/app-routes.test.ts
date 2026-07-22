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
  handleProviderPost,
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
  test("returns the config view shape without the shared secret", async () => {
    const res = handleSettingsGet();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.useVoiceMode).toBe("boolean");
    expect(["recall", "vellum"]).toContain(body.provider);
    expect(typeof body.region).toBe("string");
    expect(body).not.toHaveProperty("verificationToken");
  });
});

describe("handleSettingsPatch validation", () => {
  test("rejects a provider change with 400 (its own route owns that)", async () => {
    // Switching providers has side effects beyond a config write, so the
    // settings PATCH must not accept it.
    const res = await handleSettingsPatch(patch(JSON.stringify({ provider: "vellum" })));
    expect(res.status).toBe(400);
  });

  test("rejects an invalid region with 400", async () => {
    const res = await handleSettingsPatch(patch(JSON.stringify({ region: "moon-1" })));
    expect(res.status).toBe(400);
  });

  test("rejects non-editable / unknown fields with 400", async () => {
    // publicWsUrl is a real config field but not editable from the app.
    const res = await handleSettingsPatch(
      patch(JSON.stringify({ publicWsUrl: "wss://evil" })),
    );
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

describe("handleProviderPost validation", () => {
  // Only the reject paths run here: a valid switch writes the plugin's real
  // config.json, and the value-precise write behavior is covered against
  // temp files in app-settings.test.ts (applyProviderChange).
  function providerPost(body: string): Request {
    return new Request("http://x/x/plugins/meeting-bot/provider", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  }

  test("rejects an unknown provider with 400", async () => {
    const res = await handleProviderPost(providerPost(JSON.stringify({ provider: "zoom" })));
    expect(res.status).toBe(400);
  });

  test("rejects extra fields with 400", async () => {
    const res = await handleProviderPost(
      providerPost(JSON.stringify({ provider: "vellum", region: "us-west-2" })),
    );
    expect(res.status).toBe(400);
  });

  test("rejects a non-JSON body with 400", async () => {
    const res = await handleProviderPost(providerPost("not json"));
    expect(res.status).toBe(400);
  });
});

describe("restartProviderRuntime", () => {
  test("degrades to a note when the plugin has not initialized", async () => {
    // In tests there is no stashed InitContext, so the restart must not touch
    // any runtime and must say so.
    const { restartProviderRuntime } = await import("../provider-runtime.ts");
    const note = await restartProviderRuntime();
    expect(note).toContain("not initialized");
  });
});
