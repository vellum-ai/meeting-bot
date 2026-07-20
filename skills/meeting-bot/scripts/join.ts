#!/usr/bin/env bun
/**
 * join.ts - Send a Recall bot into a meeting.
 *
 * Creates a bot pointed at the given meeting URL, wired to the plugin's
 * realtime WebSocket endpoint. Recall handles joining the call; the plugin
 * begins receiving live events as soon as the bot is admitted.
 *
 * Usage:
 *   bun join.ts --meeting-url "https://meet.google.com/abc-defg-hij" [--conversation-id <id>] [--bot-name <name>]
 *
 * The --conversation-id is the Vellum conversation ID to associate with this
 * meeting session. Transcripts are flushed to this conversation for LLM
 * processing. If omitted, transcripts are recorded but not processed.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { parseIdentityName } from "../../../src/identity.ts";
import {
  addSession,
  botStatusCode,
  createBot,
  getBot,
  getResolvedConfig,
  RecallApiError,
  removeSession,
} from "./meeting-bot-client.ts";

interface Args {
  meetingUrl: string;
  conversationId: string | null;
  botName?: string;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };

  const meetingUrl = get("--meeting-url");
  if (!meetingUrl) {
    console.error(
      'Usage: bun join.ts --meeting-url "https://meet.google.com/abc-defg-hij" [--conversation-id <id>] [--bot-name <name>]',
    );
    process.exit(1);
  }

  return {
    meetingUrl,
    conversationId: get("--conversation-id") ?? null,
    botName: get("--bot-name"),
  };
}

/**
 * Resolve the assistant's display name from IDENTITY.md for the bot name.
 *
 * Parsing is delegated to the shared `parseIdentityName` in src/identity.ts so
 * this script and the init hook agree on the recognized formats (name: field,
 * `- **Name:**` bullet, H1) and the placeholder guard. The local copy that
 * used to live here handled neither the bullet format nor the "IDENTITY.md"
 * title-heading placeholder, which is how a bot once joined as "IDENTITY.md".
 *
 * The workspace root is located by walking up from this script's directory
 * looking for an `IDENTITY.md`, rather than hard-coding a level count. The
 * script lives at `<workspace>/plugins/<plugin>/skills/meeting-bot/scripts/`,
 * but the exact depth varies by install layout, so probing each ancestor is
 * more robust. Falls back to null (Recall uses its workspace default).
 */
function resolveAssistantName(): string | null {
  try {
    // `new URL(".", import.meta.url).pathname` is already the directory that
    // contains this script (with a trailing slash). Do NOT wrap it in
    // dirname(): that drops the "scripts" segment and resolves one level too
    // high.
    let dir = resolve(new URL(".", import.meta.url).pathname);
    for (let i = 0; i < 8; i++) {
      const identityPath = join(dir, "IDENTITY.md");
      if (existsSync(identityPath)) {
        return parseIdentityName(readFileSync(identityPath, "utf-8"));
      }
      const parent = dirname(dir);
      if (parent === dir) break; // reached filesystem root
      dir = parent;
    }
    return null;
  } catch {
    return null;
  }
}

/** Recall status codes that mean the bot is actually in the meeting. */
const IN_CALL_STATES = new Set([
  "in_call_recording",
  "in_call_not_recording",
  "in_call",
  "recording",
]);

/** Status codes that mean the bot is still on its way in (keep waiting). */
const JOINING_STATES = new Set([
  "ready",
  "joining_call",
  "joining",
  "in_waiting_room",
]);

/**
 * Terminal states that mean the bot stopped before (or without) joining. Seen
 * moments after creation, these indicate the join failed (e.g. an invalid or
 * expired meeting URL, a locked meeting, or admission denied).
 */
const FAILED_STATES = new Set([
  "fatal",
  "call_ended",
  "done",
  "error",
  "media_expired",
]);

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

interface JoinOutcome {
  result: "joined" | "failed" | "pending";
  status: string | null;
}

/**
 * Poll the bot's status after creation to confirm it actually joined, rather
 * than reporting success just because the create call returned a 200. Recall
 * can accept the bot at the API level and then fail to enter the call silently
 * (bad URL, waiting room, locked meeting), which later surfaces as
 * "cannot_command_unstarted_bot" on leave.
 *
 * Returns as soon as the bot reaches an in-call or terminal state, or when the
 * timeout elapses (still joining, not treated as a hard failure).
 */
async function pollJoin(
  config: ReturnType<typeof getResolvedConfig>,
  botId: string,
  { timeoutMs = 45_000, intervalMs = 3_000 } = {},
): Promise<JoinOutcome> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus: string | null = null;

  while (Date.now() < deadline) {
    let status: string | null = null;
    try {
      status = botStatusCode(await getBot(config, botId));
    } catch {
      // Transient status-fetch error: keep polling until the deadline.
    }

    if (status && status !== lastStatus) {
      console.error(`  status: ${status}`);
      lastStatus = status;
    }

    if (status && IN_CALL_STATES.has(status)) {
      return { result: "joined", status };
    }
    if (status && FAILED_STATES.has(status)) {
      return { result: "failed", status };
    }

    await sleep(intervalMs);
  }

  return { result: "pending", status: lastStatus };
}

async function main(): Promise<void> {
  const { meetingUrl, conversationId, botName } = parseArgs();

  // Read the resolved config (written by the init hook)
  let config;
  try {
    config = getResolvedConfig();
  } catch (err) {
    console.error(`Error: ${String(err)}`);
    process.exit(1);
  }

  // Resolve bot name: explicit arg > IDENTITY.md > Recall default
  const name = botName ?? resolveAssistantName() ?? undefined;

  console.error(`Creating bot for ${meetingUrl}...`);
  if (name) console.error(`  bot name: ${name}`);
  if (conversationId) console.error(`  conversation: ${conversationId}`);

  try {
    const bot = await createBot(config, meetingUrl, { botName: name });

    // Register the session so the realtime server can correlate events
    addSession({
      botId: bot.id,
      meetingUrl,
      conversationId,
      startedAt: Date.now(),
    });

    console.error(`Bot ${bot.id} created; confirming it joins ${meetingUrl}...`);

    // Confirm the bot actually enters the call instead of trusting the 200
    // from create. A silent join failure otherwise looks like success here and
    // only surfaces later as "cannot_command_unstarted_bot" on leave.
    const outcome = await pollJoin(config, bot.id);

    if (outcome.result === "failed") {
      removeSession(bot.id);
      console.error(
        `Bot ${bot.id} did not join ${meetingUrl} (status: ${outcome.status}). ` +
          `The meeting URL may be invalid or expired, the meeting may be locked, ` +
          `or admission was denied. Local session cleared.`,
      );
      process.exit(1);
    }

    if (outcome.result === "pending") {
      console.log(
        `Bot ${bot.id} was created for ${meetingUrl} but has not entered the call yet` +
          `${outcome.status ? ` (status: ${outcome.status})` : ""}. ` +
          `It may be waiting to be admitted from the waiting room.`,
      );
    } else {
      console.log(`Bot ${bot.id} joined ${meetingUrl}.`);
    }
    console.log(`Live transcript and participant events will stream to the realtime receiver.`);
    console.log(`Use leave.ts with this bot id to end it: --bot-id ${bot.id}`);
  } catch (err) {
    if (err instanceof RecallApiError) {
      const hint =
        err.status === 507
          ? " Recall reported no capacity (507); retry in ~30s."
          : err.status === 401
            ? " Check the Recall API key (assistant credentials reveal --service meeting-bot --field api_key)."
            : "";
      console.error(`Failed to create bot (${err.status}).${hint}`);
      console.error(`Detail: ${err.body.slice(0, 400)}`);
    } else {
      console.error(`Failed to create bot: ${String(err)}`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
