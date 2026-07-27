/**
 * Wire protocol between the meeting-bot plugin and **Velay**, the meeting
 * service the `vellum` provider talks to.
 *
 * ## Why this exists
 *
 * The `vellum` provider used to mean "we drive our own Chromium into the
 * call". That approach is being retired: Google Meet hard-denies anonymous
 * automated clients (see `src/vellum/meet/bot/AGENTS.md`), the sanctioned
 * alternatives are gated behind allowlists or all-participant enrollment,
 * and Zoom now requires an OBF token tied to a real participant who is
 * already in the meeting. Every one of those is a platform-policy problem
 * that more browser automation cannot solve.
 *
 * So `vellum` becomes a *client*: the plugin opens a WebSocket to Velay,
 * asks it to put a bot in a meeting, and consumes the resulting media and
 * telemetry. Whatever Velay does behind that boundary — its own bots,
 * RTMS, a vendor — is its problem, not the plugin's.
 *
 * ## Status: provisional
 *
 * Velay's real API is not settled. These schemas are the plugin's opening
 * proposal, shaped to match what the plugin already needs downstream:
 * every server→client event maps onto an existing `MeetBotEvent` so the
 * session store, transcript flush, and meeting history keep working
 * unchanged (see `src/vellum/meet/contracts/events.ts`). Expect this file
 * to move as Velay's surface firms up; when it does, the changes should be
 * back-propagated to `vellum-assistant` / `vellum-assistant-platform`.
 *
 * ## Framing
 *
 * One JSON object per WebSocket message, discriminated on `type`. The
 * plugin validates in both directions rather than trusting the socket —
 * same posture as the native-messaging contracts.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Plugin → Velay
// ---------------------------------------------------------------------------

/**
 * Opening frame on every connection. Velay uses it to authenticate the
 * plugin and to decide whether to resume prior sessions.
 *
 * `sessionToken` is deliberately opaque: whether it ends up being an API
 * key, a short-lived JWT, or a workspace-scoped grant is a Velay decision.
 * The plugin only needs somewhere to put it.
 */
export const VelayHelloSchema = z.object({
  type: z.literal("hello"),
  /** Opaque credential identifying this assistant/workspace to Velay. */
  sessionToken: z.string().min(1),
  /** Plugin build, for compatibility logging on the Velay side. */
  clientVersion: z.string().min(1),
});

/**
 * Ask Velay to put a bot into a meeting. Velay owns platform detection and
 * whatever join mechanism that platform requires.
 *
 * `meetingId` is the plugin's own correlation id (the same one the session
 * store and meeting history key on), NOT Velay's. Velay echoes it back on
 * every event for this meeting so the plugin never has to maintain a
 * mapping table.
 */
export const VelayJoinSchema = z.object({
  type: z.literal("join"),
  meetingId: z.string().min(1),
  /** Full meeting URL as pasted by the user. */
  meetingUrl: z.string().min(1),
  /** Display name the bot should present in the call. */
  displayName: z.string().min(1),
  /** Consent notice to post on joining, if the platform supports chat. */
  consentMessage: z.string().optional(),
});

/** Ask Velay to remove the bot from a meeting. */
export const VelayLeaveSchema = z.object({
  type: z.literal("leave"),
  meetingId: z.string().min(1),
  reason: z.string().optional(),
});

/**
 * Ask the bot to say something in the call.
 *
 * Audio is not carried here. The plugin's TTS runs assistant-side, so this
 * frame carries text and Velay is responsible for voicing it — which keeps
 * the socket text-only and avoids streaming PCM through it. If Velay would
 * rather receive audio, this is the first thing to renegotiate.
 */
export const VelaySpeakSchema = z.object({
  type: z.literal("speak"),
  meetingId: z.string().min(1),
  text: z.string().min(1),
  /** Correlation id echoed on the matching `speak_result`. */
  requestId: z.string().min(1),
});

/** Ask the bot to post a chat message. */
export const VelaySendChatSchema = z.object({
  type: z.literal("send_chat"),
  meetingId: z.string().min(1),
  text: z.string().min(1),
  requestId: z.string().min(1),
});

export const VelayClientMessageSchema = z.discriminatedUnion("type", [
  VelayHelloSchema,
  VelayJoinSchema,
  VelayLeaveSchema,
  VelaySpeakSchema,
  VelaySendChatSchema,
]);
export type VelayClientMessage = z.infer<typeof VelayClientMessageSchema>;

// ---------------------------------------------------------------------------
// Velay → Plugin
// ---------------------------------------------------------------------------

/** Handshake ack. Absence of this within a timeout is a failed connect. */
export const VelayReadySchema = z.object({
  type: z.literal("ready"),
  /** Velay build, for compatibility logging on the plugin side. */
  serverVersion: z.string().min(1),
});

/**
 * Meeting lifecycle. Mirrors the vocabulary the plugin already uses
 * end-to-end (`LifecycleStateSchema` in the meet contracts) so these map
 * onto session-store transitions with no translation.
 */
export const VelayLifecycleSchema = z.object({
  type: z.literal("lifecycle"),
  meetingId: z.string().min(1),
  state: z.enum(["joining", "joined", "leaving", "left", "error"]),
  /** Human-readable detail; expected on `error`. */
  detail: z.string().optional(),
  timestamp: z.string().min(1),
});

/**
 * A transcript segment. `isFinal` distinguishes interim hypotheses from
 * settled text, matching what the transcript flush already expects.
 */
export const VelayTranscriptSchema = z.object({
  type: z.literal("transcript"),
  meetingId: z.string().min(1),
  speakerId: z.string().optional(),
  speakerName: z.string().optional(),
  text: z.string(),
  isFinal: z.boolean(),
  timestamp: z.string().min(1),
});

/** Participants joining or leaving. */
export const VelayParticipantChangeSchema = z.object({
  type: z.literal("participant.change"),
  meetingId: z.string().min(1),
  joined: z.array(z.object({ id: z.string(), name: z.string() })),
  left: z.array(z.object({ id: z.string(), name: z.string() })),
  timestamp: z.string().min(1),
});

/** Active-speaker change. */
export const VelaySpeakerChangeSchema = z.object({
  type: z.literal("speaker.change"),
  meetingId: z.string().min(1),
  speakerId: z.string().nullable(),
  speakerName: z.string().nullable(),
  timestamp: z.string().min(1),
});

/** Someone posted in the meeting chat. */
export const VelayInboundChatSchema = z.object({
  type: z.literal("chat.inbound"),
  meetingId: z.string().min(1),
  fromId: z.string(),
  fromName: z.string(),
  text: z.string(),
  timestamp: z.string().min(1),
});

/** Result of a prior `speak` or `send_chat`, correlated by `requestId`. */
export const VelayCommandResultSchema = z.object({
  type: z.literal("command_result"),
  requestId: z.string().min(1),
  ok: z.boolean(),
  error: z.string().optional(),
});

/**
 * Connection-level failure Velay wants the plugin to surface — bad token,
 * unsupported platform, quota exhausted. Meeting-scoped failures come
 * through `lifecycle:error` instead.
 */
export const VelayErrorSchema = z.object({
  type: z.literal("error"),
  code: z.string().min(1),
  message: z.string().min(1),
  /** Set when the failure belongs to one meeting rather than the socket. */
  meetingId: z.string().optional(),
});

export const VelayServerMessageSchema = z.discriminatedUnion("type", [
  VelayReadySchema,
  VelayLifecycleSchema,
  VelayTranscriptSchema,
  VelayParticipantChangeSchema,
  VelaySpeakerChangeSchema,
  VelayInboundChatSchema,
  VelayCommandResultSchema,
  VelayErrorSchema,
]);
export type VelayServerMessage = z.infer<typeof VelayServerMessageSchema>;

/** Every server→plugin discriminator, for exhaustiveness tests. */
export const VELAY_SERVER_MESSAGE_TYPES = [
  "ready",
  "lifecycle",
  "transcript",
  "participant.change",
  "speaker.change",
  "chat.inbound",
  "command_result",
  "error",
] as const;

/** Every plugin→server discriminator, for exhaustiveness tests. */
export const VELAY_CLIENT_MESSAGE_TYPES = [
  "hello",
  "join",
  "leave",
  "speak",
  "send_chat",
] as const;
