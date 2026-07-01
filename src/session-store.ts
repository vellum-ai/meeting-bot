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

export interface TranscriptLine {
  at: number;
  speaker: string;
  text: string;
}

export interface MeetingSession {
  botId: string;
  meetingUrl: string;
  startedAt: number;
  transcript: TranscriptLine[];
  participants: Map<string, string>;
}

/** Cap the in-memory transcript so a long meeting cannot grow unbounded. */
const MAX_TRANSCRIPT_LINES = 5_000;

const sessions = new Map<string, MeetingSession>();

export function openSession(botId: string, meetingUrl: string): MeetingSession {
  const session: MeetingSession = {
    botId,
    meetingUrl,
    startedAt: Date.now(),
    transcript: [],
    participants: new Map(),
  };
  sessions.set(botId, session);
  return session;
}

export function getSession(botId: string): MeetingSession | undefined {
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
 * Resolve the session an event belongs to. Prefers the explicit bot id; falls
 * back to the sole active session when the id is absent and there is no
 * ambiguity.
 */
function resolveSession(botId?: string): MeetingSession | undefined {
  if (botId) return sessions.get(botId);
  if (sessions.size === 1) return [...sessions.values()][0];
  return undefined;
}
