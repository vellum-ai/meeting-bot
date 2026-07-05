/**
 * `meeting_bot_leave` tool — remove a Recall bot from its meeting.
 *
 * Asks Recall to have the bot leave the call, then closes the plugin's local
 * session. When a single bot is active the bot id may be omitted; with several
 * live bots it must be given explicitly.
 */

import {
  RiskLevel,
  type ToolDefinition,
  type ToolExecutionResult,
} from "@vellumai/plugin-api";

import { leaveCall, RecallApiError } from "../src/recall-client.ts";
import { requireConfig } from "../src/plugin-state.ts";
import { clearTranscriptBuffer } from "../src/realtime-server.ts";
import { closeSession, listSessions } from "../src/session-store.ts";

interface LeaveParams {
  bot_id?: string;
}

export const meetingBotLeave: ToolDefinition = {
  name: "meeting_bot_leave",
  description:
    "Have the meeting bot leave its call. When one meeting is active, bot_id can be omitted; " +
    "with multiple active bots, pass the bot_id to disambiguate.",
  input_schema: {
    type: "object",
    properties: {
      bot_id: {
        type: "string",
        description:
          "The Recall bot id returned by meeting_bot_join. Optional when exactly one bot is active.",
      },
    },
    required: [],
  },
  defaultRiskLevel: RiskLevel.Low,

  async execute(input: Record<string, unknown>): Promise<ToolExecutionResult> {
    const params = input as unknown as LeaveParams;

    let config;
    try {
      config = requireConfig();
    } catch (err) {
      return { content: String(err), isError: true };
    }

    let botId = params.bot_id?.trim();
    if (!botId) {
      const active = listSessions();
      if (active.length === 0) {
        return { content: "No active meeting bots to leave.", isError: true };
      }
      if (active.length > 1) {
        const ids = active.map((s) => s.botId).join(", ");
        return {
          content: `Multiple bots are active (${ids}). Pass bot_id to specify which should leave.`,
          isError: true,
        };
      }
      botId = active[0]!.botId;
    }

    try {
      await leaveCall(config, botId);
      clearTranscriptBuffer(botId);
      closeSession(botId);
      return { content: `Bot ${botId} is leaving the meeting.`, isError: false };
    } catch (err) {
      if (err instanceof RecallApiError) {
        // The local session is stale regardless of the API outcome; drop it.
        clearTranscriptBuffer(botId);
        closeSession(botId);
        return {
          content: `Recall reported an error leaving (${err.status}): ${err.body.slice(0, 300)}. Local session cleared.`,
          isError: true,
        };
      }
      return { content: `Failed to leave: ${String(err)}`, isError: true };
    }
  },
};

export default meetingBotLeave;
