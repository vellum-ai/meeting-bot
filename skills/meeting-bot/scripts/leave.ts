#!/usr/bin/env bun
/**
 * leave.ts - Have a Recall bot leave its meeting.
 *
 * Asks Recall to have the bot leave the call, then removes the local session.
 * When a single bot is active, the bot id may be omitted; with several live
 * bots it must be given explicitly.
 *
 * Usage:
 *   bun leave.ts [--bot-id <id>]
 */

import {
  getResolvedConfig,
  leaveCall,
  readSessions,
  RecallApiError,
  removeSession,
} from "./meeting-bot-client.ts";

interface Args {
  botId?: string;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  return { botId: get("--bot-id") };
}

async function main(): Promise<void> {
  const { botId } = parseArgs();

  const sessions = readSessions();
  if (sessions.length === 0) {
    console.error("No active meeting bots to leave.");
    process.exit(1);
  }

  let targetBotId = botId?.trim();
  if (!targetBotId) {
    if (sessions.length > 1) {
      const ids = sessions.map((s) => s.botId).join(", ");
      console.error(`Multiple bots are active (${ids}). Pass --bot-id to specify which should leave.`);
      process.exit(1);
    }
    targetBotId = sessions[0]!.botId;
  }

  let config;
  try {
    config = getResolvedConfig();
  } catch (err) {
    console.error(`Error: ${String(err)}`);
    process.exit(1);
  }

  try {
    await leaveCall(config, targetBotId);
    removeSession(targetBotId);
    console.log(`Bot ${targetBotId} is leaving the meeting.`);
  } catch (err) {
    // Remove the local session regardless of the API outcome
    removeSession(targetBotId);
    if (err instanceof RecallApiError) {
      console.error(`Recall reported an error leaving (${err.status}): ${err.body.slice(0, 300)}`);
      console.error("Local session cleared.");
    } else {
      console.error(`Failed to leave: ${String(err)}`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
