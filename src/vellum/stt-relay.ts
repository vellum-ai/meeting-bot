/**
 * Worker-side half of the streaming-transcription relay.
 *
 * Presents the plugin-api `StreamingTranscriber` contract inside the Vellum
 * Runtime worker by proxying every call over the worker's stdio channel to
 * the daemon, which owns the real session (see `stt-bridge.ts` and the wire
 * protocol in `stt-types.ts`). The vendored meet audio ingest consumes the
 * returned proxy exactly as it would a local transcriber.
 *
 * Events that arrive between `stt.opened` and the consumer's `start()` call
 * are buffered (bounded) and flushed on start, so nothing is lost in the
 * gap; in practice providers emit nothing before the first audio chunk.
 */

import type { SttStreamServerEvent, StreamingTranscriber } from "./stt-types.ts";

/** Time to wait for the daemon to answer an stt.open request. */
const OPEN_TIMEOUT_MS = 15_000;

/** Max events buffered per session before the consumer calls start(). */
const EVENT_BUFFER_LIMIT = 100;

export interface WorkerSttRelay {
  /**
   * Handle one daemon-to-worker message. Returns true when the message was
   * an `stt.*` message (handled here), false to let other handlers run.
   */
  handleMessage(msg: Record<string, unknown>): boolean;
  /**
   * Ask the daemon for a streaming transcription session. Resolves to a
   * proxy transcriber, or `null` when the daemon cannot open one (host too
   * old, no provider configured, missing credentials) or does not answer
   * within the timeout.
   */
  open(): Promise<StreamingTranscriber | null>;
}

interface SessionState {
  onEvent: ((event: SttStreamServerEvent) => void) | null;
  buffer: SttStreamServerEvent[];
}

export function createWorkerSttRelay(
  send: (msg: Record<string, unknown>) => void,
  log?: (msg: string) => void,
): WorkerSttRelay {
  const pendingOpens = new Map<
    number,
    (transcriber: StreamingTranscriber | null) => void
  >();
  const sessions = new Map<number, SessionState>();
  let nextRequestId = 1;

  function makeProxy(sessionId: number): StreamingTranscriber {
    const state: SessionState = { onEvent: null, buffer: [] };
    sessions.set(sessionId, state);
    return {
      start(onEvent: (event: SttStreamServerEvent) => void): Promise<void> {
        state.onEvent = onEvent;
        for (const event of state.buffer) onEvent(event);
        state.buffer = [];
        return Promise.resolve();
      },
      sendAudio(audio: Buffer, mimeType: string): void {
        send({
          type: "stt.audio",
          sessionId,
          chunk: audio.toString("base64"),
          mimeType,
        });
      },
      stop(): void {
        sessions.delete(sessionId);
        send({ type: "stt.stop", sessionId });
      },
      finalizeUtterance(): void {
        send({ type: "stt.finalize", sessionId });
      },
    };
  }

  return {
    handleMessage(msg: Record<string, unknown>): boolean {
      switch (msg.type) {
        case "stt.opened": {
          const requestId = Number(msg.requestId);
          const resolve = pendingOpens.get(requestId);
          if (!resolve) return true;
          pendingOpens.delete(requestId);
          const sessionId = Number(msg.sessionId);
          if (typeof msg.error === "string" || !Number.isFinite(sessionId)) {
            log?.(
              `transcription session unavailable: ${String(msg.error ?? "malformed stt.opened reply")}`,
            );
            resolve(null);
            return true;
          }
          resolve(makeProxy(sessionId));
          return true;
        }
        case "stt.event": {
          const state = sessions.get(Number(msg.sessionId));
          if (!state) return true;
          const event = msg.event as SttStreamServerEvent | undefined;
          if (!event || typeof event !== "object") return true;
          if (state.onEvent) {
            state.onEvent(event);
          } else if (state.buffer.length < EVENT_BUFFER_LIMIT) {
            state.buffer.push(event);
          }
          return true;
        }
        default:
          return false;
      }
    },
    open(): Promise<StreamingTranscriber | null> {
      const requestId = nextRequestId++;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (pendingOpens.delete(requestId)) {
            log?.(`transcription open request timed out after ${OPEN_TIMEOUT_MS}ms`);
            resolve(null);
          }
        }, OPEN_TIMEOUT_MS);
        if (typeof timer.unref === "function") timer.unref();
        pendingOpens.set(requestId, (transcriber) => {
          clearTimeout(timer);
          resolve(transcriber);
        });
        send({ type: "stt.open", requestId });
      });
    },
  };
}
