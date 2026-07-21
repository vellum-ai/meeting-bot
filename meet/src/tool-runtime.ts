/**
 * Shared runtime support for the loader-surface files under `tools/` and
 * `routes/`.
 *
 * The external plugin loader default-imports each `tools/<name>.ts` file
 * as a `ToolDefinition` (and the assistant will auto-register the
 * method exports of `routes/<name>.ts` files once its `routes/`
 * discovery lands) and gives authors
 * no way to thread a `SkillHost` through construction. Instead, the
 * `init` hook publishes the host it builds into this module's slot and
 * each tool's `execute` (and the route handlers) reads it back at call
 * time. Kept separate from `plugin-runtime.ts` so tool and route modules
 * do not drag the full runtime graph (ingress listener, host bridge,
 * session manager wiring) into their import closure.
 */

import type { ToolDefinition, ToolExecutionResult } from "@vellumai/plugin-api";

import type { RiskLevel, SkillHost } from "../plugin-host.js";

let currentHost: SkillHost | null = null;

/**
 * Publish (or clear) the live host. Called by the plugin runtime at
 * init/shutdown; tests call it directly to run tools and routes against
 * a fake host.
 */
export function setMeetHost(host: SkillHost | null): void {
  currentHost = host;
}

/** The live host, or `null` before init / after shutdown. */
export function getMeetHost(): SkillHost | null {
  return currentHost;
}

/**
 * Uniform error result for tool calls that arrive before the `init` hook
 * has run (or after shutdown). Returned as a tool error rather than thrown
 * so the agent loop surfaces an actionable message instead of a crash.
 */
export function meetToolUnavailableResult(name: string): ToolExecutionResult {
  return {
    content:
      `Error: the meet-join plugin is not initialized, so "${name}" is ` +
      `unavailable. Check the assistant logs for meet-join init errors.`,
    isError: true,
  };
}

/**
 * `RiskLevel` is declared as a distinct enum on both sides of the boundary
 * (the plugin's self-contained host stub vs the published plugin-api
 * typings) with identical string values, so this single cast is
 * value-preserving.
 */
export function pluginRiskLevel(
  level: RiskLevel,
): NonNullable<ToolDefinition["defaultRiskLevel"]> {
  return level as unknown as NonNullable<ToolDefinition["defaultRiskLevel"]>;
}
