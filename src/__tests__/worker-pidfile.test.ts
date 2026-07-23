/**
 * Tests for the shared worker PID-file reaper: kills a recorded worker
 * whose cmdline matches, leaves recycled/unrelated PIDs alone, and always
 * clears the file.
 */

import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isProcessAlive,
  reapStaleWorker,
  removeWorkerPidFile,
  writeWorkerPidFile,
} from "../worker-pidfile.ts";
import { existsSync } from "node:fs";
import type { Logger } from "../realtime-server.ts";

const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "meeting-bot-pidfile-"));
}

/** Spawn a long-lived bun process whose cmdline contains `vellum/worker`. */
function spawnFakeWorker(dir: string): { pid: number; kill: () => void } {
  const scriptDir = join(dir, "vellum");
  mkdirSync(scriptDir, { recursive: true });
  const script = join(scriptDir, "worker-fake.ts");
  writeFileSync(script, "setInterval(() => {}, 1000);\n", "utf-8");
  const child = spawn(process.execPath, [script], { stdio: "ignore" });
  return {
    pid: child.pid!,
    kill: () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    },
  };
}

describe("reapStaleWorker", () => {
  test("kills a live recorded worker and clears the pid file", async () => {
    const dir = tmp();
    const worker = spawnFakeWorker(dir);
    const pidFile = join(dir, "worker.pid");
    writeWorkerPidFile(pidFile, worker.pid);
    try {
      expect(isProcessAlive(worker.pid)).toBe(true);
      await reapStaleWorker(pidFile, "vellum/worker", noopLogger);
      expect(isProcessAlive(worker.pid)).toBe(false);
      expect(existsSync(pidFile)).toBe(false);
    } finally {
      worker.kill();
    }
  });

  test("leaves a recycled pid alone when the cmdline does not match", async () => {
    const dir = tmp();
    const worker = spawnFakeWorker(dir);
    const pidFile = join(dir, "worker.pid");
    writeWorkerPidFile(pidFile, worker.pid);
    try {
      await reapStaleWorker(pidFile, "some-other-marker", noopLogger);
      // Not our process by cmdline: alive, but the stale file is cleared.
      expect(isProcessAlive(worker.pid)).toBe(true);
      expect(existsSync(pidFile)).toBe(false);
    } finally {
      worker.kill();
    }
  });

  test("clears a pid file pointing at a dead process", async () => {
    const dir = tmp();
    const worker = spawnFakeWorker(dir);
    worker.kill();
    await new Promise((r) => setTimeout(r, 100));
    const pidFile = join(dir, "worker.pid");
    writeWorkerPidFile(pidFile, worker.pid);
    await reapStaleWorker(pidFile, "vellum/worker", noopLogger);
    expect(existsSync(pidFile)).toBe(false);
  });

  test("tolerates a missing or malformed pid file", async () => {
    const dir = tmp();
    await reapStaleWorker(join(dir, "missing.pid"), "vellum/worker", noopLogger);
    const bad = join(dir, "bad.pid");
    writeFileSync(bad, "not-a-pid", "utf-8");
    await reapStaleWorker(bad, "vellum/worker", noopLogger);
    expect(existsSync(bad)).toBe(false);
    removeWorkerPidFile(null);
  });
});
