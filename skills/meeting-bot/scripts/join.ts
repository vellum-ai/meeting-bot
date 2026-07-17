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

import {
  addSession,
  createBot,
  getResolvedConfig,
  RecallApiError,
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
 * Falls back to null (Recall uses its workspace default).
 */
function resolveAssistantName(): string | null {
  try {
    const scriptDir = dirname(new URL(".", import.meta.url).pathname);
    // From skills/meeting-bot/scripts/ go up 4 levels to workspace root
    const workspaceRoot = resolve(scriptDir, "..", "..", "..", "..");
    const identityPath = join(workspaceRoot, "IDENTITY.md");
    if (!existsSync(identityPath)) return null;

    const content = readFileSync(identityPath, "utf-8");
    // Try name: field first
    const nameMatch = content.match(/^\s*name:\s*(.+)/im);
    if (nameMatch) {
      const name = nameMatch[1]!.trim();
      if (name && !name.startsWith("_(")) return name;
    }
    // Try first H1
    const h1Match = content.match(/^#\s+(.+)/m);
    if (h1Match) {
      const name = h1Match[1]!.trim();
      if (name && !name.startsWith("_(")) return name;
    }
    return null;
  } catch {
    return null;
  }
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

    console.log(`Bot ${bot.id} is joining ${meetingUrl}.`);
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
