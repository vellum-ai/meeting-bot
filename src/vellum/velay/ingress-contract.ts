/**
 * Public-ingress contract for the meeting-bot realtime surface, routed
 * through **Velay** — the assistant platform's reverse tunnel.
 *
 * ## What Velay actually is
 *
 * Velay is not a meeting service. The gateway holds one outbound WebSocket
 * to Velay (`velay-tunnel-v1`), Velay answers with a `registered` frame
 * carrying a public URL, and every inbound HTTP request or WebSocket
 * connection to that URL is framed down the tunnel and bridged to a
 * gateway route. It is the platform's own ingress: one public surface,
 * owned by the gateway, shared by every integration.
 *
 * ## Why this matters here
 *
 * The `recall` provider's realtime model is inbound — Recall dials a
 * `wss://` URL we expose and streams transcript/participant events into
 * it. Today the plugin satisfies that with `publicWsUrl`: the operator
 * stands up their own tunnel, pastes the address into config, and the
 * plugin guards it with `verificationToken`. That is a second, parallel
 * ingress next to the one the platform already runs.
 *
 * Velay removes it. The meeting-bot realtime endpoint becomes a gateway
 * route on the shared public surface, and the plugin stops owning a public
 * address entirely.
 *
 * ## The placeholder convention
 *
 * The plugin must hand Recall an absolute `wss://` URL at bot-creation
 * time — but it cannot know the tunnel's public URL (Velay assigns it at
 * registration, and it changes across restarts). So the plugin emits a
 * sentinel and the gateway substitutes the live value on the way out, the
 * same mechanism the Twilio path uses for TwiML
 * (`TWILIO_PUBLIC_BASE_URL_PLACEHOLDER` in
 * `packages/service-contracts/src/twilio-ingress.ts`, substituted in
 * `gateway/src/runtime/client.ts`).
 *
 * The sentinel string is deliberately identical to Twilio's: it is a
 * gateway-wide convention, not a per-integration one, so a single
 * substitution pass can serve every caller.
 */

/**
 * Path the meeting provider dials to stream realtime events in.
 *
 * Lives under `/webhooks/` because Velay's platform-side allowlist already
 * admits that prefix (`^/webhooks/` in the gateway's
 * `VELAY_ALLOWED_PATHS`), so this route needs no allowlist change to be
 * reachable — see `gateway-manifest.ts` for the general case.
 */
export const MEETING_BOT_REALTIME_PATH = "/webhooks/meeting-bot/realtime";

/**
 * Sentinel the plugin emits where the tunnel's public base URL belongs.
 * The gateway replaces it before the value reaches an external service.
 *
 * `https://` rather than `wss://` so the standard http→ws conversion in
 * {@link buildMeetingBotRealtimeUrl} produces the WebSocket form, matching
 * how the Twilio builders behave.
 */
export const PUBLIC_BASE_URL_PLACEHOLDER = "https://__VELLUM_PUBLIC_BASE_URL__";

/** The post-conversion form the gateway actually scans for. */
export const PUBLIC_BASE_WSS_PLACEHOLDER = "wss://__VELLUM_PUBLIC_BASE_URL__";

/** Convert an http(s) base URL to its ws(s) equivalent. */
export function toWebSocketBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/^http(s?)/, "ws$1");
}

/**
 * Build the realtime WebSocket URL handed to the meeting provider.
 *
 * Pass {@link PUBLIC_BASE_URL_PLACEHOLDER} as `baseUrl` to get the
 * sentinel form the gateway will substitute. Pass a real base URL (tests,
 * or a deployment that still runs its own tunnel) to get a concrete URL.
 *
 * A trailing slash on `baseUrl` is normalized away: Recall rejects a
 * double slash before the query string with a 400.
 */
export function buildMeetingBotRealtimeUrl(
  baseUrl: string,
  token?: string,
): string {
  const normalized = toWebSocketBaseUrl(baseUrl).replace(/\/+$/, "");
  const url = `${normalized}${MEETING_BOT_REALTIME_PATH}`;
  if (!token) return url;
  return `${url}?token=${encodeURIComponent(token)}`;
}

/** True when `value` still carries an unsubstituted placeholder. */
export function hasUnsubstitutedPlaceholder(value: string): boolean {
  return (
    value.includes(PUBLIC_BASE_WSS_PLACEHOLDER) ||
    value.includes(PUBLIC_BASE_URL_PLACEHOLDER)
  );
}

/**
 * Substitute the placeholder with a live public base URL.
 *
 * This is the gateway's job in production; it lives here so the contract
 * and its inverse are defined together, and so tests can round-trip a URL
 * without standing up a gateway. Returns the input unchanged when no
 * placeholder is present.
 */
export function substitutePublicBaseUrl(
  value: string,
  publicBaseUrl: string,
): string {
  const trimmed = publicBaseUrl.replace(/\/+$/, "");
  return value
    .replaceAll(PUBLIC_BASE_WSS_PLACEHOLDER, toWebSocketBaseUrl(trimmed))
    .replaceAll(PUBLIC_BASE_URL_PLACEHOLDER, trimmed);
}
