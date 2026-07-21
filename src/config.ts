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
 * The Recall API key is deliberately *not* a config field, nor is the
 * credential's name configurable: the plugin always resolves the key from a
 * single fixed credential (`meeting-bot:api_key`) so the secret lives in the
 * secure credential store rather than as plaintext in `config.json`. It is
 * resolved at call time via the host's in-process `resolveCredential` (see
 * {@link resolveApiKey}); the `meeting-bot-setup` skill guides the user through
 * storing the key.
 *
 * Everything else has a working default. The realtime server binds locally on
 * `listenHost:listenPort`; a reverse proxy / tunnel maps `publicWsUrl` onto it.
 */

import { z } from "zod";
import { resolveCredential } from "@vellumai/plugin-api";

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

/**
 * Meeting-bot provider options. Chooses which backend the bot uses:
 * "recall" (Recall.ai drives the browser and streams realtime events back)
 * or "vellum" (the in-house meet bot vendored under meet/ joins the call and
 * streams events through the local ingress). Editable from the configuration
 * app; consumed by the init hook and the join/leave skill scripts.
 */
export const MEETING_PROVIDERS = ["recall", "vellum"] as const;
export type MeetingProvider = (typeof MEETING_PROVIDERS)[number];

export const MeetingBotConfigSchema = z
  .object({
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
    useVoiceMode: z
      .boolean()
      .default(false)
      .describe(
        "How the bot's voice responses are produced: when true, use the host's new `createLiveVoiceConnection` live-voice API; when false (default), use the existing text-to-speech + Recall `output_audio` path. Temporary flag until `createLiveVoiceConnection` is stable enough to rely on full time, at which point this config is removed. Editable from the configuration app.",
      ),
    outputAudio: z
      .boolean()
      .default(false)
      .describe(
        "When true, the bot may output audio (speak) in the meeting; when false (default), it only listens and transcribes. Defined for a future change and not consumed yet.",
      ),
    provider: z
      .enum(MEETING_PROVIDERS)
      .default("recall")
      .describe(
        "Which meeting provider the bot uses: 'recall' (Recall.ai, the default) or 'vellum' (the in-house meet bot). Selected at plugin load; editable from the configuration app and picked up on the next reload.",
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
 * The fixed credential holding the Recall API key: service `meeting-bot`, field
 * `api_key`. This is not configurable: the plugin always resolves the key from
 * this one credential. Keep in sync with the standalone skill client
 * (`skills/meeting-bot/scripts/meeting-bot-client.ts`), which hardcodes the same
 * service/field.
 */
export const CREDENTIAL_SERVICE = "meeting-bot";
export const CREDENTIAL_FIELD = "api_key";

/**
 * Resolve the Recall API key from the credential store.
 *
 * Uses the host's in-process `resolveCredential` rather than shelling out to
 * `assistant credentials reveal`. The CLI path deadlocks the daemon: it runs
 * inside the event loop (e.g. from the `init` hook), and a synchronous
 * `execSync` blocks the loop while the spawned CLI tries to reach the daemon
 * over IPC to fetch the credential, which the daemon cannot service while
 * blocked, so it stalls until the CLI's IPC times out (~60s).
 * `resolveCredential` stays in-process and yields, so the loop keeps running.
 *
 * Resolving at call time (rather than caching at init) means a rotated key is
 * picked up immediately. The key is never read from `config.json` or an
 * environment variable. Throws a descriptive error naming the credential when
 * the value is absent.
 *
 * Note: the standalone skill scripts (join/leave) still shell out via
 * `assistant credentials reveal`; they run in their own process, not the
 * daemon, so blocking there does not stall the event loop.
 */
export async function resolveApiKey(): Promise<string> {
  try {
    // `resolveCredential` takes a `service/field` reference (slash-separated).
    const value = (
      await resolveCredential(`${CREDENTIAL_SERVICE}/${CREDENTIAL_FIELD}`)
    ).trim();
    if (!value) throw new Error("empty credential");
    return value;
  } catch {
    throw new Error(
      `Recall API key not found. The credential "${CREDENTIAL_SERVICE}:${CREDENTIAL_FIELD}" must be stored in the credential store. ` +
        `Run: assistant credentials set --service ${CREDENTIAL_SERVICE} --field ${CREDENTIAL_FIELD} <your_key>\n` +
        `Get a key at https://recall.ai/dashboard`,
    );
  }
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
