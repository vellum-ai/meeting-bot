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
  handleJoinPost,
  handleMeetingLogGet,
  handleMeetingsGet,
  handleProviderPost,
  handleSettingsGet,
  handleSettingsPatch,
} from "../app-routes.ts";
import { clearResolvedConfigForTests } from "../plugin-state.ts";

function patch(body: string): Request {
  return new Request("http://x/x/plugins/meeting-bot/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body,
  });
}

function joinRequest(body: string): Request {
  return new Request("http://x/x/plugins/meeting-bot/join", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

describe("handleJoinPost validation", () => {
  test("rejects a non-JSON body with 400", async () => {
    const res = await handleJoinPost(joinRequest("not json"));
    expect(res.status).toBe(400);
  });

  test("rejects a missing meetingUrl with 400", async () => {
    const res = await handleJoinPost(joinRequest(JSON.stringify({})));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("meetingUrl");
  });

  test("rejects a non-http(s) link with 400", async () => {
    const res = await handleJoinPost(
      joinRequest(JSON.stringify({ meetingUrl: "file:///etc/passwd" })),
    );
    expect(res.status).toBe(400);
  });

  test("returns 503 when the plugin has not initialized", async () => {
    clearResolvedConfigForTests();
    const res = await handleJoinPost(
      joinRequest(
        JSON.stringify({ meetingUrl: "https://meet.google.com/abc-defg-hij" }),
      ),
    );
    expect(res.status).toBe(503);
  });
});

describe("handleMeetingsGet", () => {
  test("returns a JSON array", async () => {
    const res = await handleMeetingsGet();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(Array.isArray(await res.json())).toBe(true);
  });
});

describe("handleMeetingLogGet", () => {
  function logGet(botId: string): Request {
    return new Request(
      `http://x/x/plugins/meeting-bot/meeting-log?botId=${encodeURIComponent(botId)}`,
    );
  }

  test("rejects a non-UUID id with 400 (doubles as traversal guard)", () => {
    expect(handleMeetingLogGet(logGet("../../secrets")).status).toBe(400);
    expect(handleMeetingLogGet(logGet("")).status).toBe(400);
  });

  test("returns 404 for a valid id with no captured log", () => {
    const res = handleMeetingLogGet(
      logGet("00000000-0000-4000-8000-000000000000"),
    );
    expect(res.status).toBe(404);
  });
});

describe("handleSettingsGet", () => {
  test("returns the config view shape without the shared secret", async () => {
    const res = handleSettingsGet();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.useVoiceMode).toBe("boolean");
    expect(["recall", "vellum"]).toContain(body.provider as string);
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

describe("providerRuntimeContext", () => {
  // A live provider switch used to depend on an InitContext the init hook
  // stashed in a module global. When the route did not observe that global the
  // switch returned early: the old runtime kept running, and the note it
  // returned read as "restart the assistant". Nothing is stashed now — the
  // context is derived, so the route always has one and always bounces the
  // runtime. Actually running the restart is not unit-testable: it spawns real
  // subprocesses (and a tunnel).

  test("is available with no init hook having run", async () => {
    const { providerRuntimeContext } = await import("../provider-runtime.ts");
    const ctx = providerRuntimeContext();
    expect(typeof ctx.logger.warn).toBe("function");
    expect(ctx.pluginStorageDir.length).toBeGreaterThan(0);
  });

  test("points at the same data directory the init hook is given", async () => {
    // The daemon passes `<pluginDir>/data` as pluginStorageDir, which is what
    // plugin-paths resolves. They must agree or a route-started runtime would
    // read a different PID file than a hook-started one and fail to reap it.
    const { providerRuntimeContext } = await import("../provider-runtime.ts");
    const { pluginDataDir } = await import("../plugin-paths.ts");
    expect(providerRuntimeContext().pluginStorageDir).toBe(pluginDataDir());
  });
});

describe("providerRestartNote", () => {
  const base = { region: "us-east-1", listenPort: 8790 } as unknown as Parameters<
    typeof import("../provider-runtime.ts").providerRestartNote
  >[0];

  test("warns, and stays on screen, when recall has no callback URL", async () => {
    // The state a switch to recall lands in when no publicWsUrl is configured
    // and no tunnel could be provisioned. The switch itself succeeds, so this
    // note is the only place it surfaces before a join fails.
    const { providerRestartNote } = await import("../provider-runtime.ts");
    const { note, usable } = providerRestartNote({ ...base, provider: "recall" });
    expect(usable).toBe(false);
    expect(note).toContain("joins will fail");
    expect(note).toContain("publicWsUrl");
    expect(note).toContain("cloudflared");
  });

  test("confirms plainly when recall has a URL", async () => {
    const { providerRestartNote } = await import("../provider-runtime.ts");
    expect(
      providerRestartNote({
        ...base,
        provider: "recall",
        publicWsUrl: "wss://tunnel.example",
      }),
    ).toEqual({ note: "provider runtime restarted (recall)", usable: true });
  });

  test("does not ask the vellum path for a public URL", async () => {
    // The Vellum Runtime joins calls itself; nothing dials in from outside.
    const { providerRestartNote } = await import("../provider-runtime.ts");
    expect(providerRestartNote({ ...base, provider: "vellum" })).toEqual({
      note: "provider runtime restarted (vellum)",
      usable: true,
    });
  });
});
