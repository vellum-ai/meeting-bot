/**
 * In-memory session store — the plugin's view of live meetings.
 *
 * Keyed by Recall bot id, each session holds the meeting URL, a rolling
 * transcript buffer, and the current participant set. Realtime events from the
 * WebSocket receiver mutate the matching session; tools read it (e.g. to return
 * a transcript snapshot or confirm a bot is live).
 *
 * This is deliberately process-local and non-durable: it is the "what's
 * happening right now" cache, not the system of record. Recall retains the
 * authoritative recording and transcript, which can be fetched after the call.
 * A future revision can persist sessions or forward events into a conversation;
 * for the initial scaffold, an in-memory map is enough to prove the pipe.
 */

import type {
  NormalizedParticipantEvent,
  NormalizedUtterance,
} from "./realtime-events.ts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MeetingBotConfig } from "./config.ts";
import { pluginDataDir } from "./plugin-paths.ts";

export interface TranscriptLine {
  at: number;
  speaker: string;
  text: string;
}

export interface MeetingSession {
  botId: string;
  meetingUrl: string;
  conversationId: string | null;
  startedAt: number;
  transcript: TranscriptLine[];
  participants: Map<string, string>;
  /**
   * Which provider runs this session's bot. "recall" (default) sessions may
   * speak via Recall's output_audio; "vellum" sessions are driven by the
   * in-house meet bot and skip the Recall voice path.
   */
  provider?: "recall" | "vellum";
}

/** Cap the in-memory transcript so a long meeting cannot grow unbounded. */
const MAX_TRANSCRIPT_LINES = 5_000;

const sessions = new Map<string, MeetingSession>();

export function openSession(
  botId: string,
  meetingUrl: string,
  conversationId: string | null = null,
  provider: "recall" | "vellum" = "recall",
): MeetingSession {
  const session: MeetingSession = {
    botId,
    meetingUrl,
    conversationId,
    startedAt: Date.now(),
    transcript: [],
    participants: new Map(),
    provider,
  };
  sessions.set(botId, session);
  return session;
}

export function getSession(botId: string): MeetingSession | undefined {
  // If the session is not in memory, try loading from the sessions file.
  // The join script writes sessions.json; the realtime server may not have
  // synced yet if the bot was just created.
  if (!sessions.has(botId)) {
    syncSessionsFromFile();
  }
  return sessions.get(botId);
}

export function listSessions(): MeetingSession[] {
  return [...sessions.values()];
}

export function closeSession(botId: string): void {
  sessions.delete(botId);
}

/**
 * Append a finalized utterance to the matching session's transcript. Partial
 * utterances are ignored here — they churn too fast to be worth buffering; a
 * live-captions consumer would subscribe to the raw event stream instead.
 *
 * When the utterance carries no bot id (some payloads omit it) and exactly one
 * session is active, it is attributed to that session.
 */
export function recordUtterance(u: NormalizedUtterance): void {
  if (u.isPartial) return;
  const session = resolveSession(u.botId);
  if (!session) return;

  session.transcript.push({
    at: Date.now(),
    speaker: u.speakerName ?? u.speakerId ?? "unknown",
    text: u.text,
  });
  if (session.transcript.length > MAX_TRANSCRIPT_LINES) {
    session.transcript.splice(0, session.transcript.length - MAX_TRANSCRIPT_LINES);
  }
}

/** Apply a participant lifecycle event to the matching session's roster. */
export function recordParticipantEvent(e: NormalizedParticipantEvent): void {
  const session = resolveSession(e.botId);
  if (!session) return;

  const id = e.participantId ?? e.participantName;
  if (!id) return;

  if (e.action === "join") {
    session.participants.set(id, e.participantName ?? id);
  } else if (e.action === "leave") {
    session.participants.delete(id);
  }
}

/**
 * Load sessions from the sessions.json file written by the join script.
 *
 * The join script runs as a standalone bun process and writes session
 * metadata (botId, meetingUrl, conversationId) to a JSON file in the
 * plugin's data directory. This function reads that file and populates the
 * in-memory sessions map so the realtime server can correlate incoming
 * events with conversations. Existing in-memory sessions are preserved
 * (they may have transcript data the file does not carry).
 */
export function loadSessionsFromFile(config: MeetingBotConfig): void {
  // Derive the plugin data directory from the config's publicWsUrl is not
  // possible. Instead, use the pluginStorageDir pattern: the sessions file
  // lives at <plugin-root>/data/sessions.json. We resolve it relative to
  // this module: src/ -> ../data/sessions.json
  const moduleDir = new URL(".", import.meta.url).pathname;
  const pluginRoot = join(moduleDir, "..");
  const sessionsPath = join(pluginRoot, "data", "sessions.json");

  if (!existsSync(sessionsPath)) return;

  try {
    const raw = readFileSync(sessionsPath, "utf-8");
    const fileSessions = JSON.parse(raw) as Array<{
      botId: string;
      meetingUrl: string;
      conversationId: string | null;
      startedAt: number;
      provider?: "recall" | "vellum";
    }>;

    for (const fs of fileSessions) {
      // Only add sessions not already in memory (in-memory sessions have
      // live transcript data we don't want to lose).
      if (!sessions.has(fs.botId)) {
        sessions.set(fs.botId, {
          botId: fs.botId,
          meetingUrl: fs.meetingUrl,
          conversationId: fs.conversationId,
          startedAt: fs.startedAt,
          transcript: [],
          participants: new Map(),
          provider: fs.provider ?? "recall",
        });
      } else {
        // Update conversationId in case it was set after the session was
        // created in memory.
        const existing = sessions.get(fs.botId)!;
        if (!existing.conversationId && fs.conversationId) {
          existing.conversationId = fs.conversationId;
        }
      }
    }
  } catch {
    // best-effort — if the file is malformed, skip
  }
}

/**
 * Sync sessions from the sessions.json file (config-less variant).
 * Derives the path from this module's location: src/ -> ../data/sessions.json.
 */
function syncSessionsFromFile(): void {
  const moduleDir = new URL(".", import.meta.url).pathname;
  const pluginRoot = join(moduleDir, "..");
  const sessionsPath = join(pluginRoot, "data", "sessions.json");

  if (!existsSync(sessionsPath)) return;

  try {
    const raw = readFileSync(sessionsPath, "utf-8");
    const fileSessions = JSON.parse(raw) as Array<{
      botId: string;
      meetingUrl: string;
      conversationId: string | null;
      startedAt: number;
      provider?: "recall" | "vellum";
    }>;

    for (const fs of fileSessions) {
      if (!sessions.has(fs.botId)) {
        sessions.set(fs.botId, {
          botId: fs.botId,
          meetingUrl: fs.meetingUrl,
          conversationId: fs.conversationId,
          startedAt: fs.startedAt,
          transcript: [],
          participants: new Map(),
          provider: fs.provider ?? "recall",
        });
      } else {
        const existing = sessions.get(fs.botId)!;
        if (!existing.conversationId && fs.conversationId) {
          existing.conversationId = fs.conversationId;
        }
      }
    }
  } catch {
    // best-effort
  }
}

/**
 * Resolve the session an event belongs to. Prefers the explicit bot id; falls
 * back to the sole active session when the id is absent and there is no
 * ambiguity.
 */
function resolveSession(botId?: string): MeetingSession | undefined {
  if (botId) {
    if (!sessions.has(botId)) syncSessionsFromFile();
    return sessions.get(botId);
  }
  if (sessions.size === 0) syncSessionsFromFile();
  if (sessions.size === 1) return [...sessions.values()][0];
  return undefined;
}

// --- Daemon-side persistence into sessions.json -----------------------------
//
// The Recall join script (a standalone bun process) writes sessions.json
// itself. Vellum-provider joins happen in-daemon (the session manager spawns
// the bot), so the daemon needs its own writers for the same file to keep the
// leave script and the dashboard's meeting history working across providers.

/** Shape of one entry in data/sessions.json (matches the skill client's). */
export interface PersistedSessionEntry {
  botId: string;
  meetingUrl: string;
  conversationId: string | null;
  startedAt: number;
  provider?: "recall" | "vellum";
}

function sessionsFilePath(): string {
  return join(pluginDataDir(), "sessions.json");
}

function readPersistedSessions(): PersistedSessionEntry[] {
  const path = sessionsFilePath();
  if (!existsSync(path)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return Array.isArray(parsed) ? (parsed as PersistedSessionEntry[]) : [];
  } catch {
    return [];
  }
}

/** Add (or replace) a session entry in data/sessions.json. */
export function persistSessionEntry(entry: PersistedSessionEntry): void {
  mkdirSync(pluginDataDir(), { recursive: true });
  const entries = readPersistedSessions().filter((e) => e.botId !== entry.botId);
  entries.push(entry);
  writeFileSync(sessionsFilePath(), JSON.stringify(entries, null, 2), "utf-8");
}

/** Remove a session entry from data/sessions.json by bot/meeting id. */
export function removePersistedSession(botId: string): void {
  const entries = readPersistedSessions().filter((e) => e.botId !== botId);
  if (!existsSync(sessionsFilePath())) return;
  writeFileSync(sessionsFilePath(), JSON.stringify(entries, null, 2), "utf-8");
}
