/**
 * SkillHost implementation for the Vellum Runtime worker.
 *
 * The runtime executes outside the daemon: there is no InitContext and no
 * daemon services to call, so plugin-api methods are not available here.
 * This host keeps everything the vendored subsystem needs local to the
 * worker process:
 *
 *   - `logger` relays structured lines to the parent daemon over stdout
 *     (the supervisor forwards them to the plugin logger),
 *   - `platform` values arrive from the supervisor in the spawn argument,
 *   - `events.publish` forwards lifecycle envelopes to the parent as log
 *     lines (the daemon owns the real assistant event hub),
 *   - conversation writes are intentionally no-ops: transcripts reach the
 *     conversation daemon-side through meeting-bot's transcript-flush
 *     pipeline, not through `memory.addMessage`,
 *   - STT proxies to the daemon over the stdio relay (`stt-relay.ts`): the
 *     daemon opens real streaming sessions via the plugin-api
 *     `openTranscriptionSession` and the audio ingest here drives the proxy
 *     transcriber exactly like a local one,
 *   - LLM / TTS / speaker facets degrade to their documented unavailable
 *     values (empty / null / throw), since the sub-modules that would
 *     consume them are replaced with no-ops by the runtime.
 */

import {
  buildAssistantEvent,
  type DaemonRuntimeMode,
  type Logger,
  type SkillHost,
} from "./meet/plugin-host.ts";
import type { StreamingTranscriber } from "./stt-types.ts";

/** Writer for JSON-lines messages to the parent (injected for testability). */
export type SendToParent = (obj: Record<string, unknown>) => void;

/** Build a worker-local logger that relays to the parent over stdout. */
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

export interface WorkerHostArgs {
  workspaceDir: string;
  assistantName: string | null;
  runtimeMode: DaemonRuntimeMode;
  send: SendToParent;
  /**
   * Opener for streaming transcription sessions, normally the stdio relay's
   * `open()` (see stt-relay.ts). When absent (tests), the STT facet degrades
   * to null and joins fail with the audio ingest's descriptive error.
   */
  openSttSession?: () => Promise<StreamingTranscriber | null>;
}

/** Build the SkillHost the Vellum Runtime worker hands to the vendored subsystem. */
export function createWorkerHost(args: WorkerHostArgs): SkillHost {
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
        throw new Error("vellumRoot is not available in the Vellum Runtime worker");
      },
      runtimeMode: () => runtimeMode,
    },
    providers: {
      llm: {
        getConfigured: async () => null,
        userMessage: (): never => {
          throw new Error("llm.userMessage is not available in the Vellum Runtime worker");
        },
        extractToolUse: () => null,
        createTimeout: (ms: number) => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), ms);
          return { signal: controller.signal, cleanup: () => clearTimeout(timer) };
        },
      },
      stt: {
        // Provider identity lives host-side; these two exist only to shape
        // the audio ingest's "provider unusable" error message.
        listProviderIds: () => [],
        supportsBoundary: () => false,
        // The spec argument (sample rate, diarization preference) is
        // resolved host-side from the assistant's own STT config; the
        // audio format rides on each chunk's mimeType.
        resolveStreamingTranscriber: async () =>
          (await args.openSttSession?.()) ?? null,
      },
      tts: {
        get: (): never => {
          throw new Error("tts is not available in the Vellum Runtime worker");
        },
        resolveConfig: (): never => {
          throw new Error("tts is not available in the Vellum Runtime worker");
        },
      },
      secureKeys: {
        getProviderKey: async () => null,
      },
    },
    memory: {
      // Transcripts reach the conversation daemon-side via the transcript
      // flush; nothing in the worker writes conversation rows.
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
