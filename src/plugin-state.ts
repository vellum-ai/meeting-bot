/**
 * Process-wide plugin state shared between hooks and tools.
 *
 * The resolved config the `init` hook produces is stashed here rather than
 * re-parsed in every tool, and gives one place to ask "is the plugin
 * initialized yet?".
 *
 * What it cannot be is a dependency for anything that must work: the daemon
 * caches hooks, tools, and routes independently and sweeps a plugin's whole
 * module registry on redeploy, so a reader is not guaranteed to observe the
 * instance the hook wrote to. A route that needs config for correctness reads
 * `config.json` through `plugin-paths.ts` instead — that is what
 * `restartProviderRuntime` does, after a live provider switch was seen to
 * no-op against a stashed value the route could not see.
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

/**
 * Test-only: clear the stashed config so not-yet-initialized gating paths
 * can be exercised regardless of what earlier test files stashed.
 */
export function clearResolvedConfigForTests(): void {
  resolvedConfig = null;
}
