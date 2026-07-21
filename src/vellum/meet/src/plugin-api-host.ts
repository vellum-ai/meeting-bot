/**
 * SkillHost bridge over `@vellumai/plugin-api`.
 *
 * The plugin's internals (session manager, tools, routes) are written
 * against the `SkillHost` facets in `plugin-host.ts`. The real host,
 * however, hands external plugins a much narrower surface: an
 * {@link InitContext} (config, logger, per-plugin data dir, version) plus
 * the runtime exports of `@vellumai/plugin-api` (event hub facade, model
 * profiles, ...). This module builds a `SkillHost` from that narrow
 * surface so the rest of the plugin runs unmodified.
 *
 * ## Facet fidelity
 *
 * Facets fall into three bands:
 *
 * - **Fully backed** — `logger` (wraps the init-context logger), `events`
 *   (assistant event hub facade + a locally built envelope), `platform`
 *   (workspace dir from `VELLUM_WORKSPACE_DIR` or derived from the plugin
 *   storage dir; runtime mode from `IS_CONTAINERIZED`),
 *   `memory.addMessage` (plugin-api `addMessage`),
 *   `identity.getAssistantName` (plugin-api `getAssistantName`),
 *   `providers.llm.getConfigured` (plugin-api `getConfiguredProvider`),
 *   and `providers.secureKeys.getProviderKey` (plugin-api
 *   `resolveCredential` on `<provider>/api_key`).
 *
 * - **Gracefully degraded** — facets whose contracts have a documented
 *   "unavailable" value and no plugin-api equivalent yet:
 *   `providers.stt.resolveStreamingTranscriber` → `null`,
 *   `config.getSection` → `undefined`, `speakers.createTracker` →
 *   `undefined` (the speaker resolver falls back to its NOOP tracker), and
 *   `memory.wakeAgentForOpportunity` → logged no-op. Each degradation logs
 *   a warning once per capability.
 *
 * - **Unsupported** — calls with no graceful value (`providers.tts.*`,
 *   `providers.llm.userMessage`, `platform.vellumRoot`) throw
 *   {@link MeetHostCapabilityError} with an actionable message.
 *
 * The remaining degraded/unsupported facets (STT, TTS, speakers, agent
 * wake-ups) are candidates for their own plugin-api facets; this bridge
 * keeps shrinking as those land.
 */

import { randomUUID } from "node:crypto";
import { basename, dirname } from "node:path";

import type { InitContext } from "@vellumai/plugin-api";
import {
  addMessage,
  assistantEventHub,
  getAssistantName,
  getConfiguredProvider,
  resolveCredential,
} from "@vellumai/plugin-api";

import type {
  AssistantEvent,
  DaemonRuntimeMode,
  Logger,
  ServerMessage,
  SkillHost,
  Subscription,
} from "../plugin-host.js";

/**
 * Thrown when plugin code calls a host capability that has no
 * `@vellumai/plugin-api` equivalent yet and no graceful degraded value.
 */
export class MeetHostCapabilityError extends Error {
  constructor(capability: string) {
    super(
      `meet-join: host capability "${capability}" is not yet available via ` +
        `@vellumai/plugin-api. The feature that needs it is degraded until ` +
        `the corresponding plugin-api facet lands.`,
    );
    this.name = "MeetHostCapabilityError";
  }
}

/** Parse a boolean-ish env flag the way the host does (`"true"`/`"1"`). */
function envFlag(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "true" || normalized === "1";
}

/**
 * Resolve the assistant workspace directory.
 *
 * Preference order:
 *  1. `VELLUM_WORKSPACE_DIR` — set by the daemon's environment.
 *  2. Derived from `pluginStorageDir`. User-installed plugins get
 *     `<workspace>/plugins/<name>/data`; default plugins and workspace
 *     hooks get `<workspace>/plugins-data/<name>`. Both layouts are
 *     recognized by inspecting the ancestor directory names.
 *  3. The plugin storage dir itself, with a warning — meet config and
 *     transcript storage then live under the plugin's data dir, which is
 *     wrong but keeps the plugin functional for inspection.
 */
export function resolveWorkspaceDirFromContext(ctx: InitContext): string {
  const fromEnv = process.env.VELLUM_WORKSPACE_DIR;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv;

  const storageDir = ctx.pluginStorageDir;
  // `<workspace>/plugins/<name>/data` → workspace is three levels up.
  const grandParent = dirname(dirname(storageDir));
  if (basename(grandParent) === "plugins") return dirname(grandParent);
  // `<workspace>/plugins-data/<name>` → workspace is two levels up.
  const parent = dirname(storageDir);
  if (basename(parent) === "plugins-data") return dirname(parent);

  ctx.logger.warn(
    { pluginStorageDir: storageDir },
    "meet-join: could not resolve the workspace dir (VELLUM_WORKSPACE_DIR unset, " +
      "unrecognized plugin dir layout) - falling back to the plugin storage dir",
  );
  return storageDir;
}

/**
 * Build a `SkillHost` from the init context plus the plugin-api runtime
 * surface. See the module doc for per-facet fidelity.
 */
export function createPluginApiHost(ctx: InitContext): SkillHost {
  const workspaceDir = resolveWorkspaceDirFromContext(ctx);
  const runtimeMode: DaemonRuntimeMode = envFlag(process.env.IS_CONTAINERIZED)
    ? "docker"
    : "bare-metal";

  // Warn once per degraded capability so a busy meeting doesn't spam the
  // daemon log with one line per transcript chunk.
  const warned = new Set<string>();
  const warnOnce = (capability: string, detail: string): void => {
    if (warned.has(capability)) return;
    warned.add(capability);
    ctx.logger.warn(
      { capability },
      `meet-join: ${detail} ("${capability}" has no @vellumai/plugin-api equivalent yet)`,
    );
  };

  // The plugin-api logger is pino-style (`obj`-first); the SkillHost
  // `Logger` is message-first. Adapt per call and carry the module name.
  const getLogger = (name: string): Logger => {
    const wrap =
      (level: "debug" | "info" | "warn" | "error") =>
      (msg: string, meta?: unknown): void => {
        const obj: Record<string, unknown> =
          meta === undefined ? { module: name } : { module: name, meta };
        ctx.logger[level](obj, msg);
      };
    return {
      debug: wrap("debug"),
      info: wrap("info"),
      warn: wrap("warn"),
      error: wrap("error"),
    };
  };

  return {
    logger: { get: getLogger },

    config: {
      // No plugin code reads host config sections today (meet config is
      // file-based via `getMeetConfig`); report every section as absent.
      getSection: <T>(): T | undefined => undefined,
    },

    identity: {
      // Backed by the real plugin-api export (reads IDENTITY.md host-side).
      getAssistantName: (): string | undefined => getAssistantName() ?? undefined,
    },

    platform: {
      workspaceDir: () => workspaceDir,
      vellumRoot: (): string => {
        // No production call site — `getMeetBotInstanceHash` hashes the
        // workspace dir. Throw so any future use is caught loudly.
        throw new MeetHostCapabilityError("platform.vellumRoot");
      },
      runtimeMode: () => runtimeMode,
    },

    providers: {
      llm: {
        // Backed by the real plugin-api call-site resolver. Callers treat a
        // null as "LLM unavailable" and degrade, same as before.
        getConfigured: async (callSite: string) => {
          try {
            return await getConfiguredProvider(
              callSite as Parameters<typeof getConfiguredProvider>[0],
            );
          } catch {
            return null;
          }
        },
        // Only reachable after a non-null `getConfigured`, which never
        // happens through this bridge.
        userMessage: () => {
          throw new MeetHostCapabilityError("providers.llm.userMessage");
        },
        extractToolUse: () => null,
        createTimeout: (ms: number) => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), ms);
          return { signal: controller.signal, cleanup: () => clearTimeout(timer) };
        },
      },
      stt: {
        listProviderIds: () => {
          warnOnce(
            "providers.stt",
            "STT providers unavailable - live transcription is disabled",
          );
          return [];
        },
        supportsBoundary: () => false,
        resolveStreamingTranscriber: async () => {
          warnOnce(
            "providers.stt",
            "STT providers unavailable - live transcription is disabled",
          );
          return null;
        },
      },
      tts: {
        get: () => {
          throw new MeetHostCapabilityError("providers.tts.get");
        },
        resolveConfig: () => {
          throw new MeetHostCapabilityError("providers.tts.resolveConfig");
        },
      },
      secureKeys: {
        // Backed by the plugin-api credential resolver; provider keys live in
        // the secure store under `<provider>/api_key`. Absent keys resolve to
        // null, preserving the facet's documented degraded value.
        getProviderKey: async (id: string) => {
          try {
            const value = (await resolveCredential(`${id}/api_key`)).trim();
            return value.length > 0 ? value : null;
          } catch {
            return null;
          }
        },
      },
    },

    memory: {
      // Backed by the real plugin-api conversation insert.
      addMessage: async (conversationId, role, content, options) =>
        addMessage(conversationId, role, content, options),
      wakeAgentForOpportunity: async () => {
        warnOnce(
          "memory.wakeAgentForOpportunity",
          "agent wake-ups unavailable - chat opportunities will not wake the assistant",
        );
      },
    },

    events: {
      buildEvent: (message: ServerMessage, conversationId?: string): AssistantEvent => ({
        id: randomUUID(),
        ...(conversationId === undefined ? {} : { conversationId }),
        emittedAt: new Date().toISOString(),
        message,
      }),
      publish: async (event: AssistantEvent): Promise<void> => {
        await assistantEventHub.publish(
          event as unknown as Parameters<typeof assistantEventHub.publish>[0],
        );
      },
      subscribe: (filter, cb): Subscription =>
        assistantEventHub.subscribe({
          type: "process",
          filter:
            filter.conversationId === undefined
              ? undefined
              : { conversationId: filter.conversationId },
          callback: cb as unknown as Parameters<
            typeof assistantEventHub.subscribe
          >[0]["callback"],
        }),
    },

    speakers: {
      // `undefined` routes the speaker resolver onto its NOOP tracker:
      // speaker labels still resolve per meeting, but identities are not
      // persisted across meetings.
      createTracker: () => {
        warnOnce(
          "speakers.createTracker",
          "speaker identity tracking unavailable - falling back to per-meeting NOOP tracking",
        );
        return undefined;
      },
    },
  };
}
