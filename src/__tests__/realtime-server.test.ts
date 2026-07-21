/**
 * Tests for the realtime server subprocess lifecycle.
 *
 * Verifies that:
 *   - startRealtimeServer spawns a subprocess that listens on the configured port
 *   - isRealtimeServerRunning reflects the true state
 *   - realtimeServerAddress reports the bound address
 *   - stopRealtimeServer cleanly shuts down the subprocess
 *   - a second start while running is a no-op
 *   - stop when not running is safe
 */

import { afterEach, describe, expect, test } from "bun:test";

import type { MeetingBotConfig } from "../config.ts";
import {
  isRealtimeServerRunning,
  realtimeServerAddress,
  startRealtimeServer,
  stopRealtimeServer,
} from "../realtime-server.ts";

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function makeConfig(overrides: Partial<MeetingBotConfig> = {}): MeetingBotConfig {
  return {
    region: "us-east-1",
    publicWsUrl: "ws://localhost:0",
    listenHost: "127.0.0.1",
    listenPort: 0, // ephemeral port
    events: ["transcript.data"],
    ...overrides,
  } as MeetingBotConfig;
}

// Use a fixed high port unlikely to collide.
const TEST_PORT = 18790;

async function makeRunningServer(port = TEST_PORT): Promise<void> {
  await startRealtimeServer(
    makeConfig({ listenPort: port }),
    noopLogger,
  );
}

describe("realtime-server subprocess", () => {
  afterEach(async () => {
    await stopRealtimeServer();
  });

  test("starts and reports running state", async () => {
    expect(isRealtimeServerRunning()).toBe(false);
    await makeRunningServer();
    expect(isRealtimeServerRunning()).toBe(true);
  });

  test("reports the bound address after start", async () => {
    expect(realtimeServerAddress()).toBeNull();
    await makeRunningServer();
    expect(realtimeServerAddress()).toMatch(/127\.0\.0\.1:\d+/);
  });

  test("stop clears the running state", async () => {
    await makeRunningServer();
    expect(isRealtimeServerRunning()).toBe(true);
    await stopRealtimeServer();
    expect(isRealtimeServerRunning()).toBe(false);
    expect(realtimeServerAddress()).toBeNull();
  });

  test("double start is a no-op", async () => {
    await makeRunningServer();
    const addr1 = realtimeServerAddress();
    await startRealtimeServer(makeConfig({ listenPort: TEST_PORT }), noopLogger);
    const addr2 = realtimeServerAddress();
    expect(addr2).toBe(addr1);
  });

  test("stop when not running is safe", async () => {
    expect(isRealtimeServerRunning()).toBe(false);
    await stopRealtimeServer();
    expect(isRealtimeServerRunning()).toBe(false);
  });

  test("port 0 binds to an ephemeral port", async () => {
    await makeRunningServer(0);
    const addr = realtimeServerAddress();
    expect(addr).toMatch(/127\.0\.0\.1:\d+/);
    // The ephemeral port should not be the TEST_PORT
    const port = parseInt(addr!.split(":")[1]!, 10);
    expect(port).toBeGreaterThan(0);
    expect(port).not.toBe(TEST_PORT);
  });
});
