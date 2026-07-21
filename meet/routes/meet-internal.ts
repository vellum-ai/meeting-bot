/**
 * HTTP route for meet-bot → daemon event ingress.
 *
 * Serves `POST /meet-internal?meetingId=<id>`.
 *
 * This module follows the assistant's file-based route convention: the
 * file path under the top-level `routes/` directory is the route path
 * (`routes/meet-internal.ts` → `/meet-internal`), and each HTTP method
 * is a named export (`export async function POST(request)`) with the
 * standard Web API Request/Response signature. The assistant will
 * auto-register these handlers once its `routes/` discovery lands; the
 * plugin's interim ingress listener (`src/ingress-listener.ts`) serves
 * the same files with the same resolution semantics today. Like the
 * tools, the handler reads the live `SkillHost` at request time via
 * `getMeetHost()`.
 *
 * The target meeting is identified by the required `meetingId` query
 * parameter — file-path routing has no dynamic path segments, so the id
 * moved out of the path (`bot/src/control/daemon-client.ts` builds the
 * matching URL).
 *
 * The request body is a batched JSON array of {@link MeetBotEvent} values.
 * Every event is validated with the Zod discriminated union schema from
 * the contracts barrel (`contracts/index.ts`); one invalid entry fails the entire batch
 * with 400 (mirrors how `meet-contracts` models the wire protocol as a
 * union — partial acceptance would leak an inconsistent event stream to
 * downstream subscribers).
 *
 * Auth: `Authorization: Bearer <token>`, where `<token>` matches
 * {@link MeetSessionEventRouter.resolveBotApiToken} for the request's
 * `meetingId`. If the resolver returns `null` (no active session for this
 * id) or the token does not match, the route returns 401.
 *
 * ── Why this is NOT a "new daemon HTTP port consumer" ──
 *
 * CLAUDE.md's "No New Daemon HTTP Port Consumers" rule forbids adding new
 * callers of the daemon's internal HTTP port from CLI commands or other
 * out-of-process code that could use the in-process service/store layer
 * directly.
 *
 * The meet-bot is neither of those. It is a subprocess spawned *by the
 * assistant daemon itself* to join a conference call, and it runs in its
 * own Docker container (or on the same host in local mode). It is, by
 * construction, out-of-process — there is no in-process alternative to
 * route its events through. Its lifecycle is bounded by the daemon that
 * launched it, and it only talks to localhost (or the sibling container
 * over a private bridge).
 *
 * Treat this as an "assistant-spawned subprocess ingress" endpoint — the
 * same category as Twilio's voice webhook bridge or the STT streaming
 * relay, not the category the rule is guarding against (external CLI
 * tools or sibling services calling the daemon HTTP API).
 */

import { timingSafeEqual } from "node:crypto";

import type { SkillHost } from "../plugin-host.js";
import { z } from "zod";

import { getMeetHost } from "../src/tool-runtime.js";

import { MeetBotEventSchema } from "../contracts/index.js";
import {
  getMeetSessionEventRouter,
  type MeetSessionEventRouter,
} from "../daemon/session-event-router.js";

/**
 * Batched-event request body. The bot buffers events briefly and ships
 * them in small arrays to amortize TLS / HTTP overhead.
 */
export const MeetIngressBatchSchema = z.array(MeetBotEventSchema);
export type MeetIngressBatch = z.infer<typeof MeetIngressBatchSchema>;

// ── Local HTTP error helper ─────────────────────────────────────────────────
//
// The skill no longer imports `httpError` from `assistant/src/runtime/`; the
// skill-isolation plan (`.private/plans/skill-isolation.md`) bans all
// `assistant/` reach-ins from `skills/`. The wire envelope below is the
// exact shape produced by `assistant/src/runtime/http-errors.ts` so clients
// (the meet bot) observe no change.

type MeetRouteErrorCode = "BAD_REQUEST" | "UNAUTHORIZED";

function meetRouteError(
  code: MeetRouteErrorCode,
  message: string,
  status: number,
  details?: unknown,
): Response {
  const body = {
    error: { code, message, ...(details !== undefined ? { details } : {}) },
  };
  return Response.json(body, { status });
}

/**
 * Handle `POST /meet-internal?meetingId=<id>`.
 *
 * Responsibilities:
 *   1. Decode body as `MeetBotEvent[]`. Return 400 on invalid JSON or any
 *      schema violation in the batch.
 *   2. Authenticate the bearer token against the resolver using a
 *      constant-time comparison. 401 on any mismatch.
 *   3. Dispatch each validated event to the registered session handler.
 *   4. Return 204 on success.
 *
 * `host` provides logger access (replacing the former direct import of
 * `getLogger` from `assistant/`). `router` remains an injectable default
 * for tests that want to drive a fresh router without hitting the module
 * singleton.
 */
export async function handleMeetInternalEvents(
  host: SkillHost,
  req: Request,
  meetingId: string,
  router: MeetSessionEventRouter = getMeetSessionEventRouter(),
): Promise<Response> {
  const log = host.logger.get("meet-internal-routes");

  if (req.method !== "POST") {
    return new Response("method not allowed", {
      status: 405,
      headers: { Allow: "POST" },
    });
  }

  // ── Auth ─────────────────────────────────────────────────────────────
  const expectedToken = router.resolveBotApiToken(meetingId);
  if (!expectedToken) {
    log.warn("meet-internal: no active session for meetingId; rejecting", {
      meetingId,
    });
    return meetRouteError("UNAUTHORIZED", "unauthorized", 401);
  }

  const presented = parseBearerToken(req.headers.get("authorization"));
  if (!presented || !tokensMatch(presented, expectedToken)) {
    log.warn("meet-internal: bearer token mismatch; rejecting", {
      meetingId,
      tokenPresented: presented !== null,
    });
    return meetRouteError("UNAUTHORIZED", "unauthorized", 401);
  }

  // ── Body parse ───────────────────────────────────────────────────────
  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return meetRouteError("BAD_REQUEST", "invalid JSON body", 400);
  }

  const parsed = MeetIngressBatchSchema.safeParse(rawBody);
  if (!parsed.success) {
    log.warn("meet-internal: invalid event batch", {
      meetingId,
      issues: parsed.error.issues,
    });
    return meetRouteError(
      "BAD_REQUEST",
      "invalid event batch",
      400,
      parsed.error.issues,
    );
  }

  // ── Cross-field validation ───────────────────────────────────────────
  // Defensive: the bot could post a batch tagged for a different
  // meetingId than the query parameter. Pre-scan the whole batch and
  // reject atomically — matches the schema-validation behavior so
  // downstream subscribers never see a partial stream from a mixed
  // batch. The bot's session is pinned to exactly one meeting, so any
  // mismatch is a protocol violation.
  for (const event of parsed.data) {
    if (event.meetingId !== meetingId) {
      log.warn("meet-internal: event meetingId does not match request", {
        requestMeetingId: meetingId,
        eventMeetingId: event.meetingId,
        eventType: event.type,
      });
      return meetRouteError(
        "BAD_REQUEST",
        "event meetingId does not match request",
        400,
      );
    }
  }

  // ── Dispatch ─────────────────────────────────────────────────────────
  for (const event of parsed.data) {
    router.dispatch(meetingId, event);
  }

  return new Response(null, { status: 204 });
}

/**
 * Extract the token from an `Authorization: Bearer <token>` header.
 * Returns `null` when the header is missing, malformed, or uses a
 * non-Bearer scheme. The scheme match is case-insensitive to match
 * RFC 7235.
 */
function parseBearerToken(header: string | null): string | null {
  if (!header) return null;
  const match = header.match(/^\s*Bearer\s+(\S+)\s*$/i);
  if (!match) return null;
  return match[1];
}

/**
 * Constant-time token comparison. `timingSafeEqual` requires equal-length
 * inputs, so we bail to `false` on a length mismatch. That length check
 * itself leaks one bit (the expected length) but the expected value is
 * server-minted and not attacker-chosen, so the leak is bounded and
 * acceptable. This matches how `token-service.ts` compares credentials.
 */
function tokensMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * `POST /meet-internal` — the method export the assistant's file-based
 * route discovery (and the interim ingress listener) dispatches to.
 *
 * Resolves the target meeting from the required `meetingId` query
 * parameter, reads the live host from the runtime slot, and delegates to
 * {@link handleMeetInternalEvents}.
 */
export function POST(request: Request): Promise<Response> {
  const meetingId = new URL(request.url).searchParams.get("meetingId");
  if (!meetingId) {
    return Promise.resolve(
      meetRouteError(
        "BAD_REQUEST",
        "missing required meetingId query parameter",
        400,
      ),
    );
  }

  // Host published by the init hook; before init (or after shutdown)
  // the plugin cannot serve ingress, so tell the bot to back off and
  // retry rather than pretending the path doesn't exist.
  const host = getMeetHost();
  if (!host) {
    return Promise.resolve(
      Response.json(
        { error: "meet-join plugin is not initialized" },
        { status: 503 },
      ),
    );
  }

  return handleMeetInternalEvents(host, request, meetingId);
}
