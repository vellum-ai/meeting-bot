/**
 * Shared active-session disambiguation for the in-meeting tools.
 *
 * `meet_speak`, `meet_cancel_speak`, `meet_enable_avatar`, and
 * `meet_disable_avatar` all accept an optional `meetingId` and target the
 * single active session when it is omitted. Ambiguity (zero or multiple
 * active sessions) is a caller error: we refuse rather than guess, so the
 * skill can prompt the user for the specific meeting.
 */

import { MeetSessionManager } from "./daemon/session-manager.js";

/**
 * Resolve the target meetingId from caller input + active sessions. Returns
 * `{ ok: true, meetingId }` when a single target is determined, or
 * `{ ok: false, content }` carrying the error string the tool should
 * surface verbatim. Mirrors the disambiguation logic inlined in
 * `meet_leave` and `meet_send_chat` (which carry verb-specific error
 * strings) so every meet_* tool behaves consistently when called without
 * an explicit meetingId.
 */
export function resolveTargetMeetingId(
  explicitId: string | undefined,
): { ok: true; meetingId: string } | { ok: false; content: string } {
  if (explicitId) {
    return { ok: true, meetingId: explicitId };
  }
  const active = MeetSessionManager.activeSessions();
  if (active.length === 0) {
    return { ok: false, content: "Error: no active Meet session." };
  }
  if (active.length > 1) {
    const ids = active.map((s) => s.meetingId).join(", ");
    return {
      ok: false,
      content: `Error: multiple active Meet sessions (${ids}). Pass meetingId explicitly.`,
    };
  }
  return { ok: true, meetingId: active[0]!.meetingId };
}
