/**
 * Tests for `daemon/direct-bot-runner.ts`.
 *
 * The direct runner spawns the bot entrypoint as a child process instead of
 * a container. These tests inject a fake `spawn` + port allocator so they
 * exercise the runner's contract (env mapping, port binding, lifecycle,
 * log capture) without launching a real bot or browser stack.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DirectBotRunner,
  type SpawnedProcess,
  type SpawnFn,
} from "../direct-bot-runner.js";
import type { DockerRunOptions } from "../docker-runner.js";

interface FakeProc extends SpawnedProcess {
  resolveExit: (code: number) => void;
  killed: Array<number | NodeJS.Signals | undefined>;
}

function makeFakeProc(pid: number, logChunks: string[] = []): FakeProc {
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const killed: Array<number | NodeJS.Signals | undefined> = [];
  const stdout =
    logChunks.length > 0
      ? new ReadableStream<Uint8Array>({
          start(controller) {
            const enc = new TextEncoder();
            for (const c of logChunks) controller.enqueue(enc.encode(c));
            controller.close();
          },
        })
      : null;
  return {
    pid,
    exited,
    stdout,
    stderr: null,
    kill(signal) {
      killed.push(signal);
    },
    resolveExit,
    killed,
  };
}

let scratchRoot: string;
let lastSpawn: { cmd: string[]; env: Record<string, string> } | null;

function makeRunner(proc: FakeProc, allocatedPort = 54321): DirectBotRunner {
  lastSpawn = null;
  const spawn: SpawnFn = (cmd, options) => {
    lastSpawn = { cmd, env: options.env };
    return proc;
  };
  return new DirectBotRunner({
    spawn,
    allocatePort: async () => allocatedPort,
    botMainPath: "/plugin/bot/main.ts",
    scratchRoot,
    // These tests target spawn/lifecycle behavior; the extension-ensure
    // path is covered by extension-build.test.ts. Without this stub the
    // default ensure would really build (or hang on the fake spawn's
    // never-closing streams) whenever the local dist is absent, which is
    // exactly what CI hit.
    ensureExtension: async () => {},
  });
}

const baseOpts: DockerRunOptions = {
  image: "vellum-meet-bot:dev",
  env: { MEET_URL: "https://meet.google.com/abc-defg-hij" },
  ports: [
    { hostIp: "127.0.0.1", hostPort: 0, containerPort: 3000, protocol: "tcp" },
  ],
  labels: { "vellum.meet.meetingId": "m-123" },
};

beforeEach(() => {
  scratchRoot = mkdtempSync(join(tmpdir(), "direct-bot-runner-test-"));
});

afterEach(() => {
  rmSync(scratchRoot, { recursive: true, force: true });
});

describe("DirectBotRunner.run", () => {
  test("spawns the bot entrypoint with the allocated HTTP port", async () => {
    const proc = makeFakeProc(4242);
    const runner = makeRunner(proc, 54321);

    const result = await runner.run(baseOpts);

    expect(lastSpawn?.cmd).toEqual(["bun", "run", "/plugin/bot/main.ts"]);
    expect(lastSpawn?.env.HTTP_PORT).toBe("54321");
    expect(result.containerId).toBe("direct:4242");
    expect(result.boundPorts).toEqual([
      { protocol: "tcp", containerPort: 3000, hostIp: "127.0.0.1", hostPort: 54321 },
    ]);
  });

  test("passes through caller env and defaults DAEMON_AUDIO_HOST to loopback", async () => {
    const proc = makeFakeProc(1);
    const runner = makeRunner(proc);

    await runner.run(baseOpts);

    expect(lastSpawn?.env.MEET_URL).toBe(
      "https://meet.google.com/abc-defg-hij",
    );
    // Container default is host.docker.internal - direct mode must reach the
    // daemon over loopback instead.
    expect(lastSpawn?.env.DAEMON_AUDIO_HOST).toBe("127.0.0.1");
    // Container path defaults are remapped under the per-meeting scratch dir.
    expect(lastSpawn?.env.NMH_SOCKET_PATH).toContain("vellum-meet-m-123");
    expect(lastSpawn?.env.CHROME_USER_DATA_ROOT).toContain("chrome-profile");
  });

  test("respects a caller-provided DAEMON_AUDIO_HOST", async () => {
    const proc = makeFakeProc(1);
    const runner = makeRunner(proc);

    await runner.run({
      ...baseOpts,
      env: { ...baseOpts.env, DAEMON_AUDIO_HOST: "10.0.0.5" },
    });

    expect(lastSpawn?.env.DAEMON_AUDIO_HOST).toBe("10.0.0.5");
  });
});

describe("DirectBotRunner lifecycle", () => {
  test("wait resolves the child's exit code as StatusCode", async () => {
    const proc = makeFakeProc(7);
    const runner = makeRunner(proc);
    const { containerId } = await runner.run(baseOpts);

    proc.resolveExit(3);
    const result = await runner.wait(containerId);
    expect(result.StatusCode).toBe(3);
  });

  test("inspect reflects running then exited", async () => {
    const proc = makeFakeProc(8);
    const runner = makeRunner(proc);
    const { containerId } = await runner.run(baseOpts);

    const before = await runner.inspect(containerId);
    expect(before.State?.Running).toBe(true);

    proc.resolveExit(0);
    await proc.exited;
    // Let the `.then` that records the exit code settle.
    await Promise.resolve();
    const after = await runner.inspect(containerId);
    expect(after.State?.Running).toBe(false);
    expect(after.State?.Status).toBe("exited");
  });

  test("logs accumulates the child's stdout", async () => {
    const proc = makeFakeProc(9, ["hello ", "world\n"]);
    const runner = makeRunner(proc);
    const { containerId } = await runner.run(baseOpts);

    // Give the async stream pump a tick to drain.
    await new Promise((r) => setTimeout(r, 5));
    const body = await runner.logs(containerId);
    expect(body).toBe("hello world\n");
  });

  test("stop sends SIGTERM and does not escalate when the child exits", async () => {
    const proc = makeFakeProc(10);
    const runner = makeRunner(proc);
    const { containerId } = await runner.run(baseOpts);

    const stopping = runner.stop(containerId, 5);
    proc.resolveExit(0);
    await stopping;

    expect(proc.killed).toEqual(["SIGTERM"]);
  });

  test("stop escalates to SIGKILL when the graceful window elapses", async () => {
    const proc = makeFakeProc(11);
    const runner = makeRunner(proc);
    const { containerId } = await runner.run(baseOpts);

    // timeoutSec 0 → the grace window elapses before the child exits, so the
    // runner must escalate. Let the timeout fire (SIGKILL) *before* the child
    // finally exits.
    const stopping = runner.stop(containerId, 0);
    await new Promise((r) => setTimeout(r, 10));
    expect(proc.killed).toEqual(["SIGTERM", "SIGKILL"]);

    proc.resolveExit(137);
    await stopping;
  });

  test("kill forwards the requested signal", async () => {
    const proc = makeFakeProc(12);
    const runner = makeRunner(proc);
    const { containerId } = await runner.run(baseOpts);

    proc.resolveExit(0);
    await runner.kill(containerId, "SIGINT");
    expect(proc.killed).toContain("SIGINT");
  });

  test("listContainers is empty - direct mode has no orphan containers", async () => {
    const proc = makeFakeProc(13);
    const runner = makeRunner(proc);
    await runner.run(baseOpts);
    expect(await runner.listContainers()).toEqual([]);
  });
});
