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
 * Every plugin webhook lives under a single reserved namespace:
 *
 *     /webhooks/plugins/<plugin>/<subpath>
 *
 * That one decision does most of the work. The Velay allowlist gains
 * exactly one static prefix entry ({@link PLUGIN_WEBHOOK_ALLOWED_PATH}) that
 * covers every plugin forever — no per-plugin allowlist mutation, no
 * churn in the gateway's route-table guard test, and no way for a plugin
 * to widen the public surface beyond the namespace. The gateway resolves
 * `<plugin>` from the path, reads that plugin's manifest from the
 * assistant workspace volume (which it can already read), and forwards to
 * the plugin's own route surface.
 *
 * The gateway therefore needs no meeting-bot-specific code, and adding a
 * second inbound plugin costs nothing.
 *
 * ## Approval
 *
 * A manifest is a *request*, never a grant. An assistant must not be able
 * to open arbitrary public webhooks by writing a file, so the gateway
 * serves the intersection of what a plugin declares and what a guardian
 * has approved. Approval is keyed on {@link ingressManifestDigest} rather
 * than the plugin name, so editing a manifest after approval invalidates
 * it — otherwise a plugin could be approved for one path and then swap in
 * another.
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

/** Reserved namespace prefix every plugin webhook must sit under. */
export const PLUGIN_WEBHOOK_PREFIX = "/webhooks/plugins";

/**
 * Build the public path for a plugin webhook. Use this rather than
 * hand-writing the prefix, so the namespace lives in one place.
 */
export function pluginWebhookPath(plugin: string, subpath: string): string {
  const tail = subpath.replace(/^\/+/, "");
  return `${PLUGIN_WEBHOOK_PREFIX}/${plugin}/${tail}`;
}

/** The namespace a given plugin owns, with its trailing separator. */
function namespaceFor(plugin: string): string {
  return `${PLUGIN_WEBHOOK_PREFIX}/${plugin}/`;
}

/**
 * Validate a manifest, including the two rules the schema cannot express.
 *
 * 1. **Namespace ownership.** Every path must sit under the declaring
 *    plugin's own `/webhooks/plugins/<plugin>/` namespace. Without this a
 *    plugin could declare a path belonging to another plugin and quietly
 *    intercept its webhooks — the whole point of a shared prefix is that
 *    the prefix alone no longer distinguishes who owns what.
 * 2. **Unique paths**, since two routes claiming the same path would make
 *    the gateway's choice of handler arbitrary.
 */
export function parseIngressManifest(raw: unknown): PluginIngressManifest {
  const manifest = PluginIngressManifestSchema.parse(raw);
  const namespace = namespaceFor(manifest.plugin);
  const seen = new Set<string>();
  for (const route of manifest.routes) {
    if (!route.path.startsWith(namespace)) {
      throw new Error(
        `ingress manifest for ${manifest.plugin}: route ${route.path} is ` +
          `outside the plugin's namespace ${namespace}`,
      );
    }
    if (seen.has(route.path)) {
      throw new Error(
        `ingress manifest for ${manifest.plugin}: duplicate route ${route.path}`,
      );
    }
    seen.add(route.path);
  }
  return manifest;
}

/**
 * The single Velay allowlist entry that covers every plugin webhook,
 * forever. A Go RE2 prefix pattern, matching the existing `^/webhooks/`
 * style in the gateway's `VELAY_ALLOWED_PATHS`.
 *
 * Because the namespace is reserved and every declared path is validated
 * to sit inside it, the allowlist never has to change as plugins come and
 * go — which also means a plugin can never widen the tunnel's public
 * surface, only claim a path within a prefix that is already open.
 */
export const PLUGIN_WEBHOOK_ALLOWED_PATH = "^/webhooks/plugins/";

/**
 * Stable digest of what a manifest actually asks for.
 *
 * Guardian approval is keyed on this rather than on the plugin name, so a
 * manifest edited after approval no longer matches and has to be
 * re-approved. Only the fields that affect reach are hashed — a
 * `description` reword should not invalidate a grant.
 *
 * Deliberately dependency-free (djb2 over a canonical string) so the
 * gateway, the guardian UI, and the plugin can all compute it identically
 * without agreeing on a crypto library. Swap in SHA-256 if this ever
 * needs to resist a deliberate collision; today it guards against drift,
 * not attack, because the manifest is already read from a volume only the
 * assistant can write.
 */
export function ingressManifestDigest(
  manifest: PluginIngressManifest,
): string {
  const canonical = [
    `v${manifest.version}`,
    manifest.plugin,
    ...manifest.routes
      .map((r) => `${r.kind} ${r.path}`)
      .slice()
      .sort(),
  ].join("\n");
  let hash = 5381;
  for (let i = 0; i < canonical.length; i++) {
    hash = ((hash << 5) + hash + canonical.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
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
        path: pluginWebhookPath("meeting-bot", "realtime"),
        kind: "websocket",
        description:
          "Realtime event stream the meeting provider dials into (transcript, participant, and lifecycle events).",
      },
    ],
  });
