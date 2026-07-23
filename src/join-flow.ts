/**
 * Daemon-side join flow for the dashboard's Join button.
 *
 * Mirrors what the join skill script does, minus the interactive polling:
 * for the vellum provider the join is commanded over the Vellum Runtime
 * worker's loopback control endpoint (the same one the skill script uses),
 * and for the recall provider a bot is created against the Recall API with
 * the shared request builder and registered in data/sessions.json. Both
 * paths return immediately after the join is started; progress lands in
 * the meeting history the dashboard already renders.
 *
 * Dashboard joins carry no conversation: transcripts are recorded but not
 * routed into an assistant conversation.
 */

import {
  recallApiBase,
  realtimeEndpointUrl,
  resolveApiKey,
} from "./config.ts";
import { getAssistantName, hasConfig, requireConfig } from "./plugin-state.ts";
import { buildCreateBotBody, recallAuthHeaders } from "./recall-requests.ts";
import { persistSessionEntry } from "./session-store.ts";

/** Error with the HTTP status the join route should respond with. */
export class JoinRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "JoinRequestError";
  }
}

export interface JoinStartResult {
  provider: "recall" | "vellum";
  /** Meeting id (vellum) or Recall bot id: the handle history rows key on. */
  botId: string;
  /** Human-readable outcome note for the dashboard to display. */
  note: string;
}

/**
 * Start a join for `meetingUrl` with the currently configured provider.
 * Resolves once the join has been started (not completed); throws
 * {@link JoinRequestError} with a client-appropriate status on failure.
 */
export async function startJoinFromApp(
  meetingUrl: string,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<JoinStartResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;

  if (!hasConfig()) {
    throw new JoinRequestError(
      "the plugin has not finished initializing; try again in a moment",
      503,
    );
  }
  const config = requireConfig();

  if (config.provider === "vellum") {
    let res: Response;
    try {
      res = await fetchImpl(`http://127.0.0.1:${config.listenPort}/join`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ meetingUrl, conversationId: null }),
      });
    } catch {
      throw new JoinRequestError(
        `could not reach the Vellum Runtime at 127.0.0.1:${config.listenPort}. ` +
          "The runtime may still be starting; try again in a moment.",
        502,
      );
    }
    const text = await res.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // Non-JSON error body; surfaced below.
    }
    if (!res.ok) {
      const detail =
        typeof parsed.error === "string" ? parsed.error : text.slice(0, 300);
      throw new JoinRequestError(
        `the Vellum Runtime rejected the join: ${detail}`,
        502,
      );
    }
    const meetingId =
      typeof parsed.meetingId === "string" ? parsed.meetingId : "";
    if (!meetingId) {
      throw new JoinRequestError(
        "the Vellum Runtime did not return a meeting id",
        502,
      );
    }
    return {
      provider: "vellum",
      botId: meetingId,
      note:
        "Join started. The bot can take up to 2 minutes to enter the call; " +
        "watch its row in the history below.",
    };
  }

  // Recall provider: create the bot directly against the Recall API.
  let apiKey: string;
  try {
    apiKey = await resolveApiKey();
  } catch (err) {
    throw new JoinRequestError(
      err instanceof Error ? err.message : String(err),
      409,
    );
  }

  let endpointUrl: string;
  try {
    endpointUrl = realtimeEndpointUrl(config);
  } catch (err) {
    throw new JoinRequestError(
      err instanceof Error ? err.message : String(err),
      409,
    );
  }

  const body = buildCreateBotBody({
    meetingUrl,
    endpointUrl,
    transcript: config.transcript,
    botName: getAssistantName() ?? undefined,
  });

  let res: Response;
  try {
    res = await fetchImpl(`${recallApiBase(config.region)}bot/`, {
      method: "POST",
      headers: recallAuthHeaders(apiKey),
      body: JSON.stringify(body),
    });
  } catch {
    throw new JoinRequestError(
      `could not reach the Recall API for region ${config.region}`,
      502,
    );
  }

  const text = await res.text();
  if (!res.ok) {
    const hint =
      res.status === 507
        ? " Recall reported no capacity; retry in about 30 seconds."
        : res.status === 401
          ? " Check the stored Recall API key."
          : "";
    throw new JoinRequestError(
      `Recall rejected the bot (${res.status}).${hint} ${text.slice(0, 300)}`.trim(),
      502,
    );
  }

  let botId = "";
  try {
    const bot = JSON.parse(text) as { id?: unknown };
    if (typeof bot.id === "string") botId = bot.id;
  } catch {
    // Fall through to the guard below.
  }
  if (!botId) {
    throw new JoinRequestError("Recall did not return a bot id", 502);
  }

  // Register the session so the realtime server correlates events and the
  // history/leave paths see the meeting, exactly as the skill script does.
  persistSessionEntry({
    botId,
    meetingUrl,
    conversationId: null,
    startedAt: Date.now(),
    provider: "recall",
  });

  return {
    provider: "recall",
    botId,
    note:
      "Bot created. It should appear in the call shortly; admission can " +
      "take a minute or two if a host has to let it in.",
  };
}
