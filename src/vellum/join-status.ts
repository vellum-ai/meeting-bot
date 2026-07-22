/**
 * Per-meeting join-outcome tracker for the Vellum Runtime worker.
 *
 * The control server's /join returns immediately with a "joining" status
 * (the real work, container spawn plus in-call admission, can take up to
 * two minutes), and the join script polls /status until the outcome is
 * known. This module holds that state, fed from two sources:
 *
 *   - the async join flow itself (attempt registered, spawn failure), and
 *   - the meet.* hub events the session manager publishes (joined at the
 *     bot's lifecycle:joined, error with detail, left).
 *
 * State is worker-local and bounded; the durable record lives in the
 * daemon's meeting history (see src/meeting-history.ts).
 */

/** Join lifecycle states surfaced to the join script. */
export type JoinState = "joining" | "joined" | "failed" | "left";

export interface JoinStatus {
  meetingId: string;
  state: JoinState;
  /** Failure or leave detail when known. */
  detail?: string;
  updatedAt: number;
}

/** Cap on remembered meetings; oldest entries are evicted first. */
const MAX_TRACKED = 100;

export interface JoinStatusTracker {
  /** Record a state transition for a meeting. */
  set(meetingId: string, state: JoinState, detail?: string): void;
  /** Current status, or null for an unknown meeting id. */
  get(meetingId: string): JoinStatus | null;
  /**
   * Apply a meet.* hub message (from the session manager via the worker
   * host's events facet). Non-meet or unrecognized messages are ignored.
   */
  applyHubMessage(message: Record<string, unknown>): void;
}

export function createJoinStatusTracker(): JoinStatusTracker {
  const statuses = new Map<string, JoinStatus>();

  function set(meetingId: string, state: JoinState, detail?: string): void {
    statuses.delete(meetingId);
    statuses.set(meetingId, {
      meetingId,
      state,
      ...(detail ? { detail } : {}),
      updatedAt: Date.now(),
    });
    if (statuses.size > MAX_TRACKED) {
      const oldest = statuses.keys().next().value;
      if (oldest !== undefined) statuses.delete(oldest);
    }
  }

  return {
    set,
    get(meetingId: string): JoinStatus | null {
      return statuses.get(meetingId) ?? null;
    },
    applyHubMessage(message: Record<string, unknown>): void {
      const meetingId =
        typeof message.meetingId === "string" ? message.meetingId : "";
      if (!meetingId) return;
      switch (message.type) {
        case "meet.joined":
          set(meetingId, "joined");
          return;
        case "meet.error": {
          const detail =
            typeof message.detail === "string" ? message.detail : undefined;
          set(meetingId, "failed", detail);
          return;
        }
        case "meet.left": {
          const reason =
            typeof message.reason === "string" ? message.reason : undefined;
          set(meetingId, "left", reason);
          return;
        }
        default:
          return;
      }
    },
  };
}
