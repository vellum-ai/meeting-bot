/**
 * Plugin configuration — schema, defaults, and resolution.
 *
 * The host hands the plugin its parsed config as `InitContext.config` (an
 * `unknown`). This module owns the single Zod schema that validates and
 * defaults it, plus the small amount of derived state (the Recall region base
 * URL, the realtime endpoint URL Recall connects back to) that the hooks and
 * tools read.
 *
 * ## What the operator must supply
 *
 *   - `publicWsUrl` — the stable, publicly reachable base URL Recall dials
 *                     back into over WebSocket for realtime events (e.g. a
 *                     static ngrok `wss://…` URL in dev, or the deployment's
 *                     ingress in prod). The plugin's own WebSocket server must
 *                     be reachable at this address.
 *
 * The Recall API key is deliberately *not* a config field. Config carries only
 * the credential's *name* (`apiKeyCredential`, default `recall:api_key`) so the
 * secret itself can live in the secure credential store / CES rather than as
 * plaintext in `config.json`. It is resolved from the environment at call time
 * (see {@link resolveApiKey}); the host provisions the secret into that env
 * from the credential store. Because the name defaults to `recall:api_key`, an
 * operator storing the key under that default name needs no config for it at
 * all — `config.json` then holds nothing sensitive.
 *
 * Everything else has a working default. The realtime server binds locally on
 * `listenHost:listenPort`; a reverse proxy / tunnel maps `publicWsUrl` onto it.
 */

import { z } from "zod";

/**
 * Recall.ai regional deployments. Each region is a distinct base host of the
 * form `https://<region>.recall.ai`. The workspace API key is region-scoped,
 * so the region must match the key. See "Regions and Base URLs" in the Recall
 * docs.
 */
export const RECALL_REGIONS = [
  "us-east-1",
  "us-west-2",
  "eu-central-1",
  "ap-northeast-1",
] as const;

export type RecallRegion = (typeof RECALL_REGIONS)[number];

/**
 * Realtime event kinds the plugin can subscribe the bot to. Recall pushes
 * these over the WebSocket connection it opens to `publicWsUrl`. The default
 * set is transcript-only — the smallest useful stream for a note-taker. Audio
 * and video buffer events exist too (`audio_mixed_raw.data`, etc.) but are
 * heavier and off by default.
 */
export const REALTIME_EVENTS = [
  "transcript.data",
  "transcript.partial_data",
  "participant_events.join",
  "participant_events.leave",
  "participant_events.speech_on",
  "participant_events.speech_off",
  "participant_events.chat_message",
] as const;

export type RealtimeEvent = (typeof REALTIME_EVENTS)[number];

export const MeetingBotConfigSchema = z
  .object({
    apiKeyCredential: z
      .string()
      .regex(
        /^[^\s:]+:[^\s:]+$/,
        "must be a credential name of the form 'service:field' (e.g. recall:api_key)",
      )
      .default("recall:api_key")
      .describe(
        "Name of the credential holding the Recall.ai workspace API key, in 'service:field' form. The secret itself is NOT stored here — it lives in the secure credential store / CES and is resolved from the environment at call time. Defaults to 'recall:api_key'; only set this when the key is stored under a different name.",
      ),
    region: z
      .enum(RECALL_REGIONS)
      .default("us-east-1")
      .describe(
        "Recall.ai region. Must match the region the API key was minted in.",
      ),
    publicWsUrl: z
      .string()
      .url()
      .optional()
      .describe(
        "Stable public base URL (ws:// or wss://) Recall dials back into for realtime events. Maps to the plugin's realtime server via a tunnel or ingress. Example: wss://your-app.ngrok.app. When omitted, the plugin auto-provisions a Cloudflare Tunnel at init time (see src/inbound.ts).",
      ),
    listenHost: z
      .string()
      .default("127.0.0.1")
      .describe("Host the plugin's realtime WebSocket server binds to."),
    listenPort: z
      .number()
      .int()
      .min(0)
      .max(65535)
      .default(8790)
      .describe(
        "Port the plugin's realtime WebSocket server listens on. 0 selects an ephemeral port.",
      ),
    verificationToken: z
      .string()
      .default("")
      .describe(
        "Shared secret appended to the realtime endpoint URL as ?token=… and checked on each inbound connection. When empty, connection-token verification is skipped (not recommended outside local dev).",
      ),
    events: z
      .array(z.enum(REALTIME_EVENTS))
      .default([
        "transcript.data",
        "participant_events.join",
        "participant_events.leave",
      ])
      .describe("Realtime events the bot is subscribed to."),
    transcript: z
      .object({
        provider: z
          .enum(["recallai_streaming", "none"])
          .default("recallai_streaming")
          .describe(
            "Streaming transcription provider. 'recallai_streaming' uses Recall's built-in low-latency STT; 'none' disables transcription (e.g. audio-only pipelines).",
          ),
        languageCode: z
          .string()
          .default("en")
          .describe("BCP-47 language hint for the transcription provider."),
        mode: z
          .enum(["prioritize_low_latency", "prioritize_accuracy"])
          .default("prioritize_low_latency")
          .describe("Latency/accuracy tradeoff for the streaming provider."),
      })
      .default({
        provider: "recallai_streaming",
        languageCode: "en",
        mode: "prioritize_low_latency",
      }),
    tts: z
      .object({
        endpoint: z
          .string()
          .url()
          .optional()
          .describe(
            "Override the TTS synthesis endpoint. Defaults to the daemon's internal HTTP endpoint derived from RUNTIME_HTTP_PORT (or http://127.0.0.1:7821).",
          ),
        authToken: z
          .string()
          .optional()
          .describe(
            "Bearer token for the TTS endpoint when HTTP auth is enabled. Not needed when DISABLE_HTTP_AUTH is set (dev / QA).",
          ),
      })
      .optional()
      .describe(
        "Text-to-speech configuration for voice responses. When omitted, the plugin uses the daemon's internal TTS endpoint without auth.",
      ),
  })
  .describe(
    "Recall.ai meeting-bot configuration — the API-key credential name, region, the realtime WebSocket callback URL, and transcription settings.",
  );

export type MeetingBotConfig = z.infer<typeof MeetingBotConfigSchema>;

export interface ConfigResolution {
  config: MeetingBotConfig;
  /** Non-fatal validation notes worth surfacing to the operator. */
  warnings: string[];
}

/**
 * Validate and default the host-supplied config. Throws a descriptive error
 * when `publicWsUrl` is missing, since the plugin cannot receive events without
 * it. The API key is not validated here — it is resolved separately from the
 * environment at call time (see {@link resolveApiKey}), so a misconfigured or
 * absent credential surfaces as a clear tool-time error rather than blocking
 * the realtime receiver from starting.
 */
export function resolveConfig(raw: unknown): ConfigResolution {
  const parsed = MeetingBotConfigSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`meeting-bot: invalid plugin config — ${detail}`);
  }

  const config = parsed.data;
  const warnings: string[] = [];

  if (!config.verificationToken) {
    warnings.push(
      "verificationToken is empty — inbound realtime connections will not be authenticated. Set one outside local development.",
    );
  }
  if (config.publicWsUrl?.startsWith("ws://")) {
    warnings.push(
      "publicWsUrl uses insecure ws://. Recall recommends wss:// for anything beyond local development.",
    );
  }
  if (!config.publicWsUrl) {
    warnings.push(
      "publicWsUrl is not set — the plugin will auto-provision a Cloudflare Tunnel at init time. This is insecure and intended for development only. Set publicWsUrl explicitly for production deployments.",
    );
  }

  return { config, warnings };
}

/** Base URL for the region's Recall REST API, with a trailing slash. */
export function recallApiBase(region: RecallRegion): string {
  return `https://${region}.recall.ai/api/v1/`;
}

/**
 * Map a `service:field` credential name to the environment variable the secret
 * is expected under: `recall:api_key` → `RECALL_API_KEY`. Non-alphanumeric
 * separators (`:`, `-`, `.`, `/`) collapse to `_` and the whole name is
 * upper-cased, matching the conventional env-var shape a host injects a
 * credential-store value into.
 */
export function credentialEnvVar(credentialName: string): string {
  return credentialName.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase();
}

/**
 * Resolve the Recall API key from the environment.
 *
 * The secret is never read from `config.json`; config only names the credential
 * ({@link MeetingBotConfig.apiKeyCredential}, default `recall:api_key`). The
 * host provisions that credential's value into the process environment from the
 * secure credential store / CES, under the {@link credentialEnvVar}-derived
 * name. Resolving at call time (rather than caching at init) means a rotated
 * key is picked up and the plaintext is never stashed in plugin state.
 *
 * Throws a descriptive error naming both the credential and the expected env
 * var when the value is absent — the caller (a tool) surfaces that to the user.
 */
export function resolveApiKey(config: MeetingBotConfig): string {
  const envVar = credentialEnvVar(config.apiKeyCredential);
  const value = (process.env[envVar] ?? "").trim();
  if (!value) {
    throw new Error(
      `Recall API key not found. The credential "${config.apiKeyCredential}" must be provisioned into the environment as ${envVar} ` +
        `(the host injects it from the secure credential store / CES). It is intentionally never stored in config.json.`,
    );
  }
  return value;
}

/**
 * Build the realtime endpoint URL handed to Recall in the Create-Bot request.
 *
 * Recall connects to this exact URL, query string included. Per the Recall
 * docs, a trailing `/` must precede any query parameters or the request is
 * rejected with HTTP 400 — so the token (when present) is appended after a
 * normalized trailing slash.
 */
export function realtimeEndpointUrl(config: MeetingBotConfig): string {
  if (!config.publicWsUrl) {
    throw new Error(
      "meeting-bot: publicWsUrl is not set. The init hook should have provisioned a tunnel — this likely means setupInbound failed or was skipped.",
    );
  }
  const base = config.publicWsUrl.replace(/\/+$/, "");
  const withSlash = `${base}/`;
  if (!config.verificationToken) return withSlash;
  return `${withSlash}?token=${encodeURIComponent(config.verificationToken)}`;
}
