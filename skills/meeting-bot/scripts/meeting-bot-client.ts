#!/usr/bin/env bun
/**
 * meeting-bot-client.ts - Shared helper for meeting-bot skill scripts.
 *
 * Resolves the Recall API key from the Vellum credential store at runtime
 * via `assistant credentials reveal`. No hardcoded keys, no env vars.
 *
 * Also reads the plugin's resolved config (written by the init hook) to
 * get the region, publicWsUrl, events, and transcript settings.
 *
 * Usage from other scripts:
 *   import { getApiKey, getResolvedConfig, recallApiBase, createBot, leaveCall } from "./meeting-bot-client.ts";
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Credential service/field for the Recall API key. */
const CREDENTIAL_SERVICE = "meeting-bot";
const CREDENTIAL_FIELD = "api_key";

/**
 * Resolve the Recall API key from the credential store.
 * Throws a helpful error if no credential is stored.
 */
export function getApiKey(): string {
  try {
    const key = execSync(
      `assistant credentials reveal --service ${CREDENTIAL_SERVICE} --field ${CREDENTIAL_FIELD}`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
    if (!key) throw new Error("empty credential");
    return key;
  } catch {
    throw new Error(
      "No Recall API key found in the credential store. " +
        `Store one with: assistant credentials set --service ${CREDENTIAL_SERVICE} --field ${CREDENTIAL_FIELD} <your_key>\n` +
        "Get a key at https://recall.ai/dashboard",
    );
  }
}

/**
 * Find the plugin's data directory by walking up from this script's location.
 *
 * The script lives at <plugin-root>/skills/meeting-bot/scripts/meeting-bot-client.ts.
 * The data directory is at <plugin-root>/data/.
 */
function findPluginDataDir(): string {
  const scriptDir = dirname(new URL(".", import.meta.url).pathname);
  // From skills/meeting-bot/scripts/ go up 3 levels to plugin root
  const pluginRoot = resolve(scriptDir, "..", "..", "..");
  const dataDir = join(pluginRoot, "data");
  if (!existsSync(dataDir)) {
    throw new Error(
      `Plugin data directory not found at ${dataDir}. Ensure the meeting-bot plugin is installed and has been initialized.`,
    );
  }
  return dataDir;
}

/** Path to the resolved config file (written by the init hook). */
function resolvedConfigPath(): string {
  return join(findPluginDataDir(), "resolved-config.json");
}

/** Path to the sessions file (written by join script, read by plugin + leave script). */
export function sessionsFilePath(): string {
  return join(findPluginDataDir(), "sessions.json");
}

export interface ResolvedConfig {
  region: string;
  publicWsUrl: string;
  listenHost: string;
  listenPort: number;
  events: string[];
  verificationToken: string;
  transcript: {
    provider: string;
    languageCode: string;
    mode: string;
  };
}

/**
 * Read the resolved config written by the init hook.
 * Throws if the plugin has not been initialized.
 */
export function getResolvedConfig(): ResolvedConfig {
  const path = resolvedConfigPath();
  if (!existsSync(path)) {
    throw new Error(
      "meeting-bot plugin has not been initialized. The init hook writes resolved-config.json on startup. " +
        "Ensure the plugin is installed and the daemon is running.",
    );
  }
  const raw = readFileSync(path, "utf-8");
  return JSON.parse(raw) as ResolvedConfig;
}

/** Base URL for the region's Recall REST API, with a trailing slash. */
export function recallApiBase(region: string): string {
  return `https://${region}.recall.ai/api/v1/`;
}

/** Minimal shape of a Recall bot as returned by the Bot API. */
export interface RecallBot {
  id: string;
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

// Minimal silent MP3 frame to unlock the output_audio endpoint.
const SILENT_MP3_B64 =
  "//uQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function buildRecordingConfig(config: ResolvedConfig): Record<string, unknown> {
  const recording: Record<string, unknown> = {
    realtime_endpoints: [
      {
        type: "websocket",
        url: config.publicWsUrl.replace(/\/+$/, "") + "/",
        events: config.events,
      },
    ],
  };

  if (config.transcript?.provider === "recallai_streaming") {
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
 * Create a bot and send it to the meeting URL.
 * Returns the created bot (its `id` is the handle for later leave calls).
 */
export async function createBot(
  config: ResolvedConfig,
  meetingUrl: string,
  opts: { botName?: string } = {},
): Promise<RecallBot> {
  const apiKey = getApiKey();
  const body: Record<string, unknown> = {
    meeting_url: meetingUrl,
    recording_config: buildRecordingConfig(config),
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

  const res = await fetch(`${recallApiBase(config.region)}bot/`, {
    method: "POST",
    headers: authHeaders(apiKey),
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new RecallApiError(`create bot failed (${res.status})`, res.status, text);
  }
  return JSON.parse(text) as RecallBot;
}

/**
 * Ask a bot to leave its call.
 */
export async function leaveCall(
  config: ResolvedConfig,
  botId: string,
): Promise<void> {
  const apiKey = getApiKey();
  const res = await fetch(
    `${recallApiBase(config.region)}bot/${encodeURIComponent(botId)}/leave_call/`,
    { method: "POST", headers: authHeaders(apiKey) },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new RecallApiError(`leave call failed (${res.status})`, res.status, text);
  }
}

// --- Session file management ---

export interface SessionEntry {
  botId: string;
  meetingUrl: string;
  conversationId: string | null;
  startedAt: number;
}

/** Read all sessions from the sessions file. Returns an empty array if the file does not exist. */
export function readSessions(): SessionEntry[] {
  const path = sessionsFilePath();
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as SessionEntry[];
  } catch {
    return [];
  }
}

/** Write sessions to the sessions file. */
export function writeSessions(sessions: SessionEntry[]): void {
  writeFileSync(sessionsFilePath(), JSON.stringify(sessions, null, 2), "utf-8");
}

/** Add a session to the file. */
export function addSession(entry: SessionEntry): void {
  const sessions = readSessions().filter((s) => s.botId !== entry.botId);
  sessions.push(entry);
  writeSessions(sessions);
}

/** Remove a session from the file by bot id. */
export function removeSession(botId: string): void {
  const sessions = readSessions().filter((s) => s.botId !== botId);
  writeSessions(sessions);
}
