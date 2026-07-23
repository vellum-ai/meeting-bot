/**
 * Tests for the daemon-side join flow behind the dashboard's Join button.
 *
 * The vellum path is exercised end to end against an injected fetch (the
 * loopback control call is the whole flow); the recall path is exercised up
 * to credential resolution, which fails in the test environment and must
 * surface as a client-appropriate 409 rather than a crash. The Recall
 * request body itself is covered by recall-requests.test.ts.
 */

import { describe, expect, test } from "bun:test";

import { resolveConfig } from "../config.ts";
import { JoinRequestError, startJoinFromApp } from "../join-flow.ts";
import { setResolvedConfig } from "../plugin-state.ts";

function fakeFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return ((url: unknown, init?: unknown) =>
    Promise.resolve(handler(String(url), init as RequestInit))) as typeof fetch;
}

function useProvider(provider: "recall" | "vellum"): void {
  const { config } = resolveConfig({ provider });
  setResolvedConfig(config);
}

describe("startJoinFromApp (vellum)", () => {
  test("commands the worker's loopback /join and returns the meeting id", async () => {
    useProvider("vellum");
    const seen: { url?: string; body?: unknown } = {};
    const result = await startJoinFromApp("https://meet.google.com/abc-defg-hij", {
      fetchImpl: fakeFetch((url, init) => {
        seen.url = url;
        seen.body = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ meetingId: "m-123" }), {
          status: 200,
        });
      }),
    });

    expect(result.provider).toBe("vellum");
    expect(result.botId).toBe("m-123");
    expect(seen.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/join$/);
    expect(seen.body).toEqual({
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      conversationId: null,
    });
  });

  test("maps a connection failure to a 502 with a runtime hint", async () => {
    useProvider("vellum");
    const err = await startJoinFromApp("https://meet.google.com/abc", {
      fetchImpl: (() =>
        Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JoinRequestError);
    expect((err as JoinRequestError).status).toBe(502);
    expect((err as JoinRequestError).message).toContain("Vellum Runtime");
  });

  test("surfaces the worker's error body on a rejected join", async () => {
    useProvider("vellum");
    const err = await startJoinFromApp("https://meet.google.com/abc", {
      fetchImpl: fakeFetch(() =>
        new Response(JSON.stringify({ error: "browser stack missing" }), {
          status: 503,
        }),
      ),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JoinRequestError);
    expect((err as JoinRequestError).status).toBe(502);
    expect((err as JoinRequestError).message).toContain("browser stack missing");
  });

  test("rejects a response with no meeting id", async () => {
    useProvider("vellum");
    const err = await startJoinFromApp("https://meet.google.com/abc", {
      fetchImpl: fakeFetch(() => new Response("{}", { status: 200 })),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JoinRequestError);
    expect((err as JoinRequestError).status).toBe(502);
  });
});

describe("startJoinFromApp (recall)", () => {
  test("maps a missing API key to a 409 before any network call", async () => {
    useProvider("recall");
    let fetched = false;
    const err = await startJoinFromApp("https://meet.google.com/abc", {
      fetchImpl: fakeFetch(() => {
        fetched = true;
        return new Response("{}", { status: 200 });
      }),
    }).catch((e: unknown) => e);
    // The test environment has no credential store, so key resolution
    // fails; the flow must turn that into a client-visible 409, and the
    // Recall API must never be contacted without a key.
    expect(err).toBeInstanceOf(JoinRequestError);
    expect((err as JoinRequestError).status).toBe(409);
    expect(fetched).toBe(false);
  });
});
