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
  PLUGIN_WEBHOOK_ALLOWED_PATH,
  ingressManifestDigest,
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

describe("plugin ingress manifest", () => {
  test("meeting-bot's manifest declares the realtime socket", () => {
    expect(MEETING_BOT_INGRESS_MANIFEST.plugin).toBe("meeting-bot");
    const route = MEETING_BOT_INGRESS_MANIFEST.routes[0]!;
    // The manifest names only the subpath; the gateway composes the rest.
    expect(route.subpath).toBe("realtime");
    expect(route.kind).toBe("websocket");
    expect(ingressRoutePaths(MEETING_BOT_INGRESS_MANIFEST)).toEqual([
      MEETING_BOT_REALTIME_PATH,
    ]);
  });

  test("declares reach only — no auth fields in the manifest", () => {
    // Authentication belongs to whoever minted the credential, not to the
    // gateway. Keeping it out of the schema keeps the forward-compat
    // surface minimal.
    const route = MEETING_BOT_INGRESS_MANIFEST.routes[0]! as Record<
      string,
      unknown
    >;
    expect(Object.keys(route).sort()).toEqual([
      "description",
      "kind",
      "subpath",
    ]);
  });

  test("strips unknown fields rather than carrying them through", () => {
    const manifest = parseIngressManifest({
      version: 1,
      plugin: "p",
      routes: [
        {
          subpath: "hook",
          kind: "http",
          description: "d",
          auth: { mode: "query-token", credentialField: "tok" },
        },
      ],
    });
    expect(manifest.routes[0]).not.toHaveProperty("auth");
  });

  test("rejects a path with a trailing slash", () => {
    // Velay runs path.Clean before matching, which strips trailing
    // slashes — a pattern derived from `/foo/` could never match.
    expect(() =>
      parseIngressManifest({
        version: 1,
        plugin: "p",
        routes: [{ subpath: "hook/", kind: "http", description: "d" }],
      }),
    ).toThrow(/trailing slash/);
  });

  test("one static prefix covers every plugin webhook", () => {
    // The allowlist never changes as plugins come and go, and a plugin
    // cannot widen the tunnel beyond a prefix that is already open.
    const re = new RegExp(PLUGIN_WEBHOOK_ALLOWED_PATH);
    for (const path of ingressRoutePaths(MEETING_BOT_INGRESS_MANIFEST)) {
      expect(re.test(path)).toBe(true);
    }
    expect(re.test("/webhooks/twilio/voice")).toBe(false);
    expect(re.test("/v1/live-voice")).toBe(false);
  });

  test("pluginWebhookPath builds inside the reserved namespace", () => {
    expect(pluginWebhookPath("acme", "hook")).toBe(
      "/webhooks/plugins/acme/hook",
    );
    // A leading slash on the subpath must not double up.
    expect(pluginWebhookPath("acme", "/hook")).toBe(
      "/webhooks/plugins/acme/hook",
    );
  });

  test("a route cannot address another plugin — it names only a subpath", () => {
    // Cross-plugin interception is unrepresentable: whatever "evil"
    // declares composes under evil's own namespace.
    const manifest = parseIngressManifest({
      version: 1,
      plugin: "evil",
      routes: [{ subpath: "realtime", kind: "websocket", description: "d" }],
    });
    expect(ingressRoutePaths(manifest)).toEqual([
      "/webhooks/plugins/evil/realtime",
    ]);
  });

  test("rejects an absolute subpath", () => {
    expect(() =>
      parseIngressManifest({
        version: 1,
        plugin: "p",
        routes: [{ subpath: "/hook", kind: "http", description: "d" }],
      }),
    ).toThrow();
  });

  test("rejects traversal segments that would escape the namespace", () => {
    // Velay runs path.Clean before matching, so `../other/steal` would
    // otherwise resolve outside the declaring plugin's namespace.
    for (const subpath of ["../other/steal", "a/../../b", "./hook"]) {
      expect(() =>
        parseIngressManifest({
          version: 1,
          plugin: "p",
          routes: [{ subpath, kind: "http", description: "d" }],
        }),
      ).toThrow();
    }
  });

  test("the approval digest tracks reach, not prose", () => {
    const base = {
      version: 1 as const,
      plugin: "p",
      routes: [
        { subpath: "a", kind: "http" as const, description: "one" },
      ],
    };
    const original = ingressManifestDigest(parseIngressManifest(base));

    // Rewording a description must not invalidate an approval.
    const reworded = ingressManifestDigest(
      parseIngressManifest({
        ...base,
        routes: [{ ...base.routes[0]!, description: "reworded" }],
      }),
    );
    expect(reworded).toBe(original);

    // Adding reach must.
    const widened = ingressManifestDigest(
      parseIngressManifest({
        ...base,
        routes: [
          base.routes[0]!,
          { subpath: "b", kind: "http" as const, description: "two" },
        ],
      }),
    );
    expect(widened).not.toBe(original);

    // As must changing a path's transport.
    const retyped = ingressManifestDigest(
      parseIngressManifest({
        ...base,
        routes: [{ ...base.routes[0]!, kind: "websocket" as const }],
      }),
    );
    expect(retyped).not.toBe(original);
  });

  test("rejects duplicate paths", () => {
    expect(() =>
      parseIngressManifest({
        version: 1,
        plugin: "p",
        routes: [
          { subpath: "hook", kind: "http", description: "one" },
          { subpath: "hook", kind: "http", description: "two" },
        ],
      }),
    ).toThrow(/duplicate route/);
  });

  test("rejects embedded query strings and fragments", () => {
    for (const subpath of ["hook?x=1", "hook#f"]) {
      expect(() =>
        parseIngressManifest({
          version: 1,
          plugin: "p",
          routes: [{ subpath, kind: "http", description: "d" }],
        }),
      ).toThrow();
    }
  });

  test("rejects an unknown manifest version", () => {
    expect(() =>
      parseIngressManifest({
        version: 2,
        plugin: "p",
        routes: [{ subpath: "hook", kind: "http", description: "d" }],
      }),
    ).toThrow();
  });
});
