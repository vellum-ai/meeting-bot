/**
 * SkillHost implementation for the Vellum Runtime subprocess.
 *
 * The runtime executes outside the daemon: there is no InitContext and no
 * daemon services to call, so plugin-api methods are not available here.
 * This host keeps everything the vendored subsystem needs local to the
 * subprocess:
 *
 *   - `logger` relays structured lines to the parent daemon over stdout
 *     (the supervisor forwards them to the plugin logger),
 *   - `platform` values arrive from the supervisor in the spawn argument,
 *   - `events.publish` forwards lifecycle envelopes to the parent as log
 *     lines (the daemon owns the real assistant event hub),
 *   - conversation writes are intentionally no-ops: transcripts reach the
 *     conversation daemon-side through meeting-bot's transcript-flush
 *     pipeline, not through `memory.addMessage`,
 *   - LLM / STT / TTS / speaker facets degrade to their documented
 *     unavailable values (empty / null / throw), since the sub-modules that
 *     would consume them are replaced with no-ops by the runtime.
 */

import {
  buildAssistantEvent,
  type DaemonRuntimeMode,
  type Logger,
  type SkillHost,
} from "./meet/plugin-host.ts";

/** Writer for JSON-lines messages to the parent (injected for testability). */
export type SendToParent = (obj: Record<string, unknown>) => void;

/** Build a subprocess-local logger that relays to the parent over stdout. */
export function createRelayLogger(name: string, send: SendToParent): Logger {
  const relay = (level: string) => (msg: string, meta?: unknown) => {
    send({ type: "log", level, msg: `[${name}] ${msg}`, meta });
  };
  return {
    debug: relay("debug"),
    info: relay("info"),
    warn: relay("warn"),
    error: relay("error"),
  };
}

export interface SubprocessHostArgs {
  workspaceDir: string;
  assistantName: string | null;
  runtimeMode: DaemonRuntimeMode;
  send: SendToParent;
}

/** Build the SkillHost the Vellum Runtime subprocess hands to the vendored subsystem. */
export function createSubprocessHost(args: SubprocessHostArgs): SkillHost {
  const { workspaceDir, assistantName, runtimeMode, send } = args;

  return {
    logger: {
      get: (name: string) => createRelayLogger(name, send),
    },
    config: {
      getSection: () => undefined,
    },
    identity: {
      getAssistantName: () => assistantName ?? undefined,
    },
    platform: {
      workspaceDir: () => workspaceDir,
      vellumRoot: (): string => {
        throw new Error("vellumRoot is not available in the Vellum Runtime subprocess");
      },
      runtimeMode: () => runtimeMode,
    },
    providers: {
      llm: {
        getConfigured: async () => null,
        userMessage: (): never => {
          throw new Error("llm.userMessage is not available in the Vellum Runtime subprocess");
        },
        extractToolUse: () => null,
        createTimeout: (ms: number) => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), ms);
          return { signal: controller.signal, cleanup: () => clearTimeout(timer) };
        },
      },
      stt: {
        listProviderIds: () => [],
        supportsBoundary: () => false,
        resolveStreamingTranscriber: async () => null,
      },
      tts: {
        get: (): never => {
          throw new Error("tts is not available in the Vellum Runtime subprocess");
        },
        resolveConfig: (): never => {
          throw new Error("tts is not available in the Vellum Runtime subprocess");
        },
      },
      secureKeys: {
        getProviderKey: async () => null,
      },
    },
    memory: {
      // Transcripts reach the conversation daemon-side via the transcript
      // flush; nothing in the subprocess writes conversation rows.
      addMessage: async () => undefined,
      wakeAgentForOpportunity: async () => undefined,
    },
    events: {
      publish: async (event) => {
        send({ type: "log", level: "debug", msg: "hub event", meta: event });
      },
      subscribe: () => ({ dispose: () => {}, active: false }),
      buildEvent: (message, conversationId) =>
        buildAssistantEvent(message, conversationId),
    },
    speakers: {
      createTracker: () => undefined,
    },
  };
}
