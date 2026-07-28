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
  ingressRoutePaths,
  parseIngressManifest,
  pluginWebhookPath,
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

describe("channels/ingress.json", () => {
  test("the shipped declaration parses and names only the realtime route", () => {
    // MEETING_BOT_INGRESS_MANIFEST is parsed from the real file, so a
    // malformed declaration fails here rather than at gateway load.
    expect(MEETING_BOT_INGRESS_MANIFEST.routes.length).toBe(1);
    const route = MEETING_BOT_INGRESS_MANIFEST.routes[0]!;
    expect(route.path).toBe("realtime");
    expect(route.kind).toBe("websocket");
  });

  test("declares reach only — no version, plugin name, or auth", () => {
    // The format is the assistant's, the plugin identity is known from
    // where the file was read, and auth belongs to whoever mints the
    // credential.
    expect(Object.keys(MEETING_BOT_INGRESS_MANIFEST).sort()).toEqual([
      "routes",
    ]);
    expect(Object.keys(MEETING_BOT_INGRESS_MANIFEST.routes[0]!).sort()).toEqual(
      ["description", "kind", "path"],
    );
  });

  test("composes to the absolute path the contract advertises", () => {
    expect(
      ingressRoutePaths(MEETING_BOT_INGRESS_MANIFEST, "meeting-bot"),
    ).toEqual([MEETING_BOT_REALTIME_PATH]);
  });
});

describe("ingress manifest validation", () => {
  test("pluginWebhookPath composes inside the reserved namespace", () => {
    expect(pluginWebhookPath("acme", "hook")).toBe(
      "/webhooks/plugins/acme/hook",
    );
    // Defensive: the schema rejects a leading slash, but this is exported.
    expect(pluginWebhookPath("acme", "/hook")).toBe(
      "/webhooks/plugins/acme/hook",
    );
  });

  test("a route cannot address another plugin — it names only its own path", () => {
    // Cross-plugin interception is unrepresentable: whatever is declared
    // composes under the plugin the gateway read the file from.
    const manifest = parseIngressManifest({
      routes: [{ path: "realtime", kind: "websocket", description: "d" }],
    });
    expect(ingressRoutePaths(manifest, "evil")).toEqual([
      "/webhooks/plugins/evil/realtime",
    ]);
  });

  test("rejects an absolute path", () => {
    expect(() =>
      parseIngressManifest({
        routes: [{ path: "/hook", kind: "http", description: "d" }],
      }),
    ).toThrow();
  });

  test("rejects traversal segments that would escape the namespace", () => {
    // Velay runs path.Clean before matching, so `../other/steal` would
    // otherwise resolve outside this plugin's namespace.
    for (const path of ["../other/steal", "a/../../b", "./hook"]) {
      expect(() =>
        parseIngressManifest({
          routes: [{ path, kind: "http", description: "d" }],
        }),
      ).toThrow();
    }
  });

  test("rejects a trailing slash", () => {
    expect(() =>
      parseIngressManifest({
        routes: [{ path: "hook/", kind: "http", description: "d" }],
      }),
    ).toThrow(/trailing slash/);
  });

  test("rejects embedded query strings and fragments", () => {
    for (const path of ["hook?x=1", "hook#f"]) {
      expect(() =>
        parseIngressManifest({
          routes: [{ path, kind: "http", description: "d" }],
        }),
      ).toThrow();
    }
  });

  test("rejects duplicate paths", () => {
    expect(() =>
      parseIngressManifest({
        routes: [
          { path: "hook", kind: "http", description: "one" },
          { path: "hook", kind: "http", description: "two" },
        ],
      }),
    ).toThrow(/duplicate route/);
  });

  test("strips unknown fields rather than carrying them through", () => {
    const manifest = parseIngressManifest({
      routes: [
        {
          path: "hook",
          kind: "http",
          description: "d",
          auth: { mode: "query-token", credentialField: "tok" },
        },
      ],
    });
    expect(manifest.routes[0]).not.toHaveProperty("auth");
  });

  test("requires at least one route", () => {
    expect(() => parseIngressManifest({ routes: [] })).toThrow();
  });
});
