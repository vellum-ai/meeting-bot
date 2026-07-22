/**
 * Meeting history for the configuration app.
 *
 * Two sources merge here:
 *
 *   - `history.json`: the durable record of vellum-provider join attempts
 *     and their outcomes. The daemon upserts an entry when the worker
 *     relays `meet.joining` and advances its status on `meet.joined` /
 *     `meet.error` / `meet.left` (see `src/vellum/runtime.ts`). Entries
 *     survive leave and failure, so the app shows attempts and failures,
 *     not only currently-live bots.
 *   - `sessions.json`: the active-session registry the join/leave scripts
 *     and the realtime pipeline share. Recall-provider bots appear only
 *     here (their join script does not write history.json), surfaced with
 *     the "active" status while the bot is live.
 *
 * Entries are keyed by bot/meeting id; history.json wins on conflicts. The
 * file is capped so a long-lived install cannot grow it unbounded.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Join lifecycle statuses a history entry can carry. */
export type MeetingHistoryStatus =
  | "joining"
  | "joined"
  | "failed"
  | "left"
  | "active";

export interface MeetingHistoryEntry {
  botId: string;
  meetingUrl: string;
  conversationId: string | null;
  startedAt: number;
  provider?: "recall" | "vellum";
  status?: MeetingHistoryStatus;
  /** Failure or leave detail when known. */
  detail?: string;
  updatedAt?: number;
}

/** Cap on retained history entries (newest kept). */
const MAX_HISTORY_ENTRIES = 200;

function historyPath(dataDir: string): string {
  return join(dataDir, "history.json");
}

function readHistoryFile(dataDir: string): MeetingHistoryEntry[] {
  const path = historyPath(dataDir);
  if (!existsSync(path)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is MeetingHistoryEntry =>
        typeof e === "object" &&
        e !== null &&
        typeof (e as { botId?: unknown }).botId === "string",
    );
  } catch {
    return [];
  }
}

/**
 * Insert or update a history entry. Fields set on an earlier upsert are
 * preserved unless the update carries a replacement (so `meet.joined` does
 * not erase the URL recorded at `meet.joining`, and the session-opened
 * message can add the conversation id later).
 */
export function upsertHistoryEntry(
  dataDir: string,
  update: Partial<MeetingHistoryEntry> & { botId: string },
): void {
  mkdirSync(dataDir, { recursive: true });
  const entries = readHistoryFile(dataDir);
  const existing = entries.find((e) => e.botId === update.botId);

  if (existing) {
    if (update.meetingUrl) existing.meetingUrl = update.meetingUrl;
    if (update.conversationId != null) existing.conversationId = update.conversationId;
    if (update.startedAt) existing.startedAt = update.startedAt;
    if (update.provider) existing.provider = update.provider;
    if (update.status) existing.status = update.status;
    if (update.detail) existing.detail = update.detail;
    existing.updatedAt = update.updatedAt ?? Date.now();
  } else {
    entries.push({
      botId: update.botId,
      meetingUrl: update.meetingUrl ?? "",
      conversationId: update.conversationId ?? null,
      startedAt: update.startedAt ?? Date.now(),
      ...(update.provider ? { provider: update.provider } : {}),
      ...(update.status ? { status: update.status } : {}),
      ...(update.detail ? { detail: update.detail } : {}),
      updatedAt: update.updatedAt ?? Date.now(),
    });
  }

  entries.sort((a, b) => b.startedAt - a.startedAt);
  writeFileSync(
    historyPath(dataDir),
    JSON.stringify(entries.slice(0, MAX_HISTORY_ENTRIES), null, 2),
    "utf-8",
  );
}

/** Read `sessions.json` entries (active sessions; recall bots live only here). */
function readActiveSessions(dataDir: string): MeetingHistoryEntry[] {
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
      ...(e.provider === "recall" || e.provider === "vellum"
        ? { provider: e.provider as "recall" | "vellum" }
        : {}),
      status: "active" as const,
    }));
}

/**
 * Read the merged meeting history, newest first. history.json entries win
 * over the sessions.json copy of the same bot id.
 */
export function readMeetingHistory(dataDir: string): MeetingHistoryEntry[] {
  const history = readHistoryFile(dataDir);
  const seen = new Set(history.map((e) => e.botId));
  const active = readActiveSessions(dataDir).filter((e) => !seen.has(e.botId));

  return [...history, ...active].sort((a, b) => b.startedAt - a.startedAt);
}
