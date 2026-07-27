/**
 * Tests for the Velay ingress contract and the plugin ingress manifest.
 */

import { describe, expect, test } from "bun:test";

import {
  MEETING_BOT_REALTIME_PATH,
  PUBLIC_BASE_URL_PLACEHOLDER,
  PUBLIC_BASE_WSS_PLACEHOLDER,
  buildMeetingBotRealtimeUrl,
  hasUnsubstitutedPlaceholder,
  substitutePublicBaseUrl,
  toWebSocketBaseUrl,
} from "../vellum/velay/ingress-contract.ts";
import {
  MEETING_BOT_INGRESS_MANIFEST,
  mergeVelayAllowedPaths,
  parseIngressManifest,
  toVelayAllowedPaths,
} from "../vellum/velay/gateway-manifest.ts";

describe("ingress contract", () => {
  test("converts http base URLs to their websocket form", () => {
    expect(toWebSocketBaseUrl("https://x.test")).toBe("wss://x.test");
    expect(toWebSocketBaseUrl("http://x.test")).toBe("ws://x.test");
  });

  test("builds the placeholder form the gateway substitutes", () => {
    const url = buildMeetingBotRealtimeUrl(PUBLIC_BASE_URL_PLACEHOLDER);
    expect(url).toBe(`${PUBLIC_BASE_WSS_PLACEHOLDER}${MEETING_BOT_REALTIME_PATH}`);
    expect(hasUnsubstitutedPlaceholder(url)).toBe(true);
  });

  test("normalizes a trailing slash so the path never doubles up", () => {
    // Recall rejects a double slash before the query string with a 400.
    expect(buildMeetingBotRealtimeUrl("https://x.test/")).toBe(
      `wss://x.test${MEETING_BOT_REALTIME_PATH}`,
    );
  });

  test("appends and encodes a token", () => {
    const url = buildMeetingBotRealtimeUrl("https://x.test", "a b&c");
    expect(url).toBe(
      `wss://x.test${MEETING_BOT_REALTIME_PATH}?token=a%20b%26c`,
    );
  });

  test("round-trips placeholder to a live URL", () => {
    const emitted = buildMeetingBotRealtimeUrl(
      PUBLIC_BASE_URL_PLACEHOLDER,
      "tok",
    );
    const live = substitutePublicBaseUrl(emitted, "https://tunnel.test/");
    expect(live).toBe(`wss://tunnel.test${MEETING_BOT_REALTIME_PATH}?token=tok`);
    expect(hasUnsubstitutedPlaceholder(live)).toBe(false);
  });

  test("leaves a concrete URL untouched", () => {
    const url = buildMeetingBotRealtimeUrl("https://fixed.test");
    expect(substitutePublicBaseUrl(url, "https://tunnel.test")).toBe(url);
    expect(hasUnsubstitutedPlaceholder(url)).toBe(false);
  });
});

describe("plugin ingress manifest", () => {
  test("meeting-bot's manifest declares the realtime socket", () => {
    expect(MEETING_BOT_INGRESS_MANIFEST.plugin).toBe("meeting-bot");
    const route = MEETING_BOT_INGRESS_MANIFEST.routes[0]!;
    expect(route.path).toBe(MEETING_BOT_REALTIME_PATH);
    expect(route.kind).toBe("websocket");
    expect(route.auth).toEqual({
      mode: "query-token",
      credentialField: "realtime_token",
      queryParam: "token",
    });
  });

  test("defaults auth to none and queryParam to token", () => {
    const manifest = parseIngressManifest({
      version: 1,
      plugin: "p",
      routes: [
        { path: "/webhooks/a", kind: "http", description: "d" },
        {
          path: "/webhooks/b",
          kind: "websocket",
          auth: { mode: "query-token", credentialField: "tok" },
          description: "d",
        },
      ],
    });
    expect(manifest.routes[0]!.auth).toEqual({ mode: "none" });
    const auth = manifest.routes[1]!.auth;
    expect(auth.mode).toBe("query-token");
    if (auth.mode === "query-token") expect(auth.queryParam).toBe("token");
  });

  test("rejects a query-token auth carrying no credential field", () => {
    // The union makes this unrepresentable rather than a runtime check.
    expect(() =>
      parseIngressManifest({
        version: 1,
        plugin: "p",
        routes: [
          {
            path: "/webhooks/p",
            kind: "websocket",
            auth: { mode: "query-token" },
            description: "d",
          },
        ],
      }),
    ).toThrow();
  });

  test("rejects an unknown auth mode", () => {
    expect(() =>
      parseIngressManifest({
        version: 1,
        plugin: "p",
        routes: [
          {
            path: "/webhooks/p",
            kind: "http",
            auth: { mode: "hmac", secret: "s" },
            description: "d",
          },
        ],
      }),
    ).toThrow();
  });

  test("derives an exactly-anchored RE2 pattern per route", () => {
    expect(toVelayAllowedPaths(MEETING_BOT_INGRESS_MANIFEST)).toEqual([
      "^/webhooks/meeting-bot/realtime$",
    ]);
  });

  test("escapes regex metacharacters in paths", () => {
    const manifest = parseIngressManifest({
      version: 1,
      plugin: "p",
      routes: [
        { path: "/webhooks/a.b+c", kind: "http", description: "d" },
      ],
    });
    const [pattern] = toVelayAllowedPaths(manifest);
    // The derived pattern must match the literal path and nothing adjacent.
    const re = new RegExp(pattern!);
    expect(re.test("/webhooks/a.b+c")).toBe(true);
    expect(re.test("/webhooks/axbxc")).toBe(false);
    expect(re.test("/webhooks/a.b+c/extra")).toBe(false);
  });

  test("merges and de-duplicates across plugins", () => {
    const other = parseIngressManifest({
      version: 1,
      plugin: "other",
      routes: [{ path: "/webhooks/other", kind: "http", description: "d" }],
    });
    const merged = mergeVelayAllowedPaths([
      MEETING_BOT_INGRESS_MANIFEST,
      other,
      MEETING_BOT_INGRESS_MANIFEST,
    ]);
    expect(merged.length).toBe(2);
    expect(new Set(merged).size).toBe(2);
    // Sorted for a deterministic comparison in the gateway's guard test.
    expect([...merged].sort()).toEqual(merged);
  });

  test("rejects duplicate paths", () => {
    expect(() =>
      parseIngressManifest({
        version: 1,
        plugin: "p",
        routes: [
          { path: "/webhooks/p", kind: "http", description: "one" },
          { path: "/webhooks/p", kind: "http", description: "two" },
        ],
      }),
    ).toThrow(/duplicate route/);
  });

  test("rejects relative paths and embedded query strings", () => {
    for (const path of ["webhooks/p", "/webhooks/p?x=1", "/webhooks/p#f"]) {
      expect(() =>
        parseIngressManifest({
          version: 1,
          plugin: "p",
          routes: [{ path, kind: "http", description: "d" }],
        }),
      ).toThrow();
    }
  });

  test("rejects an unknown manifest version", () => {
    expect(() =>
      parseIngressManifest({
        version: 2,
        plugin: "p",
        routes: [{ path: "/webhooks/p", kind: "http", description: "d" }],
      }),
    ).toThrow();
  });
});
