/**
 * Text-to-speech synthesis via the daemon's internal TTS endpoint.
 *
 * The plugin runs inside the daemon process, so it can call the daemon's HTTP
 * API on localhost to synthesize speech using the globally configured TTS
 * provider (ElevenLabs, Fish Audio, etc.). This avoids duplicating TTS config
 * and credential management in the plugin — the daemon already knows the
 * provider, voice ID, and API key.
 *
 * The endpoint used is `POST /v1/tts/synthesize-cli`, which returns
 * `{ audioBase64, contentType }` — base64-encoded audio ready to be forwarded
 * to Recall's `output_audio` endpoint.
 *
 * When `DISABLE_HTTP_AUTH` is set (dev / QA), no auth header is needed. In
 * production, an auth token must be provided via the `ttsAuthToken` config
 * field.
 */

import type { MeetingBotConfig } from "./config.ts";

/** Response shape from the daemon's `/v1/tts/synthesize-cli` endpoint. */
interface TtsSynthesizeResponse {
  audioBase64: string;
  contentType: string;
}

/** Errors from the TTS synthesis path. */
export class TtsError extends Error {
  constructor(
    message: string,
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = "TtsError";
  }
}

/**
 * Resolve the daemon's TTS endpoint URL.
 *
 * Priority:
 *   1. Explicit `ttsEndpoint` in plugin config (production override).
 *   2. Derived from `RUNTIME_HTTP_PORT` env var (set by the daemon).
 *   3. Fallback to `http://127.0.0.1:7821` (the daemon's default port).
 */
function resolveTtsEndpoint(config: MeetingBotConfig): string {
  if (config.tts?.endpoint) return config.tts.endpoint;

  const port = process.env.RUNTIME_HTTP_PORT ?? "7821";
  return `http://127.0.0.1:${port}/v1/tts/synthesize-cli`;
}

/**
 * Synthesize text into speech using the daemon's configured TTS provider.
 *
 * Returns base64-encoded MP3 audio data, ready to be sent to Recall's
 * `output_audio` endpoint.
 *
 * @param text   The text to synthesize.
 * @param config Plugin config (may contain `tts.endpoint` / `tts.authToken`).
 * @returns Base64-encoded audio string.
 * @throws {TtsError} if the daemon is unreachable or returns an error.
 */
export async function synthesizeSpeech(
  text: string,
  config: MeetingBotConfig,
): Promise<string> {
  const endpoint = resolveTtsEndpoint(config);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.tts?.authToken) {
    headers["Authorization"] = `Bearer ${config.tts.authToken}`;
  }

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ text }),
    });
  } catch (err) {
    throw new TtsError(
      `TTS request failed: ${String(err).slice(0, 150)}`,
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new TtsError(
      `TTS synthesis failed (${res.status}): ${body.slice(0, 150)}`,
      res.status,
    );
  }

  const data = (await res.json()) as TtsSynthesizeResponse;
  if (!data.audioBase64) {
    throw new TtsError("TTS response missing audioBase64 field");
  }

  return data.audioBase64;
}
