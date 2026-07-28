/**
 * Schema for `channels/ingress.json` — the static declaration of which
 * public routes this plugin needs the gateway to expose through Velay.
 *
 * ## Why a JSON file rather than code
 *
 * The gateway reads this off the assistant's workspace volume. It must
 * never execute assistant-supplied code to discover routes, so the
 * declaration is inert data: a top-level `channels/ingress.json` the
 * gateway can read and validate without running anything.
 *
 * ## Why the gateway needs it
 *
 * The gateway's public surface is hand-written today, and the Velay path
 * allowlist is a frozen literal with a guard test enforcing symmetry
 * against the route table. That works for first-party integrations —
 * someone edits the gateway when they add one — but a plugin ships
 * separately and cannot patch a frozen array. Without a declaration, a
 * plugin needing inbound traffic has no route to the public surface at
 * all, which is exactly why meeting-bot ended up standing up its own
 * tunnel (`publicWsUrl` + `verificationToken`).
 *
 * ## What this file does NOT decide
 *
 * Only reach: "expose this path and deliver it to me." Everything about
 * how that is honoured belongs to the gateway and is deliberately absent
 * here — the absolute path (composed from the plugin's own name), the
 * Velay allowlist pattern, authentication, and whether a guardian has
 * approved the request at all. A declaration is a request, never a grant.
 */

import { z } from "zod";

import ingressJson from "../../../channels/ingress.json" with { type: "json" };

/**
 * Transport a declared route expects. The gateway bridges HTTP and
 * WebSocket differently (see `gateway/src/velay/http-bridge.ts` and
 * `websocket-bridge.ts`), so it has to know which before a connection
 * arrives.
 */
export const IngressRouteKindSchema = z.enum(["http", "websocket"]);
export type IngressRouteKind = z.infer<typeof IngressRouteKindSchema>;

/** One publicly reachable route this plugin is asking the gateway to expose. */
export const IngressRouteSchema = z.object({
  /**
   * Path **relative to this plugin's own namespace** — `"realtime"`, not
   * `/webhooks/plugins/meeting-bot/realtime`. The gateway owns the prefix
   * and composes the absolute path from the plugin's name.
   *
   * A plugin therefore cannot name another plugin's route: cross-plugin
   * interception is unrepresentable rather than something validation has
   * to catch. The only way back out would be traversal, which is why `.`
   * and `..` segments are rejected — Velay runs `path.Clean` before
   * matching, so `../other/steal` would otherwise resolve outside this
   * plugin's namespace.
   *
   * No leading or trailing slash: `path.Clean` strips trailing slashes,
   * so a composed path ending in one could never match.
   */
  path: z
    .string()
    .min(1)
    .regex(
      /^[^/?#\s][^?#\s]*$/,
      "path must be relative (no leading slash) and free of query/fragment",
    )
    .refine((p) => !p.endsWith("/"), {
      message: "path must not end in a trailing slash",
    })
    .refine((p) => !p.split("/").some((seg) => seg === "." || seg === ".."), {
      message: "path must not contain . or .. segments",
    }),
  kind: IngressRouteKindSchema,
  /** Human-readable purpose, surfaced in gateway logs and admin UI. */
  description: z.string().min(1),
});
export type IngressRoute = z.infer<typeof IngressRouteSchema>;

/**
 * The whole declaration.
 *
 * No version and no plugin name: the manifest format is the assistant's,
 * not something this plugin versions independently, and the plugin's
 * identity is already known from where the file was read.
 */
export const IngressManifestSchema = z.object({
  routes: z.array(IngressRouteSchema).min(1),
});
export type IngressManifest = z.infer<typeof IngressManifestSchema>;

/**
 * Validate a declaration, including the rule the schema cannot express:
 * paths must be unique, since two routes composing to the same absolute
 * path would make the gateway's choice of handler arbitrary.
 */
export function parseIngressManifest(raw: unknown): IngressManifest {
  const manifest = IngressManifestSchema.parse(raw);
  const seen = new Set<string>();
  for (const route of manifest.routes) {
    if (seen.has(route.path)) {
      throw new Error(`ingress manifest: duplicate route ${route.path}`);
    }
    seen.add(route.path);
  }
  return manifest;
}

/** Reserved namespace every plugin webhook is composed under. */
export const PLUGIN_WEBHOOK_PREFIX = "/webhooks/plugins";

/**
 * Compose the absolute public path the gateway serves for a declared
 * route.
 *
 * This is the gateway's job in production. It is exported only because
 * the plugin still has to hand Recall an absolute callback URL today;
 * once the platform meeting service issues that URL from the assistant's
 * identity, the plugin stops composing paths at all.
 */
export function pluginWebhookPath(plugin: string, path: string): string {
  // The schema already rejects a leading slash, but this is exported and
  // called directly for URL building — normalize rather than emit `//`.
  return `${PLUGIN_WEBHOOK_PREFIX}/${plugin}/${path.replace(/^\/+/, "")}`;
}

/** Absolute paths the gateway would serve for `manifest`, in declared order. */
export function ingressRoutePaths(
  manifest: IngressManifest,
  plugin: string,
): string[] {
  return manifest.routes.map((route) => pluginWebhookPath(plugin, route.path));
}

/**
 * This plugin's declaration, parsed from `channels/ingress.json`.
 *
 * Imported from the shipped JSON rather than restated in TypeScript, so
 * the file the gateway reads is the same one the tests validate — a
 * malformed declaration fails CI instead of failing at gateway load.
 */
export const MEETING_BOT_INGRESS_MANIFEST: IngressManifest =
  parseIngressManifest(ingressJson);
