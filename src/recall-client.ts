/**
 * Recall.ai REST client — the thin slice of the Bot API the plugin calls.
 *
 * Recall owns the hard part: spinning up a browser, joining the conference
 * (Meet / Zoom / Teams / …), recording, and streaming realtime events back to
 * the endpoint the plugin registers. The plugin only needs to:
 *
 *   - create a bot pointed at a meeting URL, wired to the realtime WebSocket
 *     endpoint and (optionally) a transcription provider, and
 *   - ask a bot to leave.
 *
 * All calls are region-scoped and authenticated with the workspace API key in
 * the `Authorization` header, matching the Recall Create-Bot reference. The key
 * is resolved from the environment per call (see `resolveApiKey`) rather than
 * read from config, so the secret never lives in `config.json`.
 */

import {
  realtimeEndpointUrl,
  recallApiBase,
  resolveApiKey,
  type MeetingBotConfig,
} from "./config.ts";

/** Minimal shape of a Recall bot as returned by the Bot API. */
export interface RecallBot {
  id: string;
  /** Coarse status label, when present (e.g. "joining_call", "in_call_recording"). */
  status_code?: string;
  [key: string]: unknown;
}

export class RecallApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "RecallApiError";
  }
}

function authHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: apiKey,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

/**
 * Build the `recording_config` for a Create-Bot request from plugin config.
 *
 * Always registers the realtime WebSocket endpoint (that is the whole point of
 * this plugin); adds a streaming transcript provider unless transcription is
 * disabled.
 */
function buildRecordingConfig(config: MeetingBotConfig): Record<string, unknown> {
  const recording: Record<string, unknown> = {
    realtime_endpoints: [
      {
        type: "websocket",
        url: realtimeEndpointUrl(config),
        events: config.events,
      },
    ],
  };

  if (config.transcript.provider === "recallai_streaming") {
    recording.transcript = {
      provider: {
        recallai_streaming: {
          mode: config.transcript.mode,
          language_code: config.transcript.languageCode,
        },
      },
    };
  }

  return recording;
}

/**
 * Create a bot and send it to `meetingUrl`. Returns the created bot (its `id`
 * is the handle used for later leave calls and for correlating inbound
 * realtime events).
 *
 * Note: Recall may answer a last-minute create with HTTP 507 ("no capacity").
 * The docs recommend retrying 507s every 30s for up to 10 attempts; that retry
 * policy is intentionally left to the caller so it can surface progress.
 */
export async function createBot(
  config: MeetingBotConfig,
  meetingUrl: string,
  opts: { botName?: string; metadata?: Record<string, unknown> } = {},
): Promise<RecallBot> {
  const body: Record<string, unknown> = {
    meeting_url: meetingUrl,
    recording_config: buildRecordingConfig(config),
  };
  if (opts.botName) body.bot_name = opts.botName;
  if (opts.metadata) body.metadata = opts.metadata;

  const res = await fetch(`${recallApiBase(config.region)}bot/`, {
    method: "POST",
    headers: authHeaders(resolveApiKey(config)),
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new RecallApiError(
      `create bot failed (${res.status})`,
      res.status,
      text,
    );
  }
  return JSON.parse(text) as RecallBot;
}

/**
 * Ask a bot to leave its call. Idempotent from the caller's perspective: a bot
 * that already left may return a non-2xx, which is surfaced as an error for the
 * tool to report rather than swallowed.
 */
export async function leaveCall(
  config: MeetingBotConfig,
  botId: string,
): Promise<void> {
  const res = await fetch(
    `${recallApiBase(config.region)}bot/${encodeURIComponent(botId)}/leave_call/`,
    { method: "POST", headers: authHeaders(resolveApiKey(config)) },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new RecallApiError(
      `leave call failed (${res.status})`,
      res.status,
      text,
    );
  }
}

/** Fetch a bot's current server-side state. Useful for status polling. */
export async function getBot(
  config: MeetingBotConfig,
  botId: string,
): Promise<RecallBot> {
  const res = await fetch(
    `${recallApiBase(config.region)}bot/${encodeURIComponent(botId)}/`,
    { method: "GET", headers: authHeaders(resolveApiKey(config)) },
  );
  const text = await res.text();
  if (!res.ok) {
    throw new RecallApiError(`get bot failed (${res.status})`, res.status, text);
  }
  return JSON.parse(text) as RecallBot;
}
