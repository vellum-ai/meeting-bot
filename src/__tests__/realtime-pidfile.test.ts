/**
 * Tests for the realtime server PID-file lifecycle, which lets a reloaded
 * plugin reap a subprocess a previous load left bound to the port (Issue 5:
 * "port 8790 in use" on reload).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MeetingBotConfig } from "../config.ts";
import {
  isRealtimeServerRunning,
  startRealtimeServer,
  stopRealtimeServer,
} from "../realtime-server.ts";

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function makeConfig(port: number): MeetingBotConfig {
  return {
    region: "us-east-1",
    publicWsUrl: "ws://localhost:0",
    listenPort: port,
  } as MeetingBotConfig;
}

const PID_FILE_NAME = "realtime-server.pid";

describe("realtime server pid file", () => {
  afterEach(async () => {
    await stopRealtimeServer();
  });

  test("writes the subprocess pid on start and removes it on stop", async () => {
    const dir = mkdtempSync(join(tmpdir(), "meeting-bot-pid-"));
    const pidFile = join(dir, PID_FILE_NAME);

    await startRealtimeServer(makeConfig(0), noopLogger, { pidFileDir: dir });
    expect(isRealtimeServerRunning()).toBe(true);
    expect(existsSync(pidFile)).toBe(true);

    const pid = Number.parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
    expect(Number.isInteger(pid)).toBe(true);
    expect(pid).toBeGreaterThan(0);

    await stopRealtimeServer();
    expect(existsSync(pidFile)).toBe(false);
  });

  test("cleans up a stale pid file for a dead process and still starts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "meeting-bot-pid-"));
    const pidFile = join(dir, PID_FILE_NAME);
    // A PID that is (almost certainly) not alive; reaping should just clear it.
    writeFileSync(pidFile, "2147483646", "utf-8");

    await startRealtimeServer(makeConfig(0), noopLogger, { pidFileDir: dir });
    expect(isRealtimeServerRunning()).toBe(true);

    // The stale entry was replaced with the live subprocess's pid.
    const pid = Number.parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
    expect(pid).not.toBe(2147483646);
  });
});
