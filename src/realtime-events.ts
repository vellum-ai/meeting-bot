/**
 * Realtime event parsing — the messages Recall pushes over the WebSocket.
 *
 * Recall frames every realtime message as JSON with a top-level `event`
 * discriminator and a nested `data` payload. The exact inner shape varies by
 * event kind and by transcription provider, so the schema here is deliberately
 * lenient: it pins the envelope (`event` + `data`) and passes the payload
 * through, then a set of defensive extractors pull out the handful of fields
 * the plugin acts on (utterance text, speaker, bot id).
 *
 * Keeping parsing tolerant means a provider adding fields, or a minor payload
 * reshape, never crashes the receiver — it just surfaces what it recognizes.
 */

import { z } from "zod";

/** Recall realtime envelope: `{ event: "<kind>", data: { … } }`. */
export const RealtimeMessageSchema = z
  .object({
    event: z.string(),
    data: z.record(z.string(), z.unknown()).default({}),
  })
  .passthrough();

export type RealtimeMessage = z.infer<typeof RealtimeMessageSchema>;

/** A single finalized (or partial) utterance, normalized for downstream use. */
export interface NormalizedUtterance {
  botId?: string;
  text: string;
  speakerName?: string;
  speakerId?: string;
  isPartial: boolean;
}

/** A participant lifecycle change, normalized. */
export interface NormalizedParticipantEvent {
  botId?: string;
  action: "join" | "leave" | "speech_on" | "speech_off" | "chat_message";
  participantName?: string;
  participantId?: string;
  /** Present for chat_message events. */
  message?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

/** Dig out the bot id from wherever Recall placed it in the payload. */
function extractBotId(data: Record<string, unknown>): string | undefined {
  const bot = asRecord(data.bot);
  const id = bot.id ?? data.bot_id;
  return typeof id === "string" ? id : undefined;
}

/**
 * Pull participant name/id from a participant sub-object, tolerating both the
 * `{ participant: { id, name } }` and flattened variants.
 */
function extractParticipant(source: Record<string, unknown>): {
  name?: string;
  id?: string;
} {
  const p = asRecord(source.participant);
  const name = p.name ?? source.participant_name;
  const rawId = p.id ?? source.participant_id;
  return {
    name: typeof name === "string" ? name : undefined,
    id: rawId === undefined || rawId === null ? undefined : String(rawId),
  };
}

/**
 * Extract a transcript utterance from a `transcript.data` /
 * `transcript.partial_data` message.
 *
 * Recall's streaming transcript payload carries a `words` array under
 * `data.data`; the utterance text is the concatenation of the word tokens.
 * Falls back to a plain `text` field when a provider supplies one directly.
 */
export function extractUtterance(
  msg: RealtimeMessage,
): NormalizedUtterance | null {
  const isPartial = msg.event === "transcript.partial_data";
  // The transcript payload is typically nested one level under `data.data`.
  const inner = asRecord(asRecord(msg.data).data);
  const source = Object.keys(inner).length > 0 ? inner : msg.data;

  let text = "";
  const words = source.words;
  if (Array.isArray(words)) {
    text = words
      .map((w) => (typeof w === "object" && w ? String(asRecord(w).text ?? "") : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  } else if (typeof source.text === "string") {
    text = source.text.trim();
  }

  if (!text) return null;

  const participant = extractParticipant(source);
  return {
    botId: extractBotId(msg.data),
    text,
    speakerName: participant.name,
    speakerId: participant.id,
    isPartial,
  };
}

const PARTICIPANT_ACTIONS: Record<string, NormalizedParticipantEvent["action"]> =
  {
    "participant_events.join": "join",
    "participant_events.leave": "leave",
    "participant_events.speech_on": "speech_on",
    "participant_events.speech_off": "speech_off",
    "participant_events.chat_message": "chat_message",
  };

/** Extract a participant lifecycle event, or null if this isn't one. */
export function extractParticipantEvent(
  msg: RealtimeMessage,
): NormalizedParticipantEvent | null {
  const action = PARTICIPANT_ACTIONS[msg.event];
  if (!action) return null;

  const inner = asRecord(asRecord(msg.data).data);
  const source = Object.keys(inner).length > 0 ? inner : msg.data;
  const participant = extractParticipant(source);

  const rawMessage = source.text ?? source.message;
  return {
    botId: extractBotId(msg.data),
    action,
    participantName: participant.name,
    participantId: participant.id,
    message: typeof rawMessage === "string" ? rawMessage : undefined,
  };
}
