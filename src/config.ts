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
 *   - `apiKey`      — the Recall.ai workspace API key. Used as the
 *                     `Authorization` header on every Create-Bot / leave call.
 *   - `publicWsUrl` — the stable, publicly reachable base URL Recall dials
 *                     back into over WebSocket for realtime events (e.g. a
 *                     static ngrok `wss://…` URL in dev, or the deployment's
 *                     ingress in prod). The plugin's own WebSocket server must
 *                     be reachable at this address.
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
    apiKey: z
      .string()
      .min(1)
      .describe(
        "Recall.ai workspace API key. Sent as the Authorization header on Create-Bot and leave-call requests.",
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
      .describe(
        "Stable public base URL (ws:// or wss://) Recall dials back into for realtime events. Maps to the plugin's realtime server via a tunnel or ingress. Example: wss://your-app.ngrok.app",
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
  })
  .describe(
    "Recall.ai meeting-bot configuration — API credentials, region, the realtime WebSocket callback URL, and transcription settings.",
  );

export type MeetingBotConfig = z.infer<typeof MeetingBotConfigSchema>;

export interface ConfigResolution {
  config: MeetingBotConfig;
  /** Non-fatal validation notes worth surfacing to the operator. */
  warnings: string[];
}

/**
 * Validate and default the host-supplied config. Throws a descriptive error
 * when required fields (`apiKey`, `publicWsUrl`) are missing, since the plugin
 * cannot create bots or receive events without them.
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
  if (config.publicWsUrl.startsWith("ws://")) {
    warnings.push(
      "publicWsUrl uses insecure ws://. Recall recommends wss:// for anything beyond local development.",
    );
  }

  return { config, warnings };
}

/** Base URL for the region's Recall REST API, with a trailing slash. */
export function recallApiBase(region: RecallRegion): string {
  return `https://${region}.recall.ai/api/v1/`;
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
  const base = config.publicWsUrl.replace(/\/+$/, "");
  const withSlash = `${base}/`;
  if (!config.verificationToken) return withSlash;
  return `${withSlash}?token=${encodeURIComponent(config.verificationToken)}`;
}
