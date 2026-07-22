/**
 * Daemon-side half of the streaming-transcription relay.
 *
 * Owns the live `StreamingTranscriber` sessions (opened via the in-process
 * plugin-api, see `stt-api.ts`) on behalf of the Vellum Runtime worker,
 * which cannot call plugin-api from its own OS process. The worker asks for
 * sessions and streams audio over its stdout JSON-lines channel; transcript
 * events flow back over the worker's stdin. See `stt-types.ts` for the wire
 * protocol.
 *
 * Message ordering makes the session map race-free: the worker only sends
 * `stt.audio` after it has received `stt.opened`, and both directions ride
 * ordered pipes, so a session is always registered here before its first
 * audio chunk arrives.
 */

import type { Logger } from "../realtime-server.ts";
import type { StreamingTranscriber } from "./stt-types.ts";

export interface DaemonSttBridge {
  /**
   * Handle one worker message. Returns true when the message was an
   * `stt.*` message (handled here), false to let other handlers run.
   */
  handleMessage(msg: Record<string, unknown>): boolean;
  /** Number of live sessions (test/observability helper). */
  sessionCount(): number;
  /** Stop every live session (worker exit, runtime shutdown). */
  stopAll(): void;
}

export interface DaemonSttBridgeOptions {
  /** Session opener, normally `openTranscriptionSession` from stt-api.ts. */
  openSession: () => Promise<StreamingTranscriber | null>;
  /** Writer for daemon-to-worker messages (the worker's stdin). */
  writeToWorker: (msg: Record<string, unknown>) => void;
  logger: Logger;
}

export function createDaemonSttBridge(
  opts: DaemonSttBridgeOptions,
): DaemonSttBridge {
  const { openSession, writeToWorker, logger } = opts;
  const sessions = new Map<number, StreamingTranscriber>();
  let nextSessionId = 1;

  async function handleOpen(requestId: number): Promise<void> {
    let transcriber: StreamingTranscriber | null;
    try {
      transcriber = await openSession();
    } catch (err) {
      transcriber = null;
      logger.warn(
        { error: String(err).slice(0, 300) },
        "meeting-bot: opening a transcription session failed",
      );
    }
    if (!transcriber) {
      writeToWorker({
        type: "stt.opened",
        requestId,
        error:
          "no streaming transcription session available (the host may predate plugin-api 0.10.12, or services.stt.provider is unset or missing credentials)",
      });
      return;
    }

    const sessionId = nextSessionId++;
    try {
      await transcriber.start((event) => {
        writeToWorker({ type: "stt.event", sessionId, event });
      });
    } catch (err) {
      writeToWorker({
        type: "stt.opened",
        requestId,
        error: `transcription session failed to start: ${String(err).slice(0, 300)}`,
      });
      return;
    }
    sessions.set(sessionId, transcriber);
    writeToWorker({ type: "stt.opened", requestId, sessionId });
    logger.info({ sessionId }, "meeting-bot: transcription session opened for the vellum worker");
  }

  return {
    handleMessage(msg: Record<string, unknown>): boolean {
      switch (msg.type) {
        case "stt.open": {
          const requestId = Number(msg.requestId);
          if (!Number.isFinite(requestId)) return true;
          void handleOpen(requestId);
          return true;
        }
        case "stt.audio": {
          const session = sessions.get(Number(msg.sessionId));
          const chunk = typeof msg.chunk === "string" ? msg.chunk : "";
          if (session && chunk) {
            const mimeType =
              typeof msg.mimeType === "string" && msg.mimeType
                ? msg.mimeType
                : "audio/pcm";
            try {
              session.sendAudio(Buffer.from(chunk, "base64"), mimeType);
            } catch (err) {
              logger.warn(
                { error: String(err).slice(0, 200) },
                "meeting-bot: transcription sendAudio failed",
              );
            }
          }
          return true;
        }
        case "stt.finalize": {
          const session = sessions.get(Number(msg.sessionId));
          try {
            session?.finalizeUtterance?.();
          } catch {
            // provider-side finalize failure is not actionable here
          }
          return true;
        }
        case "stt.stop": {
          const sessionId = Number(msg.sessionId);
          const session = sessions.get(sessionId);
          if (session) {
            sessions.delete(sessionId);
            try {
              session.stop();
            } catch {
              // best-effort close
            }
            logger.info({ sessionId }, "meeting-bot: transcription session stopped");
          }
          return true;
        }
        default:
          return false;
      }
    },
    sessionCount(): number {
      return sessions.size;
    },
    stopAll(): void {
      for (const [, session] of sessions) {
        try {
          session.stop();
        } catch {
          // best-effort close
        }
      }
      sessions.clear();
    },
  };
}
