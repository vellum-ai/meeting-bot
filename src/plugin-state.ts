/**
 * Process-wide plugin state shared between hooks and tools.
 *
 * Hooks and tools run in the same in-process module graph, so the resolved
 * config the `init` hook produces is stashed here for the tools to read. This
 * avoids re-parsing `InitContext.config` in every tool and gives one place to
 * ask "is the plugin initialized yet?".
 */

import type { MeetingBotConfig } from "./config.ts";

let resolvedConfig: MeetingBotConfig | null = null;

export function setResolvedConfig(config: MeetingBotConfig): void {
  resolvedConfig = config;
}

/**
 * The assistant's display name, resolved from `IDENTITY.md` by the `init` hook.
 * Used as the default bot name when the user does not supply one, so the bot
 * joins the meeting as the assistant rather than Recall's generic
 * "Meeting Notetaker".
 */
let assistantName: string | null = null;

export function setAssistantName(name: string | null): void {
  assistantName = name;
}

export function getAssistantName(): string | null {
  return assistantName;
}

/**
 * Read the resolved config. Throws if the plugin has not initialized yet — a
 * tool cannot create a bot before `init` has validated credentials and started
 * the realtime receiver.
 */
export function requireConfig(): MeetingBotConfig {
  if (!resolvedConfig) {
    throw new Error(
      "meeting-bot: plugin is not initialized (no resolved config). The init hook must run before tools can be used.",
    );
  }
  return resolvedConfig;
}

export function hasConfig(): boolean {
  return resolvedConfig !== null;
}
