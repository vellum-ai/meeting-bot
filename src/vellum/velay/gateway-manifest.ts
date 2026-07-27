/**
 * Declarative ingress manifest: the JSON a plugin publishes so the gateway
 * can expose its public routes through Velay **without knowing what the
 * plugin is**.
 *
 * ## The problem this solves
 *
 * Today the gateway's public surface is entirely hand-written. Every
 * externally-reachable route is a bespoke handler, and the Velay path
 * allowlist is a frozen literal:
 *
 *     // gateway/src/velay/allowed-paths.ts
 *     export const VELAY_ALLOWED_PATHS = Object.freeze([
 *       "^/webhooks/", "^/v1/audio/", "^/v1/live-voice$", ...
 *     ]);
 *
 * with a guard test enforcing symmetry against the gateway's route table.
 * That works because Twilio, Telegram, and the rest are all first-party:
 * someone edits the gateway when they add one. A plugin cannot do that —
 * it ships separately from the gateway and cannot patch a frozen array.
 *
 * So a plugin that needs inbound traffic (meeting-bot is the first, but
 * any webhook-receiving plugin is the same shape) currently has no route
 * to the public surface at all. It has to stand up its own tunnel, which
 * is exactly the `publicWsUrl` + `verificationToken` duplication the
 * Velay move is meant to delete.
 *
 * ## The shape
 *
 * A plugin publishes an {@link PluginIngressManifest}. The gateway reads
 * every installed plugin's manifest, unions the derived path patterns into
 * its Velay allowlist, and forwards matching inbound requests to the
 * plugin's own route surface (`/x/plugins/<name>/…`, which already exists
 * — the dashboard's routes are served there today).
 *
 * The gateway therefore needs no meeting-bot-specific code: it validates
 * the manifest, derives the allowlist, and proxies. Adding a second
 * inbound plugin costs nothing.
 *
 * ## Status
 *
 * Proposal. Nothing in the gateway reads this yet; the schema and the
 * meeting-bot instance live here so the shape can be reviewed against a
 * real consumer before it is built into
 * `vellum-assistant` / `vellum-assistant-platform`.
 */

import { z } from "zod";

/**
 * Transport a declared route expects. The gateway bridges HTTP and
 * WebSocket differently (see `gateway/src/velay/http-bridge.ts` and
 * `websocket-bridge.ts`), so it has to know which before a connection
 * arrives.
 */
export const IngressRouteKindSchema = z.enum(["http", "websocket"]);
export type IngressRouteKind = z.infer<typeof IngressRouteKindSchema>;

/**
 * One publicly reachable route a plugin is asking the gateway to expose.
 *
 * Note what is *not* here: authentication. The manifest declares reach —
 * "this path should survive the allowlist and arrive at my handler" — and
 * nothing else. Authenticating the caller stays with whoever mints the
 * credential: the route handler, or the platform service that issued the
 * callback URL in the first place. Keeping auth out means the gateway
 * never runs plugin-directed validation logic, and it keeps this schema
 * (a forward-compatibility commitment, once plugins depend on it) as
 * small as it can be.
 */
export const IngressRouteSchema = z.object({
  /**
   * Absolute public path, exactly as the external caller will request it.
   * Must start with `/` and carry no query string — the query is runtime
   * data, not part of the route identity.
   *
   * No trailing slash: Velay runs `path.Clean` on the inbound path before
   * matching, which strips trailing slashes, so a pattern derived from
   * `/foo/` could never match anything.
   */
  path: z
    .string()
    .min(1)
    .regex(/^\/[^?#\s]*$/, "path must be absolute and free of query/fragment")
    .refine((p) => p === "/" || !p.endsWith("/"), {
      message: "path must not end in a trailing slash",
    }),
  kind: IngressRouteKindSchema,
  /** Human-readable purpose, surfaced in gateway logs and admin UI. */
  description: z.string().min(1),
});
export type IngressRoute = z.infer<typeof IngressRouteSchema>;

/** Everything one plugin declares about its public surface. */
export const PluginIngressManifestSchema = z.object({
  /** Manifest format version, so the gateway can reject what it can't parse. */
  version: z.literal(1),
  /** Plugin name; must match the installed plugin's manifest name. */
  plugin: z.string().min(1),
  routes: z.array(IngressRouteSchema).min(1),
});
export type PluginIngressManifest = z.infer<typeof PluginIngressManifestSchema>;

/**
 * Validate a manifest, including the one rule the schema cannot express:
 * paths must be unique, since two routes claiming the same path would
 * make the gateway's choice of handler arbitrary.
 */
export function parseIngressManifest(raw: unknown): PluginIngressManifest {
  const manifest = PluginIngressManifestSchema.parse(raw);
  const seen = new Set<string>();
  for (const route of manifest.routes) {
    if (seen.has(route.path)) {
      throw new Error(
        `ingress manifest for ${manifest.plugin}: duplicate route ${route.path}`,
      );
    }
    seen.add(route.path);
  }
  return manifest;
}

/** Escape a literal string for embedding in a Go RE2 pattern. */
function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Derive the Velay allowlist patterns for a manifest.
 *
 * Velay enforces the allowlist platform-side against Go RE2 patterns (see
 * `RegistrationAllowedPathsHeader`), so each route becomes an exactly
 * anchored pattern. Exact anchoring rather than a prefix: a plugin should
 * open the routes it declared and nothing adjacent to them.
 */
export function toVelayAllowedPaths(
  manifest: PluginIngressManifest,
): string[] {
  return manifest.routes.map((route) => `^${escapeRegex(route.path)}$`);
}

/**
 * Union the allowlist patterns for several plugins, de-duplicated and
 * ordered so the gateway's own guard test can compare deterministically.
 */
export function mergeVelayAllowedPaths(
  manifests: readonly PluginIngressManifest[],
): string[] {
  const all = new Set<string>();
  for (const manifest of manifests) {
    for (const pattern of toVelayAllowedPaths(manifest)) all.add(pattern);
  }
  return [...all].sort();
}

/**
 * meeting-bot's declaration.
 *
 * One route: the realtime socket the meeting provider dials into. The
 * token Recall carries on that URL is validated by whoever minted it —
 * the plugin today, the platform meeting service once it issues the
 * callback URL — not by the gateway.
 */
export const MEETING_BOT_INGRESS_MANIFEST: PluginIngressManifest =
  parseIngressManifest({
    version: 1,
    plugin: "meeting-bot",
    routes: [
      {
        path: "/webhooks/meeting-bot/realtime",
        kind: "websocket",
        description:
          "Realtime event stream the meeting provider dials into (transcript, participant, and lifecycle events).",
      },
    ],
  });
