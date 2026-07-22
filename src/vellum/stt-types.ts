/**
 * Streaming-transcription types shared by the daemon and the Vellum Runtime
 * worker, plus the wire messages the two exchange.
 *
 * The `StreamingTranscriber` / `SttStreamServerEvent` shapes are mirrored
 * from `@vellumai/plugin-api` (vellum-assistant PR #38722, shipping in
 * 0.10.12). The installed 0.10.10 package does not export them yet, so this
 * module is the single local source of truth; when the plugin's dependency
 * moves to 0.10.12, replace these mirrors with re-exports from the package
 * (`src/vellum/stt-api.ts` already feature-detects the runtime export).
 * The vendored audio ingest (`meet/daemon/audio-ingest.ts`) consumes a
 * structural subset of the same contract, so a transcriber of this type
 * satisfies it directly.
 *
 * ## Why a relay
 *
 * `openTranscriptionSession()` is an in-process daemon API: it can only be
 * called where the plugin's hooks run. The meet audio ingest lives in the
 * worker process, so the daemon owns the live session and the two sides
 * relay over the worker's existing stdio JSON-lines channel:
 *
 *   worker -> daemon (stdout):
 *     {"type":"stt.open","requestId":N}
 *     {"type":"stt.audio","sessionId":N,"chunk":"<base64>","mimeType":"..."}
 *     {"type":"stt.finalize","sessionId":N}
 *     {"type":"stt.stop","sessionId":N}
 *
 *   daemon -> worker (stdin):
 *     {"type":"stt.opened","requestId":N,"sessionId":N}
 *     {"type":"stt.opened","requestId":N,"error":"..."}
 *     {"type":"stt.event","sessionId":N,"event":{...SttStreamServerEvent}}
 *
 * Audio volume is modest (16 kHz mono PCM, ~43 KB/s per meeting after
 * base64), well within stdio pipe throughput.
 */

/** Normalized error category emitted on streaming errors. */
export type SttErrorCategory = string;

/** A partial (interim) transcript; may be revised by later events. */
export interface SttStreamServerPartialEvent {
  readonly type: "partial";
  readonly text: string;
  readonly speakerLabel?: string;
  readonly confidence?: number;
}

/** A final (committed) transcript segment. */
export interface SttStreamServerFinalEvent {
  readonly type: "final";
  readonly text: string;
  readonly speakerLabel?: string;
  readonly confidence?: number;
  /** True when this final flushes audio buffered before a finalize request. */
  readonly fromFinalize?: boolean;
}

/** All buffered audio has been flushed in response to finalizeUtterance. */
export interface SttStreamServerFinalizedEvent {
  readonly type: "finalized";
}

/** An error occurred during streaming transcription. */
export interface SttStreamServerErrorEvent {
  readonly type: "error";
  readonly category: SttErrorCategory;
  readonly message: string;
}

/** The streaming session has closed; no more events will be emitted. */
export interface SttStreamServerClosedEvent {
  readonly type: "closed";
}

/** Events a streaming transcription session emits to its consumer. */
export type SttStreamServerEvent =
  | SttStreamServerPartialEvent
  | SttStreamServerFinalEvent
  | SttStreamServerFinalizedEvent
  | SttStreamServerErrorEvent
  | SttStreamServerClosedEvent;

/**
 * Streaming transcriber contract: `start` once, feed `sendAudio`, `stop` to
 * close. `finalizeUtterance` (optional) asks the provider to flush buffered
 * audio into final events between utterances.
 */
export interface StreamingTranscriber {
  start(onEvent: (event: SttStreamServerEvent) => void): Promise<void>;
  sendAudio(audio: Buffer, mimeType: string): void;
  stop(): void;
  finalizeUtterance?(): void;
}
