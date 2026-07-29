/**
 * Pure builders for Recall.ai Bot API requests.
 *
 * Shared by the daemon-side join flow (`src/join-flow.ts`) and the skill
 * scripts' client (`skills/meeting-bot/scripts/meeting-bot-client.ts`), so
 * the recording config a dashboard-initiated join sends is byte-identical
 * to the one a skill-initiated join sends. Deliberately dependency-free:
 * the skill scripts run as standalone bun processes and must not pull the
 * plugin's runtime imports (zod, plugin-api) through this module.
 */

/**
 * Realtime events the bot is always subscribed to. Not configurable: the
 * plugin supports the full set.
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

/** Minimal silent MP3 frame to unlock the output_audio endpoint. */
export const SILENT_MP3_B64 =
  "//uQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

/** Transcript settings slice consumed by {@link buildCreateBotBody}. */
export interface RecallTranscriptSettings {
  provider: string;
  languageCode: string;
  mode: string;
}

/**
 * Build the JSON body for `POST <recall>/bot/`.
 *
 * `endpointUrl` is the exact realtime WebSocket URL Recall should connect
 * to; callers normalize it (trailing slash, optional token) before passing
 * it in. The transcript block is only attached for the
 * `recallai_streaming` provider, matching what Recall accepts.
 */
export function buildCreateBotBody(opts: {
  meetingUrl: string;
  endpointUrl: string;
  transcript?: RecallTranscriptSettings;
  botName?: string;
}): Record<string, unknown> {
  const recording: Record<string, unknown> = {
    realtime_endpoints: [
      {
        type: "websocket",
        url: opts.endpointUrl,
        events: REALTIME_EVENTS,
      },
    ],
  };

  if (opts.transcript?.provider === "recallai_streaming") {
    recording.transcript = {
      provider: {
        recallai_streaming: {
          mode: opts.transcript.mode,
          language_code: opts.transcript.languageCode,
        },
      },
    };
  }

  const body: Record<string, unknown> = {
    meeting_url: opts.meetingUrl,
    recording_config: recording,
    automatic_audio_output: {
      in_call_recording: {
        data: {
          kind: "mp3",
          b64_data: SILENT_MP3_B64,
        },
      },
    },
  };
  if (opts.botName) body.bot_name = opts.botName;
  return body;
}

/**
 * Thrown when the realtime endpoint URL cannot be built because the recall
 * path has nowhere for Recall to connect back to.
 *
 * Its own type so callers can turn it into their own kind of failure — the
 * daemon join flow answers 409, the skill scripts print it — without matching
 * on the message.
 */
export class MissingPublicWsUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingPublicWsUrlError";
  }
}

/**
 * Build the realtime endpoint URL handed to Recall in the Create-Bot request.
 *
 * Recall connects to this exact URL, query string included. Per the Recall
 * docs, a trailing `/` must precede any query parameters or the request is
 * rejected with HTTP 400 — so the token (when present) is appended after a
 * normalized trailing slash.
 *
 * Lives here, alongside {@link buildCreateBotBody}, because both the daemon
 * and the standalone skill scripts create bots and must send the same URL. The
 * scripts previously built it themselves and dropped the token, which the
 * realtime server then rejected.
 *
 * Throws {@link MissingPublicWsUrlError} rather than returning something
 * unusable: `publicWsUrl` is optional in config precisely because the plugin
 * normally provisions a tunnel at startup, so its absence here means that did
 * not happen and no bot should be created.
 */
export function realtimeEndpointUrl(config: {
  publicWsUrl?: string;
  verificationToken?: string;
}): string {
  if (!config.publicWsUrl) {
    throw new MissingPublicWsUrlError(
      "meeting-bot: the recall provider needs a publicly reachable URL for Recall to stream events back to, and publicWsUrl is not set. " +
        "Either set publicWsUrl in the plugin's config.json, or install cloudflared so the plugin can provision a tunnel at startup, " +
        'or switch the provider to "vellum", which joins calls itself and needs no public URL.',
    );
  }
  const base = config.publicWsUrl.replace(/\/+$/, "");
  const withSlash = `${base}/`;
  if (!config.verificationToken) return withSlash;
  return `${withSlash}?token=${encodeURIComponent(config.verificationToken)}`;
}

/** Headers for authenticated Recall Bot API requests. */
export function recallAuthHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: apiKey,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}
