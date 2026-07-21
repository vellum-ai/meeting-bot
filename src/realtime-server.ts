/**
 * Realtime receiver manager — spawns and supervises the WebSocket server
 * subprocess that Recall dials back into.
 *
 * ## Why a subprocess
 *
 * The realtime WebSocket listener runs in its own OS process, spawned by the
 * plugin's `init` hook. This isolates the connection-handling and frame-parsing
 * hot path from the daemon's event loop: a flood of realtime frames cannot
 * block LLM calls or tool execution, and the server has its own crash/restart
 * boundary. It also makes the server visible in the assistant's process tree
 * (`assistant ps` shows it as a child of the daemon).
 *
 * ## Protocol
 *
 * The subprocess communicates with the parent over stdio:
 *
 *   stdout: JSON-lines, one object per line. See {@link SubprocessMessage}.
 *   stdin:  The parent writes "stop\n" to request graceful shutdown. When
 *           stdin closes (parent died), the subprocess self-terminates.
 *
 * The parent reads stdout line-by-line: a `ready` message marks the server as
 * listening; `event` messages are dispatched to the session store; `log`
 * messages are forwarded to the plugin logger.
 *
 * ## Lifecycle
 *
 * `startRealtimeServer` spawns the subprocess and waits for the `ready` signal
 * (with a timeout). `stopRealtimeServer` sends the stop command, waits for
 * exit, and falls back to SIGTERM/SIGKILL if the child does not exit cleanly.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runConversationTurn, synthesizeText, type ContentBlock } from "@vellumai/plugin-api";

import type { MeetingBotConfig } from "./config.ts";
import {
  RealtimeMessageSchema,
  extractParticipantEvent,
  extractUtterance,
  type NormalizedUtterance,
} from "./realtime-events.ts";
import { outputAudio } from "./recall-client.ts";
import {
  closeSession,
  getSession,
  recordParticipantEvent,
  recordUtterance,
  loadSessionsFromFile,
} from "./session-store.ts";

/** Minimal logger surface (matches the host's PluginLogger shape). */
export interface Logger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
  debug(obj: Record<string, unknown>, msg?: string): void;
}

/** Messages the subprocess emits on stdout, parsed by the parent. */
interface SubprocessMessage {
  type: "ready" | "connection" | "event" | "log";
  address?: string;
  remote?: string;
  action?: string;
  code?: number;
  event?: string;
  data?: Record<string, unknown>;
  level?: string;
  msg?: string;
}

/** Time to wait for the subprocess to signal readiness. */
const READY_TIMEOUT_MS = 10_000;
/** Time to wait for graceful shutdown before SIGTERM. */
const STOP_GRACE_MS = 5_000;
/** Time to wait after SIGTERM before SIGKILL. */
const KILL_GRACE_MS = 3_000;

/**
 * Name of the file, written under the plugin storage dir, that records the
 * current realtime subprocess's PID. It lets a fresh daemon process (after a
 * plugin reload) reap a subprocess the previous daemon left bound to the port,
 * instead of dying with EADDRINUSE.
 */
const PID_FILE_NAME = "realtime-server.pid";

/**
 * Debounce window for transcript buffering. When no new finalized transcript
 * event arrives for this duration, the buffered lines are flushed to the
 * conversation for LLM processing. A typical speaking pause is well under a
 * second, so this catches sentence/clause boundaries without holding content
 * so long that the assistant loses real-time awareness.
 */
const TRANSCRIPT_FLUSH_DEBOUNCE_MS = 1_000;

/**
 * Per-session transcript buffer and debounce timer, keyed by bot id. The
 * buffer accumulates finalized utterances; the timer fires the flush when the
 * stream goes quiet for {@link TRANSCRIPT_FLUSH_DEBOUNCE_MS}.
 */
interface BufferState {
  lines: { speaker: string; text: string }[];
  timer: ReturnType<typeof setTimeout> | null;
}

const transcriptBuffers = new Map<string, BufferState>();

interface RunningServer {
  child: ChildProcess;
  address: string;
  logger: Logger;
  stdoutBuffer: string;
  stderrBuffer: string;
  ready: boolean;
  config: MeetingBotConfig;
  /** Path to the PID file for this subprocess, or null when not tracked. */
  pidFilePath: string | null;
}

let running: RunningServer | null = null;

/** True when the realtime server subprocess is running. */
export function isRealtimeServerRunning(): boolean {
  return running !== null && running.ready;
}

/** The address the server is bound to, for diagnostics. */
export function realtimeServerAddress(): string | null {
  if (!running) return null;
  return running.address;
}

/**
 * Spawn the realtime WebSocket server as a subprocess. Returns a promise that
 * resolves when the subprocess signals readiness (or rejects on timeout /
 * spawn failure). Idempotent: a second call while already running is a no-op.
 *
 * When `opts.pidFileDir` is supplied, the subprocess PID is recorded there and
 * a subprocess orphaned by a previous plugin load is reaped before spawning;
 * this is what prevents the "port 8790 in use" failure on reload.
 */
export async function startRealtimeServer(
  config: MeetingBotConfig,
  logger: Logger,
  opts: { pidFileDir?: string } = {},
): Promise<void> {
  if (running) {
    logger.warn(
      { address: realtimeServerAddress() },
      "meeting-bot: realtime server already running",
    );
    return;
  }

  const pidFilePath = opts.pidFileDir
    ? join(opts.pidFileDir, PID_FILE_NAME)
    : null;

  // Reap a subprocess left bound to the port by a previous plugin load so the
  // new spawn does not fail with EADDRINUSE. Best-effort: only a process that
  // is verifiably our realtime subprocess is killed.
  if (pidFilePath) {
    await reapStaleSubprocess(pidFilePath, logger);
  }

  return new Promise<void>((resolve, reject) => {
    // Pass the config as base64-encoded JSON in argv to avoid env-var size
    // limits and keep the command line readable.
    const configArg = Buffer.from(
      JSON.stringify(config),
      "utf-8",
    ).toString("base64");

    // Resolve the subprocess script path relative to this module.
    const scriptPath = new URL("./realtime-subprocess.ts", import.meta.url)
      .pathname;

    const child = spawn(
      process.execPath,
      [scriptPath, configArg],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
      },
    );

    const state: RunningServer = {
      child,
      address: "",
      logger,
      stdoutBuffer: "",
      stderrBuffer: "",
      ready: false,
      config,
      pidFilePath,
    };

    // Record the PID so a future daemon process can reap this subprocess if it
    // outlives us (e.g. across a plugin reload).
    if (pidFilePath && typeof child.pid === "number") {
      try {
        writeFileSync(pidFilePath, String(child.pid), "utf-8");
      } catch (err) {
        logger.warn(
          { error: String(err).slice(0, 200) },
          "meeting-bot: failed to write realtime subprocess pid file",
        );
      }
    }

    const readyTimer = setTimeout(() => {
      if (!state.ready) {
        logger.error(
          { timeoutMs: READY_TIMEOUT_MS },
          "meeting-bot: realtime subprocess did not signal readiness in time",
        );
        try {
          child.kill("SIGKILL");
        } catch {
          // best-effort
        }
        running = null;
        reject(
          new Error(
            `realtime subprocess did not become ready within ${READY_TIMEOUT_MS}ms`,
          ),
        );
      }
    }, READY_TIMEOUT_MS);
    if (typeof readyTimer.unref === "function") readyTimer.unref();

    child.stdout?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => {
      state.stdoutBuffer += chunk;
      let newlineIdx: number;
      while ((newlineIdx = state.stdoutBuffer.indexOf("\n")) !== -1) {
        const line = state.stdoutBuffer.slice(0, newlineIdx).trim();
        state.stdoutBuffer = state.stdoutBuffer.slice(newlineIdx + 1);
        if (line) handleSubprocessLine(line, state, readyTimer, resolve);
      }
    });

    child.stderr?.setEncoding("utf-8");
    child.stderr?.on("data", (chunk: string) => {
      state.stderrBuffer += chunk;
      let newlineIdx: number;
      while ((newlineIdx = state.stderrBuffer.indexOf("\n")) !== -1) {
        const line = state.stderrBuffer.slice(0, newlineIdx).trim();
        state.stderrBuffer = state.stderrBuffer.slice(newlineIdx + 1);
        if (line) {
          logger.warn({ stderr: line }, `meeting-bot: realtime subprocess stderr: ${line}`);
        }
      }
    });

    child.on("exit", (code, signal) => {
      clearTimeout(readyTimer);
      if (!state.ready) {
        running = null;
        reject(
          new Error(
            `realtime subprocess exited before readiness (code=${code}, signal=${signal})`,
          ),
        );
      } else if (running === state) {
        logger.info(
          { code, signal },
          "meeting-bot: realtime subprocess exited",
        );
        removePidFile(state.pidFilePath);
        running = null;
      }
    });

    child.on("error", (err) => {
      clearTimeout(readyTimer);
      running = null;
      reject(new Error(`realtime subprocess spawn error: ${String(err)}`));
    });

    running = state;

  // Sync sessions from the sessions file (written by the join script) so
  // the realtime server can correlate incoming events with conversations.
  // The join script runs as a separate process and writes sessions.json;
  // the realtime server reads it to find the conversationId for each bot.
  loadSessionsFromFile(state.config);
  });
}

/**
 * Stop the realtime server subprocess. Sends "stop" on stdin, waits for
 * graceful exit, then escalates to SIGTERM and SIGKILL. Safe when not running.
 */
export async function stopRealtimeServer(): Promise<void> {
  if (!running) return;
  const { child, logger, pidFilePath } = running;

  // Try graceful shutdown via stdin.
  try {
    child.stdin?.write("stop\n");
    child.stdin?.end();
  } catch {
    // stdin might already be closed
  }

  // Wait for exit, escalating to SIGTERM then SIGKILL.
  const exited = await waitForExit(child, STOP_GRACE_MS);
  if (!exited) {
    logger.warn({}, "meeting-bot: realtime subprocess did not exit gracefully, sending SIGTERM");
    try {
      child.kill("SIGTERM");
    } catch {
      // already dead
    }
    const terminated = await waitForExit(child, KILL_GRACE_MS);
    if (!terminated) {
      logger.warn({}, "meeting-bot: realtime subprocess did not respond to SIGTERM, sending SIGKILL");
      try {
        child.kill("SIGKILL");
      } catch {
        // already dead
      }
    }
  }

  removePidFile(pidFilePath);
  running = null;
  // Cancel any pending transcript flush timers so they don't fire after the
  // receiver is down.
  for (const [botId, state] of transcriptBuffers) {
    if (state.timer) clearTimeout(state.timer);
    transcriptBuffers.delete(botId);
  }
  logger.info({}, "meeting-bot: realtime server stopped");
}

/** Wait for the child to exit, resolving true if it exits within the timeout. */
function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True if a process with `pid` currently exists (signal 0 probe). */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Verify a PID belongs to *our* realtime subprocess before killing it, so a
 * recycled PID now owned by an unrelated process is never signalled. Reads the
 * process command line from `/proc` (Linux). When `/proc` is unavailable or
 * the command line cannot be read, returns false: we would rather leave a
 * stale process alone than risk killing the wrong one.
 */
function isOurSubprocess(pid: number): boolean {
  try {
    // /proc cmdline is NUL-separated; a substring match on the script name is
    // enough to distinguish our subprocess from any recycled PID.
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf-8");
    return cmdline.includes("realtime-subprocess");
  } catch {
    return false;
  }
}

/** Remove the PID file, ignoring errors (it may already be gone). */
function removePidFile(pidFilePath: string | null): void {
  if (!pidFilePath) return;
  try {
    if (existsSync(pidFilePath)) unlinkSync(pidFilePath);
  } catch {
    // best-effort
  }
}

/**
 * Reap a realtime subprocess recorded in `pidFilePath` if it is still alive and
 * verifiably ours. Escalates SIGTERM → SIGKILL and waits for the process to
 * exit so its listen port is released before the caller spawns a replacement.
 * Always clears the PID file when done.
 */
async function reapStaleSubprocess(
  pidFilePath: string,
  logger: Logger,
): Promise<void> {
  let pid: number;
  try {
    if (!existsSync(pidFilePath)) return;
    pid = Number.parseInt(readFileSync(pidFilePath, "utf-8").trim(), 10);
  } catch {
    return;
  }

  if (!Number.isInteger(pid) || pid <= 0) {
    removePidFile(pidFilePath);
    return;
  }

  // Only signal a process we can positively identify as our subprocess.
  if (!isProcessAlive(pid) || !isOurSubprocess(pid)) {
    removePidFile(pidFilePath);
    return;
  }

  logger.warn(
    { pid },
    "meeting-bot: reaping stale realtime subprocess from a previous load before restart",
  );

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // already gone
  }

  const termDeadline = Date.now() + STOP_GRACE_MS;
  while (Date.now() < termDeadline && isProcessAlive(pid)) {
    await delay(100);
  }

  if (isProcessAlive(pid)) {
    logger.warn(
      { pid },
      "meeting-bot: stale realtime subprocess did not exit on SIGTERM, sending SIGKILL",
    );
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
    const killDeadline = Date.now() + KILL_GRACE_MS;
    while (Date.now() < killDeadline && isProcessAlive(pid)) {
      await delay(100);
    }
  }

  removePidFile(pidFilePath);
}

/** Parse one stdout line from the subprocess and dispatch it. */
function handleSubprocessLine(
  line: string,
  state: RunningServer,
  readyTimer: ReturnType<typeof setTimeout>,
  resolve: () => void,
): void {
  let msg: SubprocessMessage;
  try {
    msg = JSON.parse(line);
  } catch {
    state.logger.warn({ line }, "meeting-bot: dropping unparseable subprocess stdout line");
    return;
  }

  switch (msg.type) {
    case "ready": {
      state.ready = true;
      state.address = msg.address ?? "unknown";
      clearTimeout(readyTimer);
      state.logger.info(
        { address: state.address },
        "meeting-bot: realtime server subprocess is listening",
      );
      resolve();
      break;
    }

    case "connection": {
      state.logger.info(
        { remote: msg.remote, action: msg.action, code: msg.code },
        `meeting-bot: realtime connection ${msg.action}`,
      );
      break;
    }

    case "event": {
        dispatchEvent(msg.event ?? "", msg.data ?? {}, state.logger, state.config);
        break;
      }

    case "log": {
      const level = msg.level ?? "info";
      const logFn = level === "error"
        ? state.logger.error
        : level === "warn"
          ? state.logger.warn
          : state.logger.info;
      logFn.call(state.logger, {}, `meeting-bot: ${msg.msg ?? ""}`);
      break;
    }

    default: {
      state.logger.debug({ msg }, "meeting-bot: unrecognized subprocess message type");
    }
  }
}

/** Route a realtime event to the session store. */
function dispatchEvent(
  eventName: string,
  data: Record<string, unknown>,
  logger: Logger,
  config: MeetingBotConfig,
): void {
  const parsed = RealtimeMessageSchema.safeParse({ event: eventName, data });
  if (!parsed.success) {
    logger.warn({ event: eventName }, "meeting-bot: dropping malformed realtime event from subprocess");
    return;
  }

  const msg = parsed.data;

  if (msg.event.startsWith("transcript.")) {
    const utterance = extractUtterance(msg);
    if (utterance) {
      // Always record finalized utterances in the session store (existing
      // behavior). recordUtterance already skips partials.
      recordUtterance(utterance);

      // Buffer finalized utterances and debounce a flush to the conversation.
      // Partials churn too fast and are not useful for LLM processing.
      if (!utterance.isPartial && utterance.botId) {
        bufferTranscript(utterance.botId, utterance, logger, config);
      }
    }
    return;
  }

  if (msg.event.startsWith("participant_events.")) {
    const participantEvent = extractParticipantEvent(msg);
    if (participantEvent) recordParticipantEvent(participantEvent);
    return;
  }

  logger.debug({ event: msg.event }, "meeting-bot: unhandled realtime event");
}

/**
 * Add a finalized utterance to the per-session buffer and (re)arm the debounce
 * timer. When the stream goes quiet for {@link TRANSCRIPT_FLUSH_DEBOUNCE_MS},
 * the buffer is flushed to the conversation.
 */
function bufferTranscript(
  botId: string,
  utterance: NormalizedUtterance,
  logger: Logger,
  config: MeetingBotConfig,
): void {
  let state = transcriptBuffers.get(botId);
  if (!state) {
    state = { lines: [], timer: null };
    transcriptBuffers.set(botId, state);
  }

  state.lines.push({
    speaker: utterance.speakerName ?? utterance.speakerId ?? "unknown",
    text: utterance.text,
  });

  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(() => {
    void flushTranscriptBuffer(botId, logger, config);
  }, TRANSCRIPT_FLUSH_DEBOUNCE_MS);
}

/**
 * Flush the buffered transcript for a session by running a full conversation
 * agent-loop turn via `runConversationTurn`. This reuses the assistant's
 * conversation machinery (history, tools, compaction, system prompt from
 * IDENTITY.md / SOUL.md, default-plugin injections) instead of a stateless
 * one-shot LLM call.
 *
 * After the turn responds, the response text is synthesized to speech via the
 * plugin-api TTS handle and sent to Recall's `output_audio` endpoint so the bot
 * speaks the response into the live meeting. (The `useVoiceMode` flag will
 * later switch this to the host's `createLiveVoiceConnection` API; see the TODO
 * below.)
 *
 * Errors are logged but never thrown — a failed flush must not crash the
 * realtime receiver.
 */
async function flushTranscriptBuffer(
  botId: string,
  logger: Logger,
  config: MeetingBotConfig,
): Promise<void> {
  const state = transcriptBuffers.get(botId);
  if (!state) return;

  // Clear the timer reference and grab the lines atomically.
  state.timer = null;
  const lines = state.lines;
  state.lines = [];

  if (lines.length === 0) return;

  const session = getSession(botId);
  if (!session || !session.conversationId) {
    // No conversation to flush to — the lines are already in the session
    // store transcript, so dropping them from the buffer is safe.
    return;
  }

  const content =
    `Live transcript from meeting ${session.meetingUrl}:\n` +
    lines.map((l) => `[${l.speaker}]: ${l.text}`).join("\n");

  try {
    const result = await runConversationTurn({
      conversationId: session.conversationId,
      content: [{ type: "text", text: content }],
    });

    // If the turn was queued (conversation was busy), there's no response
    // content to speak yet — it will be processed when the current turn
    // finishes.
    if (result.queued) {
      logger.info(
        { botId, conversationId: result.conversationId },
        "meeting-bot: transcript flush queued — conversation was busy",
      );
      return;
    }

    // Extract text from the assistant's content blocks for voice output.
    const responseText = extractTextFromContent(result.content);
    if (!responseText) {
      logger.debug({ botId }, "meeting-bot: assistant response has no text — skipping voice output");
      return;
    }

    logger.info(
      { botId, conversationId: result.conversationId },
      "meeting-bot: transcript flush — conversation turn complete",
    );

    // TODO(useVoiceMode): when config.useVoiceMode is set, produce the voice
    // response via the host's createLiveVoiceConnection live-voice API instead
    // of the text-to-speech path below. That API is not yet exported from
    // @vellumai/plugin-api, so for now every response uses the TTS path.

    // Synthesize the response text to speech via the plugin-api TTS handle,
    // which uses the assistant's globally configured TTS provider.
    // Text is sanitized internally (markdown/URLs/emoji stripped).
    let mp3B64: string;
    try {
      const ttsResult = await synthesizeText({
        text: responseText,
        useCase: "message-playback",
      });
      mp3B64 = ttsResult.audio.toString("base64");
    } catch (err) {
      logger.warn(
        { error: String(err).slice(0, 200), botId },
        "meeting-bot: TTS synthesis failed (non-fatal)",
      );
      return;
    }

    // Send the synthesized audio to Recall so the bot speaks it in the call.
    try {
      await outputAudio(config, botId, mp3B64);
      logger.info(
        { botId, textPreview: responseText.slice(0, 80) },
        "meeting-bot: voice response sent to call",
      );
    } catch (err) {
      logger.warn(
        { error: String(err).slice(0, 200), botId },
        "meeting-bot: output_audio failed (non-fatal)",
      );
    }
  } catch (err) {
    logger.warn(
      { error: String(err).slice(0, 200), botId },
      "meeting-bot: transcript flush failed (non-fatal)",
    );
  }
}

/**
 * Clear the transcript buffer and cancel any pending flush timer for a session.
 * Called when a session is closed so a late timer does not fire into a dead
 * session.
 */
export function clearTranscriptBuffer(botId: string): void {
  const state = transcriptBuffers.get(botId);
  if (!state) return;
  if (state.timer) clearTimeout(state.timer);
  transcriptBuffers.delete(botId);
}

/**
 * Extract concatenated text from a provider response's content blocks.
 * Non-text blocks (images, tool use, etc.) are skipped.
 */
function extractTextFromContent(content: ContentBlock[]): string {
  return content
    .filter(
      (block): block is Extract<ContentBlock, { type: "text" }> =>
        block.type === "text",
    )
    .map((block) => block.text)
    .join(" ")
    .trim();
}
