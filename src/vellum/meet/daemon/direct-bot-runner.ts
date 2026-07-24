/**
 * Direct (no-Docker) Meet-bot runner.
 *
 * Implements the same surface the session manager uses from
 * {@link DockerRunner} (`run` / `stop` / `kill` / `remove` / `inspect` /
 * `logs` / `wait` / `listContainers`), but instead of spawning a container
 * per meeting it runs the bot entrypoint (`bot/main.ts`) as a child
 * process of the assistant. The `init` hook selects this backend when no
 * Docker Engine is reachable (see `meet-backend.ts`).
 *
 * The bot resolves every runtime path from the environment (`HTTP_PORT`,
 * `EXTENSION_PATH`, `NMH_SOCKET_PATH`, `CHROME_USER_DATA_ROOT`,
 * `XVFB_DISPLAY`, `DAEMON_AUDIO_HOST`), so this runner drives it entirely
 * through env overrides - no bot-side changes are required. The container
 * defaults (`/app/ext`, `/run/nmh.sock`, `host.docker.internal`) are
 * remapped here to writable, host-reachable equivalents.
 *
 * The bot still needs its browser stack (Xvfb + PulseAudio + a real
 * Chromium with the built controller extension) present on the host in this
 * mode - direct mode removes the container boundary, not the dependency.
 */

import { existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join as pathJoin, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  BoundPort,
  ContainerInspect,
  ContainerListEntry,
  DockerRunOptions,
  DockerRunResult,
  DockerWaitResult,
} from "./docker-runner.js";
import type { Logger } from "../plugin-host.js";

/** Minimal slice of a spawned child we depend on - keeps the runner testable. */
export interface SpawnedProcess {
  readonly pid: number;
  readonly exited: Promise<number>;
  readonly stdout?: ReadableStream<Uint8Array> | null;
  readonly stderr?: ReadableStream<Uint8Array> | null;
  kill(signal?: number | NodeJS.Signals): void;
}

/** `Bun.spawn`-shaped factory. Injected so tests can supply a fake. */
export type SpawnFn = (
  cmd: string[],
  options: {
    env: Record<string, string>;
    cwd?: string;
    stdin: "ignore";
    stdout: "pipe";
    stderr: "pipe";
  },
) => SpawnedProcess;

const NOOP_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Default resolver for the bot entrypoint, relative to this module. */
function defaultBotMainPath(): string {
  return fileURLToPath(new URL("../bot/main.ts", import.meta.url));
}

/**
 * Ensure the built extension exists at `extensionPath`, building it from
 * the sibling source tree when missing.
 *
 * The bot container builds `meet-controller-ext/dist` at image-build time;
 * direct mode has no image build, so the first join on a host would
 * otherwise hand Chrome a `--load-extension` path with nothing behind it
 * ("Manifest file is missing or unreadable") and the ready handshake can
 * never happen. The build runs offline: the extension's node_modules are
 * vendored in the plugin tree.
 */
export async function ensureExtensionBuilt(
  extensionPath: string,
  opts: { spawn?: SpawnFn; logger?: Logger } = {},
): Promise<void> {
  if (existsSync(pathJoin(extensionPath, "manifest.json"))) return;

  const log = opts.logger ?? NOOP_LOGGER;
  const srcDir = pathResolve(extensionPath, "..");
  const buildScript = pathJoin(srcDir, "scripts", "build.ts");
  if (!existsSync(buildScript)) {
    throw new Error(
      `Meet controller extension dist is missing at ${extensionPath} and there is no build script at ${buildScript}; ` +
        "Chrome cannot load the extension, so the join would hang waiting for the ready handshake",
    );
  }

  log.info("Building the Meet controller extension", { srcDir });
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  const spawnFn = opts.spawn ?? (Bun.spawn as unknown as SpawnFn);
  const proc = spawnFn(["bun", "run", "scripts/build.ts"], {
    env,
    cwd: srcDir,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const chunks: string[] = [];
  const decoder = new TextDecoder();
  const drain = async (
    stream: ReadableStream<Uint8Array> | null | undefined,
  ): Promise<void> => {
    if (!stream) return;
    try {
      for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
        chunks.push(decoder.decode(chunk, { stream: true }));
      }
    } catch {
      // Stream torn down with the process.
    }
  };
  const [code] = await Promise.all([
    proc.exited,
    drain(proc.stdout),
    drain(proc.stderr),
  ]);

  if (code !== 0 || !existsSync(pathJoin(extensionPath, "manifest.json"))) {
    const output = chunks.join("").trim().slice(-600);
    throw new Error(
      `Meet controller extension build failed (exit ${code}); Chrome cannot load the extension${output ? `: ${output}` : ""}`,
    );
  }
  log.info("Meet controller extension built", { extensionPath });
}

/** Allocate a free loopback TCP port by binding :0 and reading it back. */
function allocateEphemeralPort(hostIp: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, hostIp, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("failed to allocate an ephemeral port"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

export interface DirectBotRunnerOptions {
  /** Structured logger. Defaults to a no-op. */
  logger?: Logger;
  /** Absolute path to `bot/main.ts`. Defaults to a module-relative resolve. */
  botMainPath?: string;
  /** Runtime binary that runs the bot entrypoint. Defaults to `"bun"`. */
  runtime?: string;
  /** Spawn implementation. Defaults to `Bun.spawn`. */
  spawn?: SpawnFn;
  /** Port allocator. Injectable for tests. */
  allocatePort?: (hostIp: string) => Promise<number>;
  /** Root for per-meeting scratch dirs (profiles, sockets). Defaults to the OS tmpdir. */
  scratchRoot?: string;
  /**
   * Ensure the built extension exists before a bot spawns. Defaults to
   * {@link ensureExtensionBuilt}; injectable for tests.
   */
  ensureExtension?: (extensionPath: string) => Promise<void>;
}

interface TrackedBot {
  readonly proc: SpawnedProcess;
  readonly boundPorts: BoundPort[];
  readonly logChunks: string[];
  exitCode: number | null;
}

/**
 * Runs the Meet bot as a direct child process. One instance is shared across
 * joins; each `run()` spawns and tracks one bot, keyed by a synthetic
 * `direct:<pid>` id that stands in for a container id everywhere the session
 * manager expects one.
 */
export class DirectBotRunner {
  private readonly log: Logger;
  private readonly botMainPath: string;
  private readonly runtime: string;
  private readonly spawn: SpawnFn;
  private readonly allocatePort: (hostIp: string) => Promise<number>;
  private readonly scratchRoot: string;
  private readonly ensureExtension: (extensionPath: string) => Promise<void>;
  private readonly bots = new Map<string, TrackedBot>();
  /** In-flight/completed extension ensure, shared across concurrent joins. */
  private extensionReady: Promise<void> | null = null;

  constructor(opts: DirectBotRunnerOptions = {}) {
    this.log = opts.logger ?? NOOP_LOGGER;
    this.botMainPath = opts.botMainPath ?? defaultBotMainPath();
    this.runtime = opts.runtime ?? "bun";
    this.spawn = opts.spawn ?? (Bun.spawn as unknown as SpawnFn);
    this.allocatePort = opts.allocatePort ?? allocateEphemeralPort;
    this.scratchRoot = opts.scratchRoot ?? tmpdir();
    this.ensureExtension =
      opts.ensureExtension ??
      ((extensionPath) =>
        ensureExtensionBuilt(extensionPath, {
          spawn: this.spawn,
          logger: this.log,
        }));
  }

  /**
   * Spawn the bot for one meeting. Allocates a loopback port the bot's HTTP
   * server binds to (so the daemon can reach it exactly as it would a
   * published container port) and returns a container-shaped result.
   */
  async run(opts: DockerRunOptions): Promise<DockerRunResult> {
    // The session manager requests a single mapping for the bot's internal
    // HTTP port; honor whatever it asked for so this runner stays agnostic
    // to the specific port number.
    const requested = opts.ports?.[0];
    const hostIp = requested?.hostIp ?? "127.0.0.1";
    const containerPort = requested?.containerPort ?? 3000;
    const protocol = requested?.protocol ?? "tcp";

    const port = await this.allocatePort(hostIp);

    const meetingId =
      opts.labels?.["vellum.meet.meetingId"] ?? String(port);
    const scratchDir = pathJoin(
      this.scratchRoot,
      `vellum-meet-${meetingId}`,
    );
    mkdirSync(scratchDir, { recursive: true });

    const env = this.buildEnv(opts.env ?? {}, port, scratchDir);

    // Build the extension once per runner lifetime (a no-op when the dist
    // already exists). Serialized so concurrent joins share one build; a
    // failed build clears the latch so the next join can retry.
    if (this.extensionReady === null) {
      const ensure = this.ensureExtension(env.EXTENSION_PATH ?? "");
      this.extensionReady = ensure;
      ensure.catch(() => {
        if (this.extensionReady === ensure) this.extensionReady = null;
      });
    }
    await this.extensionReady;

    const proc = this.spawn([this.runtime, "run", this.botMainPath], {
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    const containerId = `direct:${proc.pid}`;
    const boundPorts: BoundPort[] = [
      { protocol, containerPort, hostIp, hostPort: port },
    ];
    const tracked: TrackedBot = {
      proc,
      boundPorts,
      logChunks: [],
      exitCode: null,
    };
    this.bots.set(containerId, tracked);

    this.pipeLogs(proc.stdout, tracked);
    this.pipeLogs(proc.stderr, tracked);
    void proc.exited.then((code) => {
      tracked.exitCode = code;
    });

    this.log.info("Spawned meet bot as a direct child process", {
      containerId,
      meetingId,
      pid: proc.pid,
      hostPort: port,
      botMainPath: this.botMainPath,
    });

    return { containerId, boundPorts };
  }

  async stop(containerId: string, timeoutSec = 10): Promise<void> {
    const tracked = this.bots.get(containerId);
    if (tracked === undefined) return;
    tracked.proc.kill("SIGTERM");
    const timedOut = await this.raceExit(tracked.proc, timeoutSec * 1000);
    if (timedOut) {
      // Graceful shutdown window elapsed - escalate.
      tracked.proc.kill("SIGKILL");
      await tracked.proc.exited.catch(() => {});
    }
  }

  async kill(
    containerId: string,
    signal: NodeJS.Signals = "SIGKILL",
  ): Promise<void> {
    const tracked = this.bots.get(containerId);
    if (tracked === undefined) return;
    tracked.proc.kill(signal);
    await tracked.proc.exited.catch(() => {});
  }

  async remove(containerId: string): Promise<void> {
    const tracked = this.bots.get(containerId);
    if (tracked !== undefined) {
      // Best-effort teardown so `remove` never leaves a live child behind,
      // mirroring Docker's force-remove semantics used on the rollback path.
      try {
        tracked.proc.kill("SIGKILL");
        await tracked.proc.exited.catch(() => {});
      } finally {
        this.bots.delete(containerId);
      }
    }
  }

  async inspect(containerId: string): Promise<ContainerInspect> {
    const tracked = this.bots.get(containerId);
    if (tracked === undefined) {
      throw new Error(`no such direct bot: ${containerId}`);
    }
    const running = tracked.exitCode === null;
    return {
      Id: containerId,
      State: {
        Status: running ? "running" : "exited",
        Running: running,
        ExitCode: tracked.exitCode ?? 0,
      },
    };
  }

  async wait(containerId: string): Promise<DockerWaitResult> {
    const tracked = this.bots.get(containerId);
    if (tracked === undefined) {
      throw new Error(`no such direct bot: ${containerId}`);
    }
    const code = await tracked.proc.exited;
    return { StatusCode: code };
  }

  async logs(
    containerId: string,
    opts: { tailLines?: number } = {},
  ): Promise<string> {
    const tracked = this.bots.get(containerId);
    if (tracked === undefined) return "";
    const lines = tracked.logChunks.join("").split("\n");
    if (opts.tailLines !== undefined && opts.tailLines < lines.length) {
      return lines.slice(lines.length - opts.tailLines).join("\n");
    }
    return tracked.logChunks.join("");
  }

  /**
   * Direct mode has no persistent, cross-restart bot containers to reap - a
   * child process dies with the daemon - so the orphan reaper finds nothing.
   */
  async listContainers(): Promise<ContainerListEntry[]> {
    return [];
  }

  /**
   * Map the container-oriented bot env onto direct-mode equivalents.
   * Inherits the daemon's own environment (so the child can find `bun`,
   * `chromium`, `Xvfb`, etc. on `PATH`), then overlays the caller's env and
   * the direct-mode path/port overrides.
   */
  private buildEnv(
    callerEnv: Record<string, string>,
    port: number,
    scratchDir: string,
  ): Record<string, string> {
    const base: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) base[key] = value;
    }

    const directDefaults: Record<string, string> = {
      // Container default is `/app/ext`; in direct mode point at the built
      // controller extension unless the operator overrode it.
      EXTENSION_PATH:
        process.env.MEET_EXTENSION_PATH?.trim() ||
        fileURLToPath(new URL("../meet-controller-ext/dist", import.meta.url)),
      // Container defaults (`/run/nmh.sock`, `/tmp/chrome-profile`) may not be
      // writable outside a container - scope both under a per-meeting dir.
      NMH_SOCKET_PATH: pathJoin(scratchDir, "nmh.sock"),
      CHROME_USER_DATA_ROOT: pathJoin(scratchDir, "chrome-profile"),
    };

    const env: Record<string, string> = {
      ...base,
      ...directDefaults,
      ...callerEnv,
    };

    // Always bind the bot's HTTP server to the port we allocated and told the
    // daemon about.
    env.HTTP_PORT = String(port);
    // The bot defaults `DAEMON_AUDIO_HOST` to `host.docker.internal`, which
    // only resolves inside a container. In direct mode the daemon is on the
    // same host, so reach it over loopback unless explicitly set.
    if (callerEnv.DAEMON_AUDIO_HOST === undefined) {
      env.DAEMON_AUDIO_HOST = "127.0.0.1";
    }

    return env;
  }

  private pipeLogs(
    stream: ReadableStream<Uint8Array> | null | undefined,
    tracked: TrackedBot,
  ): void {
    if (!stream) return;
    const decoder = new TextDecoder();
    void (async () => {
      try {
        for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
          tracked.logChunks.push(decoder.decode(chunk, { stream: true }));
        }
      } catch {
        // Stream torn down with the process - nothing to recover.
      }
    })();
  }

  private async raceExit(
    proc: SpawnedProcess,
    timeoutMs: number,
  ): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), timeoutMs);
    });
    const exited = proc.exited.then(() => false);
    const result = await Promise.race([exited, timeout]);
    if (timer !== undefined) clearTimeout(timer);
    return result;
  }
}

/**
 * SkillHost-agnostic factory for {@link DirectBotRunner}. Mirrors
 * `createDockerRunner`'s shape so the session manager can swap backends
 * behind one factory signature.
 */
export function createDirectBotRunner(
  logger?: Logger,
): DirectBotRunner {
  return new DirectBotRunner({ logger });
}
