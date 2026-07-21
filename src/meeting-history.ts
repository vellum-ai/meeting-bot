/**
 * Meeting history for the configuration app.
 *
 * The join skill records each bot it creates in `sessions.json` (see
 * `skills/meeting-bot/scripts/meeting-bot-client.ts`); this reads that file and
 * returns the entries newest-first. It is the durable, cross-process view a
 * route handler can rely on without sharing the daemon's in-memory session
 * store.
 *
 * Note: the join/leave scripts currently remove an entry when a bot leaves, so
 * this reflects sessions the plugin still knows about rather than a permanent
 * archive. A durable history that survives leave is a possible follow-up.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface MeetingHistoryEntry {
  botId: string;
  meetingUrl: string;
  conversationId: string | null;
  startedAt: number;
}

/** Read meeting history from `<dataDir>/sessions.json`, newest first. */
export function readMeetingHistory(dataDir: string): MeetingHistoryEntry[] {
  const path = join(dataDir, "sessions.json");
  if (!existsSync(path)) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  return parsed
    .filter(
      (e): e is Record<string, unknown> =>
        typeof e === "object" && e !== null && typeof (e as { botId?: unknown }).botId === "string",
    )
    .map((e) => ({
      botId: e.botId as string,
      meetingUrl: typeof e.meetingUrl === "string" ? e.meetingUrl : "",
      conversationId:
        typeof e.conversationId === "string" ? e.conversationId : null,
      startedAt: typeof e.startedAt === "number" ? e.startedAt : 0,
    }))
    .sort((a, b) => b.startedAt - a.startedAt);
}
