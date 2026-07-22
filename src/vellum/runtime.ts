/**
 * Vellum Runtime supervisor: the daemon-side half of the vellum provider.
 *
 * The runtime itself (meet session manager, bot spawning, bot-event ingress,
 * and the loopback control server the skill scripts call) runs in its own OS
 * process (`src/vellum/worker.ts`, shown as `vellum-worker` in `assistant
 * ps`), mirroring how the Recall realtime receiver is isolated: heavyweight
 * work cannot block the daemon's event loop, and the runtime gets its own
 * crash boundary. This module spawns and supervises that worker and adapts
 * its relayed messages into meeting-bot's pipeline:
 *
 *   - `event` messages feed {@link handleVellumMeetEvent}: transcript chunks
 *     enter the session store and the same debounced transcript flush the
 *     Recall path uses; participant changes update the roster; terminal
 *     lifecycle states tear the session down.
 *   - `session` messages mirror worker-side joins/leaves into the in-memory
 *     session store and data/sessions.json (single writer: the daemon owns
 *     both).
 *   - `ready` marks the worker up. The control server binds
 *     `127.0.0.1:config.listenPort`, and the join/leave skill scripts read
 *     that port from resolved-config.json, so there is no separately
 *     published endpoint file to go stale. The control endpoint is
 *     loopback-only and internal, so there is no token.
 *
 * "Vellum Runtime" rather than "meet runtime": Google Meet is the first
 * adapter; other video-call platforms will slot in behind the same runtime.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import type { InitContext } from "@vellumai/plugin-api";

import type { MeetingBotConfig } from "../config.ts";
import { resolveAssistantName } from "../identity.ts";
import { pluginDataDir } from "../plugin-paths.ts";
import {
  clearTranscriptBuffer,
  ingestUtterance,
  type Logger,
} from "../realtime-server.ts";
import {
  closeSession,
  openSession,
  persistSessionEntry,
  recordParticipantEvent,
  removePersistedSession,
} from "../session-store.ts";
import { MeetBotEventSchema, type MeetBotEvent } from "./meet/contracts/index.ts";

/**
 * Legacy control-endpoint file under data/. Earlier versions published the
 * worker's ephemeral control port here; the port is now fixed to
 * `config.listenPort` and read from resolved-config.json, so any leftover
 * file is deleted at startup to keep stale ports out of QA sessions.
 */
const LEGACY_CONTROL_FILE = "vellum-control.json";

/**
 * Resolve the assistant workspace directory (moved here from the deleted
 * plugin-api host bridge).
 *
 * Preference order: `VELLUM_WORKSPACE_DIR`, then derivation from
 * `pluginStorageDir` (`<workspace>/plugins/<name>/data` or
 * `<workspace>/plugins-data/<name>`), then the storage dir itself with a
 * warning.
 */
export function resolveWorkspaceDirFromContext(ctx: InitContext): string {
  const fromEnv = process.env.VELLUM_WORKSPACE_DIR;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv;

  const storageDir = ctx.pluginStorageDir;
  const grandParent = dirname(dirname(storageDir));
  if (basename(grandParent) === "plugins") return dirname(grandParent);
  const parent = dirname(storageDir);
  if (basename(parent) === "plugins-data") return dirname(parent);

  ctx.logger.warn(
    { pluginStorageDir: storageDir },
    "meeting-bot: could not resolve the workspace dir (VELLUM_WORKSPACE_DIR unset, unrecognized plugin dir layout), falling back to the plugin storage dir",
  );
  return storageDir;
}

/** Time to wait for the worker to signal readiness. */
const READY_TIMEOUT_MS = 30_000;
/** Time to wait for graceful shutdown before SIGTERM. */
const STOP_GRACE_MS = 10_000;
/** Time to wait after SIGTERM before SIGKILL. */
const KILL_GRACE_MS = 3_000;

interface RunningRuntime {
  child: ChildProcess;
  logger: Logger;
  config: MeetingBotConfig;
  stdoutBuffer: string;
  ready: boolean;
  controlPort: number;
}

let running: RunningRuntime | null = null;

/** True when the Vellum Runtime worker is up. */
export function isVellumRuntimeRunning(): boolean {
  return running !== null && running.ready;
}

/**
 * Pipe one meet-bot event into meeting-bot's pipeline. Exported for direct
 * unit testing; production traffic arrives over the worker relay.
 */
export function handleVellumMeetEvent(
  meetingId: string,
  event: MeetBotEvent,
  opts: { logger: Logger; config: MeetingBotConfig },
): void {
  switch (event.type) {
    case "transcript.chunk": {
      ingestUtterance(
        {
          botId: meetingId,
          text: event.text,
          speakerName: event.speakerLabel,
          speakerId: event.speakerId,
          isPartial: !event.isFinal,
        },
        opts.logger,
        opts.config,
      );
      return;
    }
    case "participant.change": {
      for (const p of event.joined) {
        recordParticipantEvent({
          botId: meetingId,
          action: "join",
          participantId: p.id,
          participantName: p.name,
        });
      }
      for (const p of event.left) {
        recordParticipantEvent({
          botId: meetingId,
          action: "leave",
          participantId: p.id,
          participantName: p.name,
        });
      }
      return;
    }
    case "lifecycle": {
      opts.logger.info(
        { meetingId, state: event.state, detail: event.detail },
        "meeting-bot: vellum meet lifecycle",
      );
      if (event.state === "left" || event.state === "error") {
        clearTranscriptBuffer(meetingId);
        closeSession(meetingId);
        removePersistedSession(meetingId);
      }
      return;
    }
    default:
      // speaker.change / chat.inbound are not piped yet.
      return;
  }
}

/** Handle one JSON-lines message relayed from the worker. */
function handleWorkerMessage(
  msg: Record<string, unknown>,
  state: RunningRuntime,
  onReady: () => void,
): void {
  switch (msg.type) {
    case "ready": {
      state.ready = true;
      state.controlPort = Number(msg.controlPort) || 0;
      state.logger.info(
        { controlPort: state.controlPort, ingressPort: msg.ingressPort },
        "meeting-bot: Vellum Runtime worker is ready",
      );
      onReady();
      return;
    }
    case "log": {
      const level = msg.level === "error" || msg.level === "warn" ? msg.level : "info";
      state.logger[level](
        { meta: msg.meta },
        `meeting-bot: vellum runtime: ${String(msg.msg ?? "")}`,
      );
      return;
    }
    case "event": {
      const meetingId = typeof msg.meetingId === "string" ? msg.meetingId : "";
      const parsed = MeetBotEventSchema.safeParse(msg.event);
      if (!meetingId || !parsed.success) {
        state.logger.warn({}, "meeting-bot: dropping malformed vellum runtime event");
        return;
      }
      handleVellumMeetEvent(meetingId, parsed.data, {
        logger: state.logger,
        config: state.config,
      });
      return;
    }
    case "session": {
      const meetingId = typeof msg.meetingId === "string" ? msg.meetingId : "";
      if (!meetingId) return;
      if (msg.action === "opened") {
        const meetingUrl = typeof msg.meetingUrl === "string" ? msg.meetingUrl : "";
        const conversationId =
          typeof msg.conversationId === "string" ? msg.conversationId : null;
        openSession(meetingId, meetingUrl, conversationId, "vellum");
        persistSessionEntry({
          botId: meetingId,
          meetingUrl,
          conversationId,
          startedAt: typeof msg.startedAt === "number" ? msg.startedAt : Date.now(),
          provider: "vellum",
        });
      } else if (msg.action === "closed") {
        clearTranscriptBuffer(meetingId);
        closeSession(meetingId);
        removePersistedSession(meetingId);
      }
      return;
    }
    default:
      state.logger.debug({ msg }, "meeting-bot: unrecognized vellum runtime message");
  }
}

/**
 * Spawn the Vellum Runtime worker. Resolves once it signals readiness.
 * Idempotent: a second call while running is a no-op.
 */
export function initVellumRuntime(
  ctx: InitContext,
  config: MeetingBotConfig,
): Promise<void> {
  if (running) return Promise.resolve();

  try {
    rmSync(join(pluginDataDir(), LEGACY_CONTROL_FILE), { force: true });
  } catch {
    // best-effort cleanup of the legacy endpoint file
  }

  return new Promise<void>((resolve, reject) => {
    const args = {
      config,
      workspaceDir: resolveWorkspaceDirFromContext(ctx),
      assistantName: resolveAssistantName(ctx.pluginStorageDir),
      runtimeMode: process.env.IS_CONTAINERIZED ? "docker" : "bare-metal",
    };
    const encoded = Buffer.from(JSON.stringify(args), "utf-8").toString("base64");
    const scriptPath = new URL("./worker.ts", import.meta.url).pathname;

    const child = spawn(process.execPath, [scriptPath, encoded], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    const state: RunningRuntime = {
      child,
      logger: ctx.logger,
      config,
      stdoutBuffer: "",
      ready: false,
      controlPort: 0,
    };
    running = state;

    const readyTimer = setTimeout(() => {
      if (!state.ready) {
        ctx.logger.error(
          { timeoutMs: READY_TIMEOUT_MS },
          "meeting-bot: Vellum Runtime worker did not signal readiness in time",
        );
        try {
          child.kill("SIGKILL");
        } catch {
          // best-effort
        }
        running = null;
        reject(new Error(`Vellum Runtime worker not ready within ${READY_TIMEOUT_MS}ms`));
      }
    }, READY_TIMEOUT_MS);
    if (typeof readyTimer.unref === "function") readyTimer.unref();

    child.stdout?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => {
      state.stdoutBuffer += chunk;
      let idx: number;
      while ((idx = state.stdoutBuffer.indexOf("\n")) !== -1) {
        const line = state.stdoutBuffer.slice(0, idx).trim();
        state.stdoutBuffer = state.stdoutBuffer.slice(idx + 1);
        if (!line) continue;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line) as Record<string, unknown>;
        } catch {
          state.logger.warn({ line }, "meeting-bot: dropping unparseable vellum runtime line");
          continue;
        }
        handleWorkerMessage(msg, state, () => {
          clearTimeout(readyTimer);
          resolve();
        });
      }
    });

    child.stderr?.setEncoding("utf-8");
    child.stderr?.on("data", (chunk: string) => {
      const text = chunk.trim();
      if (text) ctx.logger.warn({ stderr: text.slice(0, 500) }, "meeting-bot: vellum runtime stderr");
    });

    child.on("exit", (code, signal) => {
      clearTimeout(readyTimer);
      if (!state.ready) {
        running = null;
        reject(new Error(`Vellum Runtime worker exited before readiness (code=${code}, signal=${signal})`));
      } else if (running === state) {
        ctx.logger.info({ code, signal }, "meeting-bot: Vellum Runtime worker exited");
        running = null;
      }
    });

    child.on("error", (err) => {
      clearTimeout(readyTimer);
      running = null;
      reject(new Error(`Vellum Runtime worker spawn error: ${String(err)}`));
    });
  });
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

/**
 * Stop the Vellum Runtime worker: graceful "stop" on stdin (bots leave),
 * then SIGTERM/SIGKILL. Safe when not running.
 */
export async function shutdownVellumRuntime(): Promise<void> {
  if (!running) return;
  const { child, logger } = running;
  running = null;

  try {
    child.stdin?.write("stop\n");
    child.stdin?.end();
  } catch {
    // stdin might already be closed
  }

  const exited = await waitForExit(child, STOP_GRACE_MS);
  if (!exited) {
    logger.warn({}, "meeting-bot: Vellum Runtime did not exit gracefully, sending SIGTERM");
    try {
      child.kill("SIGTERM");
    } catch {
      // already dead
    }
    const terminated = await waitForExit(child, KILL_GRACE_MS);
    if (!terminated) {
      try {
        child.kill("SIGKILL");
      } catch {
        // already dead
      }
    }
  }
  logger.info({}, "meeting-bot: Vellum Runtime stopped");
}
