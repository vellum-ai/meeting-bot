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

/** Headers for authenticated Recall Bot API requests. */
export function recallAuthHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: apiKey,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}
