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

import type { MeetingBotConfig } from "./config.ts";
import {
  RealtimeMessageSchema,
  extractParticipantEvent,
  extractUtterance,
} from "./realtime-events.ts";
import {
  recordParticipantEvent,
  recordUtterance,
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

interface RunningServer {
  child: ChildProcess;
  address: string;
  logger: Logger;
  stdoutBuffer: string;
  stderrBuffer: string;
  ready: boolean;
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
 */
export function startRealtimeServer(
  config: MeetingBotConfig,
  logger: Logger,
): Promise<void> {
  if (running) {
    logger.warn(
      { address: realtimeServerAddress() },
      "meeting-bot: realtime server already running",
    );
    return Promise.resolve();
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
    };

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
        running = null;
      }
    });

    child.on("error", (err) => {
      clearTimeout(readyTimer);
      running = null;
      reject(new Error(`realtime subprocess spawn error: ${String(err)}`));
    });

    running = state;
  });
}

/**
 * Stop the realtime server subprocess. Sends "stop" on stdin, waits for
 * graceful exit, then escalates to SIGTERM and SIGKILL. Safe when not running.
 */
export async function stopRealtimeServer(): Promise<void> {
  if (!running) return;
  const { child, logger } = running;

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

  running = null;
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
      dispatchEvent(msg.event ?? "", msg.data ?? {}, state.logger);
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
): void {
  const parsed = RealtimeMessageSchema.safeParse({ event: eventName, data });
  if (!parsed.success) {
    logger.warn({ event: eventName }, "meeting-bot: dropping malformed realtime event from subprocess");
    return;
  }

  const msg = parsed.data;

  if (msg.event.startsWith("transcript.")) {
    const utterance = extractUtterance(msg);
    if (utterance) recordUtterance(utterance);
    return;
  }

  if (msg.event.startsWith("participant_events.")) {
    const participantEvent = extractParticipantEvent(msg);
    if (participantEvent) recordParticipantEvent(participantEvent);
    return;
  }

  logger.debug({ event: msg.event }, "meeting-bot: unhandled realtime event");
}
