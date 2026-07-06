/**
 * `meeting_bot_join` tool — send a Recall bot into a meeting.
 *
 * Creates a bot pointed at the given meeting URL, wired to the plugin's
 * realtime WebSocket endpoint (and, by default, streaming transcription).
 * Recall handles joining the call; the plugin begins receiving live events on
 * its realtime server as soon as the bot is admitted.
 *
 * Only join when the user explicitly asks — a bot is a visible participant in
 * someone else's call. Never join based on calendar context alone.
 */

import {
  RiskLevel,
  type ToolContext,
  type ToolDefinition,
  type ToolExecutionResult,
} from "@vellumai/plugin-api";

import { createBot, RecallApiError } from "../src/recall-client.ts";
import { getAssistantName, requireConfig } from "../src/plugin-state.ts";
import { isRealtimeServerRunning } from "../src/realtime-server.ts";
import { openSession } from "../src/session-store.ts";

interface JoinParams {
  meeting_url: string;
}

export const meetingBotJoin: ToolDefinition = {
  name: "meeting_bot_join",
  description:
    "Send a note-taking bot into a meeting (Google Meet, Zoom, Teams, etc.) via Recall.ai. " +
    "The bot joins as a visible participant and streams live transcript and participant events back to the assistant. " +
    "Only call this when the user explicitly asks the assistant to join a specific meeting URL.",
  input_schema: {
    type: "object",
    properties: {
      meeting_url: {
        type: "string",
        description:
          "The full meeting URL to join (e.g. https://meet.google.com/abc-defg-hij).",
      },

    },
    required: ["meeting_url"],
  },
  defaultRiskLevel: RiskLevel.Medium,

  async execute(
    input: Record<string, unknown>,
    ctx?: ToolContext,
  ): Promise<ToolExecutionResult> {
    const params = input as unknown as JoinParams;
    const meetingUrl = params.meeting_url?.trim();
    if (!meetingUrl) {
      return { content: "Error: meeting_url is required.", isError: true };
    }

    let config;
    try {
      config = requireConfig();
    } catch (err) {
      return { content: String(err), isError: true };
    }

    if (!isRealtimeServerRunning()) {
      return {
        content:
          "Warning: the realtime receiver is not running, so the bot will join but no live transcript/participant events will be received. Check the plugin's init logs (port bind failure or config issue) before relying on realtime data.",
        isError: true,
      };
    }

    // The bot name always comes from the assistant's identity (resolved from
    // IDENTITY.md at init). The tool does not accept a name override so the
    // assistant cannot spoof a different display name.
    const botName = getAssistantName() ?? undefined;

    try {
      const bot = await createBot(config, meetingUrl, {
        botName,
      });
      openSession(bot.id, meetingUrl, ctx?.conversationId ?? null);

      return {
        content:
          `Bot ${bot.id} is joining ${meetingUrl}. ` +
          `Live transcript and participant events will stream to the realtime receiver. ` +
          `Use meeting_bot_leave with this bot id to end it.`,
        isError: false,
      };
    } catch (err) {
      if (err instanceof RecallApiError) {
        const hint =
          err.status === 507
            ? " Recall reported no capacity (507); retry in ~30s."
            : err.status === 401
              ? " Check the Recall API key and that its region matches the configured region."
              : "";
        return {
          content: `Failed to create bot (${err.status}).${hint} Detail: ${err.body.slice(0, 400)}`,
          isError: true,
        };
      }
      return {
        content: `Failed to create bot: ${String(err)}`,
        isError: true,
      };
    }
  },
};

export default meetingBotJoin;
